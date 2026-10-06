import { beforeEach, describe, expect, it } from 'vitest'
import { base58Decode, base58Encode } from '@/lib/encoding'
import { createExportKeyPair, exportKeyFingerprint, openExport, type SealedExport } from '@/lib/exportCrypto'
import { telegramApprovalDigest } from '@/lib/telegramApproval'
import type { AccessKeyPermission } from '@/services/near/nep413'
import type { HeldExport, TradingSigner } from '../custody/signer'
import type { Database } from '../db/database'
import { SqliteDatabase } from '../db/sqlite'
import type { SignerChain } from './chain'
import { EXPORT_COLLECT_MS, EXPORT_HOLD_MS, type ChallengeView } from './core'
import { ChallengeError, SignerPausedError } from './errors'
import type { SignerStore } from './store'
import { ownerKeypair, ownerSign, telegramSigner, testSigner } from './testing'

/**
 * AUTH-05: an export the owner signed is held, never released at once. A phishing site that
 * relays NEARKITS' real request gets a valid owner signature for its own browser key, so the
 * signature alone must not release anything: the signer holds the export for 24 hours, the
 * wallet's Telegram account hears of it at once (the app's part) and can release it sooner in
 * the Mini App (Telegram signs that, the signer checks it) or cancel it. Every fact is bound:
 * the wallet, its Telegram account, its owner, the network, the request, its times, once.
 */

const OWNER = 'alice.testnet'
const ALICE_TG = 4242
const MALLORY_TG = 6666
const BOT = 7_000_000_001
const H = 60 * 60_000

let now: number
let db: Database
let signer: TradingSigner
let vault: SignerStore
let core: Awaited<ReturnType<typeof testSigner>>['core']
let owner: Awaited<ReturnType<typeof ownerKeypair>>
let tg: Awaited<ReturnType<typeof telegramSigner>>
let perms: Map<string, AccessKeyPermission>
let wallet: { accountId: string; publicKey: string }

function fakeChain(): SignerChain {
  return {
    permission: async (a, k) => perms.get(`${a}|${k}`) ?? 'missing',
    accountExists: async () => true,
    fullAccessKeys: async () => [],
    tokenBalance: async () => 0n,
  }
}

beforeEach(async () => {
  now = 1_790_000_000_000
  db = await SqliteDatabase.open(null)
  owner = await ownerKeypair()
  tg = await telegramSigner(BOT)
  perms = new Map([[`${OWNER}|${owner.publicKey}`, 'full']])
  const s = await testSigner(db, { now: () => now, chain: fakeChain(), config: { telegram: tg.check, recipient: 'nearkits.com' } })
  signer = s.signer
  vault = s.store
  core = s.core
  wallet = await signer.createKey({ userId: ALICE_TG, owner: { accountId: OWNER, publicKey: owner.publicKey } })
})

const problem = (p: Promise<unknown>) => p.then(() => 'ok').catch((e: unknown) => (e instanceof ChallengeError ? e.problem : e instanceof Error ? e.name : String(e)))

/** The owner's browser asks, the owner wallet signs: what NEARKITS web does. */
async function request(o: { accountId?: string; key?: typeof owner } = {}) {
  const browser = await createExportKeyPair()
  const c = await signer.challenge({ kind: 'export', accountId: o.accountId ?? wallet.accountId, recipientKey: browser.publicKey })
  const held = await signer.requestExport({ challengeId: c.id, publicKey: (o.key ?? owner).publicKey, signature: await ownerSign(c, (o.key ?? owner).pair) })
  return { browser, c, held }
}

/** Someone opens the Mini App from the chat's "Release it now" link and taps Release: Telegram signs the launch for that user. */
const launch = (held: Pick<HeldExport, 'digest'>, userId = ALICE_TG, at = now) => tg.launch({ userId, startParam: held.digest, authDate: Math.floor(at / 1000) })
const confirm = async (held: Pick<HeldExport, 'digest'>, userId = ALICE_TG, at = now) => signer.telegramApprove(await launch(held, userId, at))

const opened = (browser: { privateKey: CryptoKey }, exportId: string, sealed: SealedExport, accountId = wallet.accountId) =>
  openExport(browser.privateKey, sealed, { challengeId: exportId, network: 'testnet', accountId })
