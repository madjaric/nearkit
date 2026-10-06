import { describe, expect, it } from 'vitest'
import { base58Decode, base58Encode, base64Encode } from '@/lib/encoding'
import { createRpcClient } from '@/services/near/rpc'
import { serializeSignedTransaction, serializeTransaction, transactionDigest } from '@/services/near/transaction'
import { createExportKeyPair, openExport, type SealedExport } from '@/lib/exportCrypto'
import { challengeProblem } from '@/services/recovery'
import { RecoveryApiError } from '../custody/recovery'
import type { ChallengeView } from '../signer/core'
import { ownerSign } from '../signer/testing'
import type { TgUser } from '../telegram/types'
import { ALICE } from './testing'
import { LINKED, ONE, walletBot } from './walletTesting'

type Harness = Awaited<ReturnType<typeof walletBot>>
const MALLORY = 'mallory.testnet'
const MALLORY_TG: TgUser = { id: 666, is_bot: false, first_name: 'Mallory', username: 'mallory' }

async function keypair() {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  return { pair, publicKey: `ed25519:${base58Encode(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))}` }
}

async function setup() {
  const linked = await keypair()
  const app = await keypair()
  const h = await walletBot({ linkedKey: linked.publicKey, extraKeys: { [app.publicKey]: 'function-call' } })
  return { h, linked, app }
}

async function addBackup(h: Harness) {
  await h.press('cr:show')
  await h.press(h.button('Add backup key'))
  await h.press(h.button('Add backup key'))
}

/** Telegram's Export button: a link to the web recovery page for this wallet. It holds no secret. */
async function exportLink(h: Harness) {
  await h.press('cr:export')
  const url = h.buttons().find((b) => b.url)?.url ?? ''
  expect(url).toMatch(/^https:\/\/nearkits\.com\/recover#wallet=[0-9a-f]{64}$/)
  return url.split('#wallet=')[1] as string
}

type Routes = ReturnType<Harness['recoveryApi']>
const call = async <T>(routes: Routes, path: string, body: unknown): Promise<T> => (await (routes[path] as NonNullable<Routes[string]>)(body, {} as never)) as T

/** A held export as the browser sees it. */
interface WebExport {
  exportId: string
  accountId: string
  ownerAccount: string
  browserKey: string
  status: string
  releaseAt: number
  expiresAt: number
}

function webApi(h: Harness, notices: unknown[] = []) {
  const routes = h.recoveryApi(notices)
  return {
    routes,
    challenge: (body: Record<string, unknown>) => call<ChallengeView>(routes, '/api/recovery/challenge', body),
    requestExport: (body: Record<string, unknown>) => call<WebExport>(routes, '/api/recovery/export', body),
    status: (exportId: string) => call<WebExport>(routes, '/api/recovery/export/status', { exportId }),
    collect: (exportId: string) =>
      call<{ exportId: string; accountId: string; publicKey: string; sealed: SealedExport; released: 'hold' | 'telegram' }>(routes, '/api/recovery/export/collect', { exportId }),
    cancel: (exportId: string) => call<WebExport>(routes, '/api/recovery/export/cancel', { exportId }),
    wallets: (body: Record<string, unknown>) => call<{ ownerAccount: string; wallets: { accountId: string; name: string }[] }>(routes, '/api/recovery/wallets', body),
  }
}

const status = (p: Promise<unknown>) => p.then(() => null).catch((e: unknown) => (e instanceof RecoveryApiError ? e.status : e))

/** Someone holding Alice's Telegram session links a wallet of their own and makes it the default. */
async function intruder(h: Harness) {
  const k = await keypair()
  h.chain.accounts.set(MALLORY, { amount: ONE, keys: { [k.publicKey]: 'full' } })
  await h.store.createLinkRequest({ codeHash: 'mallory', userId: ALICE.id, network: 'testnet', nonce: 'n', message: 'm', ttlMs: 60_000 })
  await h.store.completeLink({ codeHash: 'mallory', network: 'testnet', accountId: MALLORY, userId: ALICE.id, publicKey: k.publicKey })
  await h.store.updateSettings(ALICE.id, { defaultAccount: MALLORY })
  return k
}

describe('backup key: yours even without NEARKITS', () => {
  it('adds your linked wallet’s key to the NEARKITS wallet, on chain', async () => {
    const { h, linked } = await setup()
    const w = await h.funded(2n * ONE)
    await h.press('cr:show')
    expect(h.last()?.text).toContain('Backup key</b> · not added yet')
    await h.press(h.button('Add backup key'))
    expect(h.last()?.text).toContain(`Your owner wallet <code>${LINKED}</code> gets a full-access key`)
    expect(h.last()?.text).toContain(linked.publicKey)
    await h.press(h.button('Add backup key'))
    expect(h.last()?.text).toContain('Backup key added')
    expect(h.chain.keysOf(w.accountId).sort()).toEqual([w.publicKey, linked.publicKey].sort())
    expect((await h.wallet())?.backupKey).toBe(linked.publicKey)
    await h.press('cw:home')
    expect(h.last()?.text).toContain('Backup key: your own wallet can control this one ✓')
  })

  it('with the backup key, your own wallet moves the funds by itself: no NEARKITS involved', async () => {
    const { h, linked } = await setup()
    const w = await h.funded(2n * ONE)
    await addBackup(h)
    const rpc = createRpcClient({ urls: ['https://rpc.test'], fetch: h.chain.fetch })
    const key = await rpc.call<{ nonce: number }>('query', { request_type: 'view_access_key', finality: 'final', account_id: w.accountId, public_key: linked.publicKey })
    const block = await rpc.call<{ header: { hash: string } }>('block', { finality: 'final' })
    const tx = {
      signerId: w.accountId,
      publicKey: linked.publicKey,
      nonce: BigInt(key.nonce) + 1n,
      receiverId: 'bob.testnet',
      blockHash: base58Decode(block.header.hash) as Uint8Array,
      actions: [{ type: 'Transfer' as const, deposit: ONE }],
    }
    const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, linked.pair.privateKey, await transactionDigest(serializeTransaction(tx))))
    const before = h.chain.accounts.get('bob.testnet')?.amount ?? 0n
    await rpc.call('send_tx', { signed_tx_base64: base64Encode(serializeSignedTransaction(tx, signature)), wait_until: 'FINAL' })
    expect((h.chain.accounts.get('bob.testnet')?.amount ?? 0n) - before).toBe(ONE)
  })
})

