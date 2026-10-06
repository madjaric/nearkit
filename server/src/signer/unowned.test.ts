import { beforeEach, describe, expect, it } from 'vitest'
import type { AccessKeyPermission } from '@/services/near/nep413'
import { PolicyViolation, type WalletOperation, type WalletTxPlan } from '../custody/policy'
import type { TelegramRequestView, TradingSigner } from '../custody/signer'
import { KeyUnavailableError } from '../custody/vault'
import type { Database } from '../db/database'
import { SqliteDatabase } from '../db/sqlite'
import type { SignerChain } from './chain'
import { ChallengeError, DestinationNotApprovedError } from './errors'
import type { SignerStore } from './store'
import { exportAsOwner, ownerKeypair, telegramSigner, testSigner } from './testing'

/**
 * NearKit wallets with no owner wallet: the Telegram account that created one controls it.
 * Withdrawal addresses (and the wallet's first owner) are approved with Telegram's own
 * signature on NearKit's Mini App launch, which the signer checks itself: NearKit's app can
 * relay an approval but never make one.
 */

const BOT = 7_000_001
const ALICE = 101
const EVE = 202
const OWNER = 'alice.testnet'
const BLOCK = new Uint8Array(32).fill(9)

function fakeChain() {
  const perms = new Map<string, AccessKeyPermission>()
  const chain: SignerChain = {
    permission: async (a, k) => perms.get(`${a}|${k}`) ?? 'missing',
    accountExists: async () => true,
    accountBalance: async () => ({ exists: true, amount: 10n ** 24n, locked: 0n }),
    tokenBalance: async () => 0n,
    fullAccessKeys: async () => [],
  }
  return { chain, grant: (a: string, k: string) => void perms.set(`${a}|${k}`, 'full') }
}

let now: number
let db: Database
let signer: TradingSigner
let vault: SignerStore
let tg: Awaited<ReturnType<typeof telegramSigner>>
let chain: ReturnType<typeof fakeChain>
let wallet: { accountId: string; publicKey: string; network: string }
let seq: number

const transfer = (to: string, amount = 5n): WalletTxPlan[] => [{ receiverId: to, actions: [{ kind: 'transfer', deposit: amount.toString() }], label: 'w' }]
const withdraw = (to: string, amount = 5n): WalletOperation => ({ kind: 'withdraw-near', to, amount })
const sign = (to: string, w = wallet) => signer.sign({ wallet: w, intentId: `i${++seq}`, step: 0, op: withdraw(to), plan: transfer(to), nonce: 42n, blockHash: BLOCK })

/** The user opens NearKit's Mini App from the request's link and taps Approve: Telegram signs the launch. */
async function openInTelegram(r: TelegramRequestView, userId = ALICE, at = now) {
  return tg.launch({ userId, startParam: r.digest, authDate: Math.floor(at / 1000) })
}
async function approveDestination(to: string, w = wallet, userId = ALICE) {
  const r = await signer.telegramRequest({ kind: 'destination', accountId: w.accountId, destination: to })
  return signer.telegramApprove(await openInTelegram(r, userId))
}

beforeEach(async () => {
  now = 1_790_000_000_000
  seq = 0
  db = await SqliteDatabase.open(null)
  chain = fakeChain()
  tg = await telegramSigner(BOT)
  const s = await testSigner(db, { now: () => now, chain: chain.chain, oracle: { expectedOut: async () => 1n }, config: { telegram: tg.check } })
  signer = s.signer
  vault = s.store
  const k = await signer.createKey({ userId: ALICE })
  wallet = { accountId: k.accountId, publicKey: k.publicKey, network: 'testnet' }
})