const publicOf = (secret: string) => `ed25519:${base58Encode((base58Decode(secret.slice('ed25519:'.length)) as Uint8Array).subarray(32))}`
const events = async (accountId = wallet.accountId) => (await vault.events('testnet', accountId)).map((e) => e.kind)

describe('a key export is held: the owner’s signature alone releases nothing', () => {
  it('the request names the hold the owner signs for, and holds the export for 24 hours', async () => {
    const browser = await createExportKeyPair()
    const c: ChallengeView = await signer.challenge({ kind: 'export', accountId: wallet.accountId, recipientKey: browser.publicKey })
    const heldUntil = c.expiresAt + EXPORT_HOLD_MS
    expect(c.message.split('\n')).toEqual([
      'NearKit: export the private key of my NearKit wallet',
      `NearKit wallet: ${wallet.accountId}`,
      `Browser key: ${await exportKeyFingerprint(browser.publicKey)}`,
      `Owner wallet: ${OWNER}`,
      'Network: testnet',
      `Request: ${c.id}`,
      `Expires: ${new Date(c.expiresAt).toISOString()}`,
      `Held until: ${new Date(heldUntil).toISOString()}`,
      `Collect by: ${new Date(heldUntil + EXPORT_COLLECT_MS).toISOString()}`,
      '',
      expect.stringContaining('tells your Telegram account'),
    ])
    expect(EXPORT_HOLD_MS).toBe(24 * H)
    const held = await signer.requestExport({ challengeId: c.id, publicKey: owner.publicKey, signature: await ownerSign(c, owner.pair) })
    expect(held).toMatchObject({
      exportId: c.id,
      accountId: wallet.accountId,
      ownerAccount: OWNER,
      browserKey: await exportKeyFingerprint(browser.publicKey),
      status: 'held',
      releaseAt: heldUntil,
      expiresAt: heldUntil + EXPORT_COLLECT_MS,
      confirmedAt: null,
      userId: ALICE_TG,
    })
    // At least 24 hours from the signature, whenever within the request's 5 minutes it came.
    expect(held.releaseAt - now).toBeGreaterThanOrEqual(24 * H)
    expect(await problem(signer.collectExport(held.exportId))).toBe('held')
    now = held.releaseAt - 1
    expect(await problem(signer.collectExport(held.exportId))).toBe('held')
    expect((await signer.exportStatus({ exportId: held.exportId }))?.status).toBe('held')
    // Once the hold is over the browser that asked collects it, sealed to its own key.
    now = held.releaseAt
    expect((await signer.exportStatus({ exportId: held.exportId }))?.status).toBe('ready')
    const out = await signer.collectExport(held.exportId)
    expect(out.released).toBe('hold')
    expect(publicOf(await opened(browser, held.exportId, out.sealed))).toBe(wallet.publicKey)
    expect((await signer.exportStatus({ exportId: held.exportId }))?.status).toBe('collected')
    expect(await events()).toEqual(expect.arrayContaining(['export-requested', 'key-exported']))
  })

  it('normal confirmed export: the wallet’s Telegram account releases it at once, and only that browser can open it', async () => {
    const { browser, held } = await request()
    expect(await problem(signer.collectExport(held.exportId))).toBe('held')
    expect(await confirm(held)).toEqual({ kind: 'export', accountId: wallet.accountId, target: held.browserKey })
    const status = await signer.exportStatus({ exportId: held.exportId })
    expect(status).toMatchObject({ status: 'ready', confirmedAt: now })
    const out = await signer.collectExport(held.exportId)
    expect(out).toMatchObject({ accountId: wallet.accountId, publicKey: wallet.publicKey, released: 'telegram' })
    expect(publicOf(await opened(browser, held.exportId, out.sealed))).toBe(wallet.publicKey)
    const other = await createExportKeyPair()
    await expect(opened(other, held.exportId, out.sealed)).rejects.toThrow()
    const log = await vault.events('testnet', wallet.accountId)
    expect(log.map((e) => e.kind)).toEqual(expect.arrayContaining(['export-requested', 'export-confirmed', 'key-exported']))
    expect(log.find((e) => e.kind === 'key-exported')?.detail).toMatchObject({ released: 'telegram', challenge: held.exportId })
    // Nothing the signer logged holds the key.
    expect(JSON.stringify(log)).not.toContain((await opened(browser, held.exportId, out.sealed)).slice(8))
  })

  it('the Mini App reads the exact request it releases: the digest it was opened with is the request’s', async () => {
    const { held } = await request()
    const view = await signer.telegramRequestView(held.digest)
    expect(view.status).toBe('open')
    expect(view.request).toMatchObject({ kind: 'export', accountId: wallet.accountId, target: held.browserKey, network: 'testnet', expiresAt: held.expiresAt })
    expect(await telegramApprovalDigest(view.request as NonNullable<typeof view.request>)).toBe(held.digest)
    expect(view.export).toEqual({ ownerAccount: OWNER, releaseAt: held.releaseAt, requestedAt: now })
    await confirm(held)
    expect((await signer.telegramRequestView(held.digest)).status).toBe('used')
  })

  it('a wallet with no Telegram account on record can’t start an export: nobody could confirm or cancel it', async () => {
    const orphan = await signer.createKey({ userId: 0, owner: { accountId: OWNER, publicKey: owner.publicKey } })
    const browser = await createExportKeyPair()
    expect(await problem(signer.challenge({ kind: 'export', accountId: orphan.accountId, recipientKey: browser.publicKey }))).toBe('wallet')
  })
})