describe('export: in the web app, after the owner wallet signs', () => {
  it('names the recovery page on the web address NEARKITS is configured with, never a fixed one', async () => {
    const { h } = await setup()
    await h.funded(ONE)
    await h.press('cr:export')
    expect(h.last()?.text).toContain('the same page works without Telegram: nearkits.com/recover')
    const linked = await keypair()
    const moved = await walletBot({ linkedKey: linked.publicKey, env: { NEARKIT_WEB_URL: 'https://web.example' } })
    await moved.funded(ONE)
    await moved.press('cr:export')
    expect(moved.last()?.text).toContain('the same page works without Telegram: web.example/recover')
    expect(moved.last()?.text).not.toContain('vercel.app')
    expect(moved.buttons().find((b) => b.url)?.url).toMatch(/^https:\/\/web\.example\/recover#wallet=[0-9a-f]{64}$/)
  })

  it('the Export screen says every export is held and announced here', async () => {
    const { h } = await setup()
    await h.funded(ONE)
    await h.press('cr:export')
    expect(h.last()?.text).toContain('NEARKITS holds the export for 24 hours and tells you here at once')
  })

  it('refuses another account’s key, a bad signature, a function-call key, an expired request and a guessing streak', async () => {
    const { h, linked, app } = await setup()
    const w = await h.funded(ONE)
    const api = webApi(h)
    const browser = await createExportKeyPair()
    const fresh = () => api.challenge({ kind: 'export', accountId: w.accountId, recipientKey: browser.publicKey })
    const stranger = await keypair()
    h.chain.accounts.set('stranger.testnet', { amount: ONE, keys: { [stranger.publicKey]: 'full' } })
    let c = await fresh()
    expect(await status(api.requestExport({ challengeId: c.id, publicKey: stranger.publicKey, signature: await ownerSign(c, stranger.pair) }))).toBe(403)
    expect(await status(api.requestExport({ challengeId: c.id, publicKey: linked.publicKey, signature: await ownerSign({ ...c, message: 'other' }, linked.pair) }))).toBe(403)
    // A function-call key of the owner can't export.
    expect(await status(api.requestExport({ challengeId: c.id, publicKey: app.publicKey, signature: await ownerSign(c, app.pair) }))).toBe(403)
    c = await fresh()
    h.advance(5 * 60_000 + 1)
    expect(await status(api.requestExport({ challengeId: c.id, publicKey: linked.publicKey, signature: await ownerSign(c, linked.pair) }))).toBe(410)
    c = await fresh()
    for (let i = 0; i < 5; i++) await status(api.requestExport({ challengeId: c.id, publicKey: stranger.publicKey, signature: await ownerSign(c, stranger.pair) }))
    // Locked: even the owner's own signature is refused now; a new request works.
    expect(await status(api.requestExport({ challengeId: c.id, publicKey: linked.publicKey, signature: await ownerSign(c, linked.pair) }))).toBe(403)
    c = await fresh()
    expect(await status(api.requestExport({ challengeId: c.id, publicKey: linked.publicKey, signature: await ownerSign(c, linked.pair) }))).toBeNull()
  })

  it('a stolen link, a known Telegram ID or wallet address, or an intercepted signature exports nothing readable', async () => {
    const { h, linked } = await setup()
    const w = await h.funded(ONE)
    const api = webApi(h)
    // The link is just the wallet's (public) address: an attacker with it and their own browser and wallet gets nowhere.
    const mallory = await keypair()
    h.chain.accounts.set(MALLORY, { amount: ONE, keys: { [mallory.publicKey]: 'full' } })
    const theirs = await createExportKeyPair()
    const c1 = await api.challenge({ kind: 'export', accountId: w.accountId, recipientKey: theirs.publicKey })
    expect(c1.message).toContain(`Owner wallet: ${LINKED}`)
    expect(await status(api.requestExport({ challengeId: c1.id, publicKey: mallory.publicKey, signature: await ownerSign(c1, mallory.pair) }))).toBe(403)
    // The owner's signed request, intercepted and sent first: the key is sealed to the OWNER's browser key, so it opens nowhere else.
    const owners = await createExportKeyPair()
    const c2 = await api.challenge({ kind: 'export', accountId: w.accountId, recipientKey: owners.publicKey })
    const held = await api.requestExport({ challengeId: c2.id, publicKey: linked.publicKey, signature: await ownerSign(c2, linked.pair) })
    h.advance(held.releaseAt - h.deps.now())
    const stolen = await api.collect(held.exportId)
    await expect(openExport(theirs.privateKey, stolen.sealed, { challengeId: c2.id, network: 'testnet', accountId: w.accountId })).rejects.toThrow()
    // Swapping the browser key after the owner signed is not possible: the request keeps the key it was made with.
    expect(await status(api.requestExport({ challengeId: c2.id, publicKey: linked.publicKey, signature: await ownerSign(c2, linked.pair) }))).toBe(409)
  })
})

describe('export: held, announced in Telegram, released there or after the hold (AUTH-05)', () => {
  /** The owner's browser asks and the owner wallet signs, through NEARKITS web's API. */
  async function requested(o: { notices?: unknown[] } = {}) {
    const { h, linked } = await setup()
    const w = await h.funded(ONE)
    // From Telegram's Export button to the web page for this wallet.
    expect(await exportLink(h)).toBe(w.accountId)
    const api = webApi(h, o.notices)
    const browser = await createExportKeyPair()
    const c = await api.challenge({ kind: 'export', accountId: w.accountId, recipientKey: browser.publicKey })
    const held = await api.requestExport({ challengeId: c.id, publicKey: linked.publicKey, signature: await ownerSign(c, linked.pair) })
    return { h, w, api, browser, c, held, linked }
  }
  const notice = (h: Harness) => [...h.fake.messages()].reverse().find((m) => m.text.includes('Key export requested'))
  const fingerprintOf = (text: string) => /Browser key: ([0-9a-f ]{19})/.exec(text)?.[1]
  const opened = (r: Awaited<ReturnType<typeof requested>>, sealed: SealedExport) =>
    openExport(r.browser.privateKey, sealed, { challengeId: r.c.id, network: 'testnet', accountId: r.w.accountId })

  it('a signed export is held and the wallet’s Telegram account is told at once, with Release it now and Cancel; nothing is released yet', async () => {
    const notices: unknown[] = []
    const r = await requested({ notices })
    expect(r.held).toMatchObject({ exportId: r.c.id, accountId: r.w.accountId, ownerAccount: LINKED, status: 'held', browserKey: fingerprintOf(r.c.message) })
    expect(r.held.releaseAt - r.h.deps.now()).toBeGreaterThanOrEqual(24 * 60 * 60_000)
    // What the browser sees carries neither the Telegram account nor the Mini App's parameter.
    expect(Object.keys(r.held)).not.toContain('digest')
    expect(Object.keys(r.held)).not.toContain('userId')
    const n = notice(r.h)
    expect(n?.chatId).toBe(ALICE.id)
    expect(n?.text).toContain(`Your owner wallet <code>${LINKED}</code> signed a request in NEARKITS web`)
    expect(n?.text).toContain(`<code>${r.held.browserKey}</code>`)
    expect(n?.text).toContain('The key itself never comes to Telegram.')
    const release = n?.buttons.find((b) => b.text.includes('Release it now'))?.url ?? ''
    // The Mini App link names exactly this export: its start parameter is the signer's digest of it.
    expect(release).toBe(`https://t.me/${r.h.deps.me.username}?startapp=${(await r.h.custody.recovery.exportStatus({ exportId: r.held.exportId }))?.digest}`)
    expect(n?.buttons.find((b) => b.text.includes('Cancel export'))?.data).toBe(`cr:xcancel:${r.held.exportId}`)
    expect(notices).toEqual([{ kind: 'export-requested', userId: ALICE.id, accountId: r.w.accountId, owner: LINKED, browserKey: r.held.browserKey }])
    // Held: the browser gets nothing yet.
    expect(await status(r.api.collect(r.held.exportId))).toBe(425)
    expect((await r.api.status(r.held.exportId)).status).toBe('held')
    expect((await r.h.custody.store.auditOf(r.w.id)).map((a) => a.action)).toEqual(expect.arrayContaining(['key-export-requested', 'key-export-notified']))
  })

  it('normal confirmed export: Alice releases it in the Mini App, the browser collects it at once, and Telegram hears of both; the key never reaches Telegram', async () => {
    const notices: unknown[] = []
    const r = await requested({ notices })
    await r.h.approveInTelegram()
    expect(r.h.last()?.text).toContain('You released the key export of your NEARKITS wallet')
    expect((await r.api.status(r.held.exportId)).status).toBe('ready')
    const out = await r.api.collect(r.held.exportId)
    expect(out.released).toBe('telegram')
    const secret = await opened(r, out.sealed)
    const raw = base58Decode(secret.slice('ed25519:'.length)) as Uint8Array
    expect(`ed25519:${base58Encode(raw.subarray(32))}`).toBe(r.w.publicKey)
    expect(r.h.last()?.text).toContain('was exported to the browser with the key')
    expect(notices.at(-1)).toMatchObject({ kind: 'exported', released: 'telegram' })
    // Once only.
    expect(await status(r.api.collect(r.held.exportId))).toBe(409)
    // Nothing in Telegram, the audit log or the API's answers holds the key.
    const audit = await r.h.custody.store.auditOf(r.w.id)
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['key-export-requested', 'key-export-notified', 'key-export-released', 'key-exported']))
    for (const place of [JSON.stringify(r.h.fake.calls), JSON.stringify(audit), JSON.stringify(out)]) expect(place).not.toContain(secret.slice(8))
  })

  it('without Telegram: once the hold is over, the browser that asked collects it', async () => {
    const r = await requested()
    r.h.advance(r.held.releaseAt - r.h.deps.now() - 1)
    expect(await status(r.api.collect(r.held.exportId))).toBe(425)
    r.h.advance(1)
    const out = await r.api.collect(r.held.exportId)
    expect(out.released).toBe('hold')
    expect(await opened(r, out.sealed)).toMatch(/^ed25519:/)
  })

  it('❌ Cancel export in the chat: only the wallet’s own Telegram account can, and then nothing is released, ever', async () => {
    const r = await requested()
    const cancel = `cr:xcancel:${r.held.exportId}`
    // Another Telegram account pressing the same button (a forwarded message, a guessed ID): refused.
    await r.h.say('/start', MALLORY_TG)
    await r.h.press(cancel, MALLORY_TG)
    expect(r.h.last()?.text).toContain('Only the Telegram account of this NEARKITS wallet can cancel its export')
    expect((await r.api.status(r.held.exportId)).status).toBe('held')
    // Alice cancels.
    await r.h.press(cancel)
    expect(r.h.last()?.text).toContain('Export cancelled')
    expect(r.h.last()?.text).toContain('Nothing was released, and nothing will be')
    expect((await r.api.status(r.held.exportId)).status).toBe('cancelled')
    // Not after the hold, and not by a release in the Mini App afterwards.
    r.h.advance(r.held.releaseAt - r.h.deps.now() + 60_000)
    expect(await status(r.api.collect(r.held.exportId))).toBe(410)
    await expect(r.h.approveInTelegram()).rejects.toMatchObject({ code: 'cancelled' })
    expect((await r.h.custody.store.auditOf(r.w.id)).map((a) => a.action)).toContain('key-export-cancelled')
  })

  it('the page that asked can cancel it too, and Telegram hears of it', async () => {
    const r = await requested()
    expect((await r.api.cancel(r.held.exportId)).status).toBe('cancelled')
    expect(r.h.last()?.text).toContain('was cancelled in NEARKITS web. Nothing was released.')
    r.h.advance(r.held.releaseAt - r.h.deps.now())
    expect(await status(r.api.collect(r.held.exportId))).toBe(410)
  })

  it('if the wallet’s Telegram account can’t be told (it blocked the bot), the export is cancelled and nothing is released', async () => {
    const { h, linked } = await setup()
    const w = await h.funded(ONE)
    const api = webApi(h)
    await h.store.markBlocked(ALICE.id)
    const browser = await createExportKeyPair()
    const c = await api.challenge({ kind: 'export', accountId: w.accountId, recipientKey: browser.publicKey })
    const refused = await api.requestExport({ challengeId: c.id, publicKey: linked.publicKey, signature: await ownerSign(c, linked.pair) }).catch((e: unknown) => e)
    expect(refused).toMatchObject({ status: 503, code: 'telegram' })
    expect(await h.custody.recovery.exportStatus({ accountId: w.accountId })).toBeNull()
    expect((await h.custody.recovery.exportStatus({ exportId: c.id }))?.status).toBe('cancelled')
    h.advance(25 * 60 * 60_000)
    // The API releases nothing Telegram wasn't told of, and the signer itself holds it cancelled.
    expect(await status(api.collect(c.id))).toBe(403)
    await expect(h.custody.signer.collectExport(c.id)).rejects.toMatchObject({ problem: 'cancelled' })
  })

  it('nothing is released through the API for an export Telegram wasn’t told of, even once its hold is over', async () => {
    const { h, linked } = await setup()
    const w = await h.funded(ONE)
    const api = webApi(h)
    const browser = await createExportKeyPair()
    const c = await api.challenge({ kind: 'export', accountId: w.accountId, recipientKey: browser.publicKey })
    // The signer held it, but the notice step never happened (a crash between the two, say).
    const { held } = await h.custody.recovery.requestExport({ challengeId: c.id, publicKey: linked.publicKey, signature: await ownerSign(c, linked.pair) })
    h.advance(held.releaseAt - h.deps.now())
    expect(await status(api.collect(held.exportId))).toBe(403)
  })

  it('the Recovery screen shows an open export with Release it now and Cancel', async () => {
    const r = await requested()
    await r.h.press('cr:show')
    expect(r.h.last()?.text).toContain('An export is open')
    expect(r.h.last()?.text).toContain(r.held.browserKey)
    expect(r.h.buttons().find((b) => b.text.includes('Release it now'))?.url).toMatch(/startapp=/)
    await r.h.press(r.h.button('Cancel export'))
    expect(r.h.last()?.text).toContain('Export cancelled')
    await r.h.press('cr:show')
    expect(r.h.last()?.text).not.toContain('An export is open')
  })
})