describe('a NEARKITS wallet created with no owner wallet', () => {
  it('is sealed to the Telegram account that created it, and has no owner', async () => {
    const held = await vault.key('testnet', wallet.accountId)
    expect(held).toMatchObject({ status: 'active', ownerAccount: null, userId: ALICE })
    expect(JSON.parse(held?.sealedKey as string)).toMatchObject({ v: 3 })
    expect((await signer.keyInfo(wallet.accountId)).ownerAccount).toBeNull()
  })

  it('withdraws only to addresses its Telegram account approved: the app alone can send nowhere', async () => {
    // A compromised app skips every check of its own and asks the signer directly.
    await expect(sign('mallory.testnet')).rejects.toThrow(DestinationNotApprovedError)
    await approveDestination('bob.testnet')
    expect((await sign('bob.testnet')).hash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/)
    await expect(sign('mallory.testnet')).rejects.toThrow(DestinationNotApprovedError)
    expect((await signer.destinations(wallet.accountId)).destinations.map((d) => d.destination)).toEqual(['bob.testnet'])
    expect((await vault.events('testnet', wallet.accountId)).map((e) => e.kind)).toContain('tg-destination-approved')
  })

  it('counts an approval only as Telegram’s signature for exactly that request, by that account', async () => {
    const r = await signer.telegramRequest({ kind: 'destination', accountId: wallet.accountId, destination: 'bob.testnet' })
    expect(r).toMatchObject({ kind: 'destination', accountId: wallet.accountId, target: 'bob.testnet', network: 'testnet' })
    // Another Telegram account opening the same link.
    await expect(signer.telegramApprove(await openInTelegram(r, EVE))).rejects.toThrow(ChallengeError)
    // Launch data made before the request existed.
    await expect(signer.telegramApprove(await openInTelegram(r, ALICE, now - 5 * 60_000))).rejects.toThrow(/before/)
    // Telegram's signature over something else, or edited after Telegram signed it.
    const other = await signer.telegramRequest({ kind: 'destination', accountId: wallet.accountId, destination: 'mallory.testnet' })
    const forOther = new URLSearchParams(await openInTelegram(other))
    forOther.set('start_param', r.digest)
    await expect(signer.telegramApprove(forOther.toString())).rejects.toThrow(/signed by Telegram/)
    // The real one works, once.
    const good = await openInTelegram(r)
    expect(await signer.telegramApprove(good)).toMatchObject({ kind: 'destination', accountId: wallet.accountId, target: 'bob.testnet' })
    await expect(signer.telegramApprove(good)).rejects.toThrow(/already used/)
    // An expired request.
    const late = await signer.telegramRequest({ kind: 'destination', accountId: wallet.accountId, destination: 'carol.testnet' })
    now += 11 * 60_000
    await expect(signer.telegramApprove(await openInTelegram(late))).rejects.toThrow(/expired/)
    expect((await signer.destinations(wallet.accountId)).destinations.map((d) => d.destination)).toEqual(['bob.testnet'])
  })

  it('re-verifies an approval at every use: one edited in the signer’s database no longer counts', async () => {
    await approveDestination('bob.testnet')
    await db.run("UPDATE signer_tg_approvals SET destination = 'mallory.testnet'")
    await expect(sign('mallory.testnet')).rejects.toThrow(DestinationNotApprovedError)
    await db.run("UPDATE signer_tg_approvals SET destination = 'bob.testnet', user_id = ?", [EVE])
    await expect(sign('bob.testnet')).rejects.toThrow(DestinationNotApprovedError)
  })

  it('a Telegram account rewritten in the signer’s database leaves the key unopenable, not usable', async () => {
    await approveDestination('bob.testnet')
    await db.run('UPDATE signer_keys SET user_id = ?', [EVE])
    await db.run('UPDATE signer_tg_approvals SET user_id = ?', [EVE])
    await expect(sign('bob.testnet')).rejects.toThrow()
    await db.run('UPDATE signer_keys SET user_id = ?', [ALICE])
    await db.run('UPDATE signer_tg_approvals SET user_id = ?', [ALICE])
    expect((await sign('bob.testnet')).hash).toBeTruthy()
  })

  it('has none of the owner wallet’s powers: no export, no owner session, no backup key, no removing NEARKITS’ key', async () => {
    await expect(signer.challenge({ kind: 'export', accountId: wallet.accountId, recipientKey: 'x' })).rejects.toThrow(ChallengeError)
    await expect(signer.challenge({ kind: 'approve-destination', accountId: wallet.accountId, destination: 'bob.testnet' })).rejects.toThrow(ChallengeError)
    const keyPlan: WalletTxPlan[] = [
      { receiverId: wallet.accountId, actions: [{ kind: 'add-key', publicKey: 'ed25519:Anu7LYDfpLtkP7E16LT9imXF694BdQaa9ufVkQiwTQxC' }], label: 'k' },
    ]
    await expect(
      signer.sign({
        wallet,
        intentId: 'k1',
        step: 0,
        op: { kind: 'add-backup-key', publicKey: 'ed25519:Anu7LYDfpLtkP7E16LT9imXF694BdQaa9ufVkQiwTQxC' },
        plan: keyPlan,
        nonce: 42n,
        blockHash: BLOCK,
      }),
    ).rejects.toThrow(PolicyViolation)
    const revokePlan: WalletTxPlan[] = [{ receiverId: wallet.accountId, actions: [{ kind: 'delete-key', publicKey: wallet.publicKey }], label: 'r' }]
    await expect(
      signer.sign({ wallet, intentId: 'r1', step: 0, op: { kind: 'revoke', publicKey: wallet.publicKey }, plan: revokePlan, nonce: 42n, blockHash: BLOCK }),
    ).rejects.toThrow(PolicyViolation)
  })
})