describe('bound to the wallet’s Telegram account', () => {
  it('wrong Telegram user: another account can neither release nor cancel it', async () => {
    const { held } = await request()
    expect(await problem(confirm(held, MALLORY_TG))).toBe('not-controller')
    expect(await problem(signer.collectExport(held.exportId))).toBe('held')
    expect(await problem(signer.cancelExport({ exportId: held.exportId, by: 'telegram', userId: MALLORY_TG }))).toBe('not-controller')
    expect((await signer.exportStatus({ exportId: held.exportId }))?.status).toBe('held')
    expect(await events()).toContain('tg-approval-refused')
    // The wallet's own account still can.
    await confirm(held)
    expect((await signer.exportStatus({ exportId: held.exportId }))?.status).toBe('ready')
  })

  it('a launch for another bot, or one Telegram didn’t sign, releases nothing', async () => {
    const { held } = await request()
    const otherBot = await telegramSigner(BOT + 1)
    expect(await problem(signer.telegramApprove(await otherBot.launch({ userId: ALICE_TG, startParam: held.digest, authDate: Math.floor(now / 1000) })))).toBe('bad-signature')
    const forged = new URLSearchParams(await launch(held))
    forged.set('auth_date', String(Math.floor(now / 1000) + 1))
    expect(await problem(signer.telegramApprove(forged.toString()))).toBe('bad-signature')
    expect((await signer.exportStatus({ exportId: held.exportId }))?.status).toBe('held')
  })
})

describe('bound to the exact wallet, owner, network and request', () => {
  it('wrong wallet: releasing one wallet’s export releases no other, and a request moved to another wallet opens nothing', async () => {
    const second = await signer.createKey({ userId: ALICE_TG, owner: { accountId: OWNER, publicKey: owner.publicKey } })
    const a = await request()
    const b = await request({ accountId: second.accountId })
    await confirm(a.held)
    expect((await signer.exportStatus({ exportId: a.held.exportId }))?.status).toBe('ready')
    expect((await signer.exportStatus({ exportId: b.held.exportId }))?.status).toBe('held')
    expect(await problem(signer.collectExport(b.held.exportId))).toBe('held')
    // A's export edited (in the signer's database) to name B: the owner signed for A, so nothing is released.
    await signer.cancelExport({ exportId: b.held.exportId, by: 'web' })
    await db.run('UPDATE signer_exports SET account_id = ? WHERE id = ?', [second.accountId, a.held.exportId])
    expect(await problem(signer.collectExport(a.held.exportId))).toBe('unknown')
    expect(await events(second.accountId)).toContain('export-refused')
  })

  it('the owner’s key must still be a full-access key of the owner when the key is released', async () => {
    const { held } = await request()
    await confirm(held)
    perms.delete(`${OWNER}|${owner.publicKey}`)
    expect(await problem(signer.collectExport(held.exportId))).toBe('not-owner')
    perms.set(`${OWNER}|${owner.publicKey}`, 'full')
    expect(await problem(signer.collectExport(held.exportId))).toBe('ok')
  })

  it('one export at a time per wallet: another waits until this one is cancelled, collected or expired', async () => {
    const { held } = await request()
    const browser = await createExportKeyPair()
    expect(await problem(signer.challenge({ kind: 'export', accountId: wallet.accountId, recipientKey: browser.publicKey }))).toBe('pending')
    await signer.cancelExport({ exportId: held.exportId, by: 'telegram', userId: ALICE_TG })
    expect(await problem(request())).toBe('ok')
  })

  it('an app that doesn’t know exports are held gets nothing, and the signed request isn’t used up', async () => {
    const browser = await createExportKeyPair()
    const c = await signer.challenge({ kind: 'export', accountId: wallet.accountId, recipientKey: browser.publicKey })
    // An older app relaying the signature without the two-step protocol: refused before the request is used.
    expect(await problem(core.handle('export', { challengeId: c.id, publicKey: owner.publicKey, signature: await ownerSign(c, owner.pair) }))).toBe('BadRequestError')
    expect(await problem(signer.requestExport({ challengeId: c.id, publicKey: owner.publicKey, signature: await ownerSign(c, owner.pair) }))).toBe('ok')
  })
})