describe('the web page checks what it is asked to sign', () => {
  it('accepts NEARKITS’ real requests, and refuses one that was altered on the way', async () => {
    const { h } = await setup()
    const w = await h.funded(ONE)
    const api = webApi(h)
    const browser = await createExportKeyPair()
    const c = await api.challenge({ kind: 'export', accountId: w.accountId, recipientKey: browser.publicKey })
    const want = { kind: 'export' as const, network: 'testnet', recipient: 'nearkits.com', wallet: w.accountId, recipientKey: browser.publicKey }
    expect(await challengeProblem(c, want)).toBeNull()
    const theirs = await createExportKeyPair()
    // A server that swapped in its own browser key (to read the export) gets no signature.
    const swapped = await api.challenge({ kind: 'export', accountId: w.accountId, recipientKey: theirs.publicKey })
    expect(await challengeProblem(swapped, want)).toMatch(/another browser/)
    const approve = await api.challenge({ kind: 'approve-destination', accountId: w.accountId, destination: 'bob.testnet' })
    expect(
      await challengeProblem(approve, { kind: 'approve-destination', network: 'testnet', recipient: 'nearkits.com', wallet: w.accountId, destination: 'bob.testnet' }),
    ).toBeNull()
    expect(
      await challengeProblem(approve, { kind: 'approve-destination', network: 'testnet', recipient: 'nearkits.com', wallet: w.accountId, destination: 'evil.testnet' }),
    ).toMatch(/another destination/)
    const session = await api.challenge({ kind: 'owner-session', owner: LINKED })
    expect(await challengeProblem(session, { kind: 'owner-session', network: 'testnet', recipient: 'nearkits.com', owner: LINKED })).toBeNull()
  })
})