describe('binding a first owner wallet later', () => {
  it('needs the Telegram account’s approval naming that owner; then the wallet is owned, for good', async () => {
    const owner = await ownerKeypair()
    chain.grant(OWNER, owner.publicKey)
    await approveDestination('bob.testnet')
    const r = await signer.telegramRequest({ kind: 'bind-owner', accountId: wallet.accountId, owner: OWNER, ownerKey: owner.publicKey })
    expect(r).toMatchObject({ kind: 'bind-owner', target: OWNER })
    expect(await signer.telegramApprove(await openInTelegram(r))).toMatchObject({ kind: 'bind-owner', target: OWNER })
    const held = await vault.key('testnet', wallet.accountId)
    expect(held).toMatchObject({ ownerAccount: OWNER, ownerKey: owner.publicKey })
    expect(JSON.parse(held?.sealedKey as string)).toMatchObject({ v: 2 })
    // The owned rules from now on: the owner, or destinations the owner signs for.
    expect((await sign(OWNER)).hash).toBeTruthy()
    await expect(sign('bob.testnet')).rejects.toThrow(DestinationNotApprovedError)
    // Its owner has the owner's powers: the export works.
    expect(await exportAsOwner({ challenge: (c) => signer.challenge(c), exportKey: (p) => signer.exportKey(p) }, wallet.accountId, owner)).toMatch(/^ed25519:/)
    // Telegram can't approve anything for it any more, and it is never bound again.
    await expect(signer.telegramRequest({ kind: 'destination', accountId: wallet.accountId, destination: 'carol.testnet' })).rejects.toThrow(/owner wallet/)
    await expect(signer.telegramRequest({ kind: 'bind-owner', accountId: wallet.accountId, owner: 'mallory.testnet', ownerKey: owner.publicKey })).rejects.toThrow(/owner wallet/)
  })

  it('an owner hijack fails: no approval, another Telegram account, or an approval that names someone else', async () => {
    const owner = await ownerKeypair()
    // The app asks, but nobody approves in Telegram: nothing changes.
    await signer.telegramRequest({ kind: 'bind-owner', accountId: wallet.accountId, owner: 'mallory.testnet', ownerKey: owner.publicKey })
    // Eve opens the link from her own Telegram account.
    const r = await signer.telegramRequest({ kind: 'bind-owner', accountId: wallet.accountId, owner: 'mallory.testnet', ownerKey: owner.publicKey })
    await expect(signer.telegramApprove(await openInTelegram(r, EVE))).rejects.toThrow(/controls this NEARKITS wallet/)
    // Alice's approval of OWNER is Telegram's signature over OWNER's request: it can't bind anyone else.
    const mine = await signer.telegramRequest({ kind: 'bind-owner', accountId: wallet.accountId, owner: OWNER, ownerKey: owner.publicKey })
    const swapped = new URLSearchParams(await openInTelegram(mine))
    swapped.set('start_param', r.digest)
    await expect(signer.telegramApprove(swapped.toString())).rejects.toThrow(/signed by Telegram/)
    const held = await vault.key('testnet', wallet.accountId)
    expect(held?.ownerAccount).toBeNull()
    expect(JSON.parse(held?.sealedKey as string)).toMatchObject({ v: 3 })
    // A rewritten owner in the database opens nothing: the key is still sealed to Alice's Telegram account.
    await db.run("UPDATE signer_keys SET owner_account = 'mallory.testnet'")
    await expect(sign('mallory.testnet')).rejects.toThrow(KeyUnavailableError)
  })

  it('an owned wallet (created with its owner) never takes a Telegram approval', async () => {
    const owner = await ownerKeypair()
    const k = await signer.createKey({ userId: ALICE, owner: { accountId: OWNER, publicKey: owner.publicKey } })
    const owned = { accountId: k.accountId, publicKey: k.publicKey, network: 'testnet' }
    await expect(signer.telegramRequest({ kind: 'destination', accountId: owned.accountId, destination: 'bob.testnet' })).rejects.toThrow(/owner wallet/)
    await expect(signer.telegramRequest({ kind: 'bind-owner', accountId: owned.accountId, owner: 'mallory.testnet', ownerKey: owner.publicKey })).rejects.toThrow(/owner wallet/)
    await expect(sign('bob.testnet', owned)).rejects.toThrow(DestinationNotApprovedError)
    expect((await sign(OWNER, owned)).hash).toBeTruthy()
  })
})

describe('without Telegram approvals configured', () => {
  it('fails closed: nothing can be approved, and health says so', async () => {
    const plain = await testSigner(await SqliteDatabase.open(null), { now: () => now, chain: chain.chain, oracle: { expectedOut: async () => 1n } })
    const k = await plain.signer.createKey({ userId: ALICE })
    await expect(plain.signer.telegramRequest({ kind: 'destination', accountId: k.accountId, destination: 'bob.testnet' })).rejects.toThrow(/Telegram/)
    expect((await plain.signer.health()).telegram).toBeNull()
    expect((await signer.health()).telegram).toBe(BOT)
  })
})