describe('once, and in time', () => {
  it('replay: the signed request, the Telegram release and the collection each count once', async () => {
    const { c, held } = await request()
    expect(await problem(signer.requestExport({ challengeId: c.id, publicKey: owner.publicKey, signature: await ownerSign(c, owner.pair) }))).toBe('used')
    const data = await launch(held)
    await signer.telegramApprove(data)
    expect(await problem(signer.telegramApprove(data))).toBe('used')
    expect(await problem(signer.collectExport(held.exportId))).toBe('ok')
    expect(await problem(signer.collectExport(held.exportId))).toBe('used')
    expect((await vault.events('testnet', wallet.accountId)).filter((e) => e.kind === 'key-exported')).toHaveLength(1)
  })

  it('duplicate confirmation: a second release, even a fresh one, is refused', async () => {
    const { held } = await request()
    await confirm(held)
    now += 60_000
    expect(await problem(confirm(held))).toBe('used')
    expect((await vault.events('testnet', wallet.accountId)).filter((e) => e.kind === 'export-confirmed')).toHaveLength(1)
  })

  it('a Telegram launch opened before the export was requested releases nothing', async () => {
    const { held } = await request()
    expect(await problem(confirm(held, ALICE_TG, now - 10 * 60_000))).toBe('stale')
    expect((await signer.exportStatus({ exportId: held.exportId }))?.status).toBe('held')
  })

  it('expiry: an export not collected in time is gone, released or not, and frees the wallet for a new one', async () => {
    const first = await request()
    now = first.held.expiresAt + 1
    expect(await problem(signer.collectExport(first.held.exportId))).toBe('expired')
    expect(await problem(confirm(first.held))).toBe('expired')
    expect((await signer.exportStatus({ exportId: first.held.exportId }))?.status).toBe('expired')
    const second = await request()
    await confirm(second.held)
    now = second.held.expiresAt + 1
    expect(await problem(signer.collectExport(second.held.exportId))).toBe('expired')
    expect(await problem(request())).toBe('ok')
  })
})

describe('cancelled is final', () => {
  it('cancellation: nothing is released, not even after the hold; cancelling again changes nothing', async () => {
    const { held } = await request()
    const out = await signer.cancelExport({ exportId: held.exportId, by: 'telegram', userId: ALICE_TG })
    expect(out).toMatchObject({ status: 'cancelled', cancelledBy: 'telegram', cancelledAt: now })
    expect(await problem(signer.collectExport(held.exportId))).toBe('cancelled')
    now = held.releaseAt + 1
    expect(await problem(signer.collectExport(held.exportId))).toBe('cancelled')
    expect((await signer.cancelExport({ exportId: held.exportId, by: 'web' })).status).toBe('cancelled')
    expect(await events()).toContain('export-cancelled')
    expect((await signer.telegramRequestView(held.digest)).status).toBe('cancelled')
  })

  it('confirmation after cancellation is refused', async () => {
    const { held } = await request()
    await signer.cancelExport({ exportId: held.exportId, by: 'web' })
    expect(await problem(confirm(held))).toBe('cancelled')
    expect(await problem(signer.collectExport(held.exportId))).toBe('cancelled')
  })

  it('a released export can still be cancelled until it is collected; after that, cancelling says so', async () => {
    const a = await request()
    await confirm(a.held)
    await signer.cancelExport({ exportId: a.held.exportId, by: 'telegram', userId: ALICE_TG })
    expect(await problem(signer.collectExport(a.held.exportId))).toBe('cancelled')
    const b = await request()
    await confirm(b.held)
    await signer.collectExport(b.held.exportId)
    expect(await problem(signer.cancelExport({ exportId: b.held.exportId, by: 'telegram', userId: ALICE_TG }))).toBe('used')
  })

  it('a paused signer releases nothing, but a cancellation still goes through', async () => {
    const { held } = await request()
    await confirm(held)
    await core.setPaused(true, 'incident')
    await expect(signer.collectExport(held.exportId)).rejects.toBeInstanceOf(SignerPausedError)
    expect((await signer.cancelExport({ exportId: held.exportId, by: 'telegram', userId: ALICE_TG })).status).toBe('cancelled')
  })
})