describe('recovery without Telegram', () => {
  it('the owner wallet alone lists its NEARKITS wallets and exports one: held, announced in Telegram, collected once its hold is over', async () => {
    const { h, linked } = await setup()
    const a = await h.funded(ONE)
    await h.press('cw:list')
    await h.press(h.button('New wallet'))
    const b = (await h.wallet()) as NonNullable<Awaited<ReturnType<Harness['wallet']>>>
    const notices: unknown[] = []
    const api = webApi(h, notices)
    const updatesBefore = h.fake.messages().length
    const session = await api.challenge({ kind: 'owner-session', owner: LINKED })
    expect(session.message).toContain(`Owner wallet: ${LINKED}`)
    const list = await api.wallets({ challengeId: session.id, publicKey: linked.publicKey, signature: await ownerSign(session, linked.pair) })
    expect(list.ownerAccount).toBe(LINKED)
    expect(list.wallets.map((x) => [x.accountId, x.name])).toEqual([
      [a.accountId, 'Main'],
      [b.accountId, 'Wallet 2'],
    ])
    // The session request is used up: replaying it lists nothing.
    expect(await status(api.wallets({ challengeId: session.id, publicKey: linked.publicKey, signature: await ownerSign(session, linked.pair) }))).toBe(409)
    // Listing involved no bot message at all.
    expect(h.fake.messages().length).toBe(updatesBefore)
    const browser = await createExportKeyPair()
    const c = await api.challenge({ kind: 'export', accountId: b.accountId, recipientKey: browser.publicKey })
    const held = await api.requestExport({ challengeId: c.id, publicKey: linked.publicKey, signature: await ownerSign(c, linked.pair) })
    h.advance(held.releaseAt - h.deps.now())
    const out = await api.collect(held.exportId)
    const secret = await openExport(browser.privateKey, out.sealed, { challengeId: c.id, network: 'testnet', accountId: b.accountId })
    const raw = base58Decode(secret.slice('ed25519:'.length)) as Uint8Array
    expect(`ed25519:${base58Encode(raw.subarray(32))}`).toBe(b.publicKey)
    // Telegram is told twice: when it was asked for, and when it was collected. No bot update was involved.
    expect(notices).toEqual([
      { kind: 'export-requested', userId: ALICE.id, accountId: b.accountId, owner: LINKED, browserKey: held.browserKey },
      { kind: 'exported', userId: ALICE.id, accountId: b.accountId, owner: LINKED, released: 'hold' },
    ])
  })

  it('another account’s signature lists nothing of the owner’s', async () => {
    const { h } = await setup()
    await h.funded(ONE)
    const api = webApi(h)
    const mallory = await keypair()
    h.chain.accounts.set(MALLORY, { amount: ONE, keys: { [mallory.publicKey]: 'full' } })
    // Asking as the owner but signing with another key is refused.
    const s1 = await api.challenge({ kind: 'owner-session', owner: LINKED })
    expect(await status(api.wallets({ challengeId: s1.id, publicKey: mallory.publicKey, signature: await ownerSign(s1, mallory.pair) }))).toBe(403)
    // Asking as themselves lists only their own (none).
    const s2 = await api.challenge({ kind: 'owner-session', owner: MALLORY })
    expect((await api.wallets({ challengeId: s2.id, publicKey: mallory.publicKey, signature: await ownerSign(s2, mallory.pair) })).wallets).toEqual([])
  })
})