describe('phishing: a site that relays NEARKITS’ request gets nothing it can use', () => {
  it('a signature for another site (another NEP-413 recipient) is refused, and nothing is held', async () => {
    const browser = await createExportKeyPair()
    const c = await signer.challenge({ kind: 'export', accountId: wallet.accountId, recipientKey: browser.publicKey })
    const elsewhere = await ownerSign({ ...c, recipient: 'nearkits-login.example' }, owner.pair)
    expect(await problem(signer.requestExport({ challengeId: c.id, publicKey: owner.publicKey, signature: elsewhere }))).toBe('bad-signature')
    expect(await signer.exportStatus({ accountId: wallet.accountId })).toBeNull()
  })

  it('a relayed genuine signature for the phisher’s browser key: held, no early release for the phisher, and the owner’s cancel ends it', async () => {
    // The phisher made the request with its own browser key and relayed NEARKITS' message to the owner, who signed it.
    const { browser: phisher, held } = await request()
    expect(held.status).toBe('held')
    expect(await problem(signer.collectExport(held.exportId))).toBe('held')
    // Its own Telegram account can't release it; neither can it cancel the owner's notice away.
    expect(await problem(confirm(held, MALLORY_TG))).toBe('not-controller')
    // The owner, told in Telegram, cancels. Nothing is released, ever.
    await signer.cancelExport({ exportId: held.exportId, by: 'telegram', userId: ALICE_TG })
    now = held.releaseAt + 60_000
    expect(await problem(signer.collectExport(held.exportId))).toBe('cancelled')
    expect(phisher.privateKey).toBeTruthy()
    expect(await events()).not.toContain('key-exported')
  })

  it('the hold can’t be skipped by editing the signer’s database', async () => {
    const second = await signer.createKey({ userId: ALICE_TG, owner: { accountId: OWNER, publicKey: owner.publicKey } })
    const { held } = await request()
    // The release time moved: the owner signed another one.
    await db.run('UPDATE signer_exports SET release_at = ? WHERE id = ?', [now, held.exportId])
    expect(await problem(signer.collectExport(held.exportId))).toBe('unknown')
    await db.run('UPDATE signer_exports SET release_at = ? WHERE id = ?', [held.releaseAt, held.exportId])
    // Marked released with no launch Telegram signed: still held.
    await db.run("UPDATE signer_exports SET state = 'confirmed', confirmed_at = ? WHERE id = ?", [now, held.exportId])
    expect(await problem(signer.collectExport(held.exportId))).toBe('held')
    // Telegram's genuine release of another export (another wallet's), copied in: it names another request.
    const other = await request({ accountId: second.accountId })
    await confirm(other.held)
    const copied = await db.get<{ confirm_init_data: string }>('SELECT confirm_init_data FROM signer_exports WHERE id = ?', [other.held.exportId])
    await db.run('UPDATE signer_exports SET confirm_init_data = ? WHERE id = ?', [copied?.confirm_init_data ?? null, held.exportId])
    expect(await problem(signer.collectExport(held.exportId))).toBe('held')
    // A cancelled export brought back by an edit: the owner's signature went with the cancel.
    await signer.cancelExport({ exportId: held.exportId, by: 'web' })
    await db.run("UPDATE signer_exports SET state = 'held', cancelled_at = NULL WHERE id = ?", [held.exportId])
    now = held.releaseAt
    expect(await problem(signer.collectExport(held.exportId))).toBe('unknown')
  })
})