describe('the owner, not whichever wallet is linked now', () => {
  it('export: a wallet linked later is refused; the owner signs, linked or not', async () => {
    const { h, linked } = await setup()
    const w = await h.funded(ONE)
    const mallory = await intruder(h)
    const api = webApi(h)
    const browser = await createExportKeyPair()
    const c = await api.challenge({ kind: 'export', accountId: w.accountId, recipientKey: browser.publicKey })
    expect(c.ownerAccount).toBe(LINKED)
    expect(await status(api.requestExport({ challengeId: c.id, publicKey: mallory.publicKey, signature: await ownerSign(c, mallory.pair) }))).toBe(403)
    expect((await h.signerVault?.events('testnet', w.accountId))?.map((e) => e.kind)).toContain('owner-proof-refused')
    await h.store.unlink('testnet', LINKED, ALICE.id)
    const held = await api.requestExport({ challengeId: c.id, publicKey: linked.publicKey, signature: await ownerSign(c, linked.pair) })
    expect(held.accountId).toBe(w.accountId)
  })

  it('backup key: always a key of the owner wallet; a request for any other key is refused before signing', async () => {
    const { h, linked } = await setup()
    const w = await h.funded(2n * ONE)
    const mallory = await intruder(h)
    await h.press('cr:show')
    await h.press(h.button('Add backup key'))
    expect(h.last()?.text).toContain(`Your owner wallet <code>${LINKED}</code>`)
    expect(h.last()?.text).not.toContain(mallory.publicKey)
    const forged = await h.custody.store.createIntent({
      walletId: w.id,
      userId: ALICE.id,
      chatId: ALICE.id,
      kind: 'backup-key',
      params: { linkedAccount: MALLORY, publicKey: mallory.publicKey },
      ttlMs: 60_000,
    })
    const sent = h.chain.rpcCalls('send_tx').length
    await h.press(`cx:ok:${forged.id}`)
    expect(h.last()?.text).toContain('Only a key of the wallet this NEARKITS wallet was created with can be its backup key')
    expect(h.chain.rpcCalls('send_tx')).toHaveLength(sent)
    expect(h.chain.keysOf(w.accountId)).toEqual([w.publicKey])
    await addBackup(h)
    expect(h.chain.keysOf(w.accountId).sort()).toEqual([w.publicKey, linked.publicKey].sort())
  })

  it('revoke: a key that isn’t the owner’s doesn’t count, and Recovery warns about it', async () => {
    const { h, linked } = await setup()
    const w = await h.funded(2n * ONE)
    const stranger = await keypair()
    ;(h.chain.accounts.get(w.accountId)?.keys as Record<string, 'full'>)[stranger.publicKey] = 'full'
    await h.press('cr:show')
    expect(h.last()?.text).toContain(`Another key also controls this wallet: <code>${stranger.publicKey.slice(0, 16)}…</code>`)
    await h.press('cr:revoke')
    await h.press(h.button('Remove NEARKITS’ key'))
    expect(h.last()?.text).toContain(`no other key on this wallet is a full-access key of ${LINKED}`)
    expect(h.chain.keysOf(w.accountId)).toContain(w.publicKey)
    await addBackup(h)
    await h.press('cr:revoke')
    await h.press(h.button('Remove NEARKITS’ key'))
    expect(h.last()?.text).toContain('NEARKITS’ key was removed')
    expect(h.chain.keysOf(w.accountId).sort()).toEqual([linked.publicKey, stranger.publicKey].sort())
  })

  it('after a key change on the owner wallet, linking it again makes the new key the backup key', async () => {
    const { h, linked } = await setup()
    const w = await h.funded(2n * ONE)
    const next = await keypair()
    const keys = h.chain.accounts.get(LINKED)?.keys as Record<string, 'full' | 'function-call'>
    delete keys[linked.publicKey]
    keys[next.publicKey] = 'full'
    await addBackup(h)
    expect(h.last()?.text).toContain(`no longer a full-access key of ${LINKED}. Link ${LINKED} again`)
    await h.store.createLinkRequest({ codeHash: 'relink', userId: ALICE.id, network: 'testnet', nonce: 'n', message: 'm', ttlMs: 60_000 })
    await h.store.completeLink({ codeHash: 'relink', network: 'testnet', accountId: LINKED, userId: ALICE.id, publicKey: next.publicKey })
    await addBackup(h)
    expect(h.last()?.text).toContain('Backup key added')
    expect(h.chain.keysOf(w.accountId).sort()).toEqual([w.publicKey, next.publicKey].sort())
  })
})

describe('removing NEARKITS’ access, and deleting an empty wallet', () => {
  it('needs the backup key first; then NEARKITS’ key is deleted on chain and its copy erased', async () => {
    const { h, linked } = await setup()
    const w = await h.funded(2n * ONE)
    await h.press('cr:revoke')
    await h.press(h.button('Remove NEARKITS’ key'))
    expect(h.last()?.text).toContain('Add your backup key first')
    expect(h.chain.keysOf(w.accountId)).toContain(w.publicKey)
    await addBackup(h)
    await h.press('cr:show')
    await h.press(h.button('Remove NEARKITS’ access'))
    await h.press(h.button('Remove NEARKITS’ key'))
    expect(h.last()?.text).toContain('NEARKITS’ key was removed')
    expect(h.chain.keysOf(w.accountId)).toEqual([linked.publicKey])
    expect(await h.custody.store.wallet(w.id)).toMatchObject({ status: 'revoked' })
    // The signer saw NearKit's key gone on chain and erased its copy.
    expect(await h.signerVault?.key('testnet', w.accountId)).toMatchObject({ status: 'erased', sealedKey: null, eraseReason: 'revoked' })
    expect(await h.wallet()).toBeNull()
    expect(h.chain.accounts.get(w.accountId)?.amount).toBeGreaterThan(ONE)
  })

  it('deletes only a wallet that holds nothing of value: never funded, or only NEAR dust', async () => {
    const h = await walletBot()
    await h.press('cw:create')
    const w = await h.wallet()
    await h.press('cr:delete')
    await h.press(h.button('Yes, delete it'))
    expect(h.last()?.text).toContain('never funded')
    expect(await h.custody.store.wallet(w?.id as string)).toMatchObject({ status: 'deleted' })
    expect(await h.signerVault?.key('testnet', w?.accountId as string)).toMatchObject({ status: 'erased', sealedKey: null, eraseReason: 'deleted' })
    await h.funded(ONE)
    await h.press('cr:delete')
    expect(h.last()?.text).toContain('holds 0.05 NEAR or more')
    expect((await h.wallet())?.status).toBe('active')
  })

  it('a wallet left with dust (0.0075 NEAR) is offered for deletion, says the dust stays on chain, and is deleted with its key kept sealed', async () => {
    const h = await walletBot()
    await h.funded(7_500_000_000_000_000_000_000n)
    const w = await h.wallet()
    await h.press('cr:delete')
    expect(h.last()?.text).toContain('holds only dust')
    expect(h.last()?.text).toContain('0.0075')
    await h.press(h.button('Yes, delete it'))
    expect(h.last()?.text).toContain('only dust')
    expect(await h.custody.store.wallet(w?.id as string)).toMatchObject({ status: 'deleted' })
    expect(await h.signerVault?.key('testnet', w?.accountId as string)).toMatchObject({ status: 'active' })
  })
})
