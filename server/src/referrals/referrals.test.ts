import { beforeEach, describe, expect, it } from 'vitest'
import { NETWORKS } from '@/config/networks'
import { PRODUCTION_FEE_RECIPIENT } from '@/lib/fees'
import type { RpcTxResult } from '@/services/near/rpc'
import { CustodyStore } from '../custody/store'
import type { Database, SqlParams } from '../db/database'
import { Store } from '../db/store'
import { ENGINE_TIMEOUT_MS, openTestDatabase, TEST_ENGINES } from '../db/testing'
import { checkPayout } from './payout'
import { ATTRIBUTION_WINDOW_MS, createReferrals, type Referrals, type TradeFee } from './service'
import { isReferralCode, ReferralStore } from './store'

const ALICE = 101
const BOB = 202
const CAROL = 303
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
const fee = (raw: bigint, recipient = PRODUCTION_FEE_RECIPIENT, token = USDC): TradeFee => ({ token, raw: raw.toString(), recipient })

describe.each(TEST_ENGINES)(
  'referrals on %s',
  (engine) => {
    let db: Database
    let store: Store
    let r: Referrals
    let now: number
    const join = async (userId: number) => store.upsertUser({ userId, username: null, firstName: `U${userId}`, languageCode: null })
    const link = async (userId: number, accountId: string) => {
      await store.createLinkRequest({ codeHash: `h${userId}${accountId}`, userId, network: 'mainnet', nonce: 'n', message: 'm', ttlMs: 60_000 })
      await store.completeLink({ codeHash: `h${userId}${accountId}`, network: 'mainnet', accountId, userId, publicKey: 'ed25519:K' })
    }
    const trade = (id: string, userId: number, f: TradeFee | null, trader: string | null = 'bob.near') =>
      r.recordTrade({ source: 'intent', sourceId: id, userId, fee: f, txHash: `tx-${id}`, trader })

    beforeEach(async () => {
      now = 1_000_000_000
      db = await openTestDatabase(engine)
      store = new Store(db, () => now)
      r = createReferrals({ db, store, custody: new CustodyStore(db, () => now), network: NETWORKS.mainnet, feeRecipient: PRODUCTION_FEE_RECIPIENT, now: () => now })
      await join(ALICE)
      await link(ALICE, 'alice.near')
    })

    it('one permanent, readable code per user, shared as a t.me start link', async () => {
      const a = await r.link(ALICE, 'NearKitBot')
      expect(isReferralCode(a.code)).toBe(true)
      expect(a.url).toBe(`https://t.me/NearKitBot?start=ref_${a.code}`)
      expect((await r.link(ALICE, 'NearKitBot')).code).toBe(a.code)
      await join(BOB)
      expect((await r.link(BOB, 'NearKitBot')).code).not.toBe(a.code)
    })

    it('attributes a new user once, for good; never themselves, never a second referrer, never an old user', async () => {
      const { code } = await r.link(ALICE, 'b')
      await join(BOB)
      expect((await r.attribute(BOB, code)).result).toBe('attributed')
      expect((await r.attribute(BOB, code)).result).toBe('already')
      // Another code later changes nothing.
      await join(CAROL)
      const carol = await r.link(CAROL, 'b')
      expect((await r.attribute(BOB, carol.code)).result).toBe('already')
      expect((await r.store.attribution(BOB))?.referrerUserId).toBe(ALICE)
      // Self, unknown and malformed codes.
      expect((await r.attribute(ALICE, code)).result).toBe('self')
      expect((await r.attribute(CAROL, 'ZZZZZZZZ')).result).toBe('unknown-code')
      expect((await r.attribute(CAROL, 'not a code')).result).toBe('unknown-code')
      // Carol has been around too long now.
      now += ATTRIBUTION_WINDOW_MS + 1
      expect((await r.attribute(CAROL, code)).result).toBe('not-new')
    })

    it('a user who already linked a wallet or has a NEARKITS wallet is not new', async () => {
      const { code } = await r.link(ALICE, 'b')
      await join(BOB)
      await link(BOB, 'bob.near')
      expect((await r.attribute(BOB, code)).result).toBe('not-new')
      await join(CAROL)
      await new CustodyStore(db, () => now).createWallet({ userId: CAROL, network: 'mainnet', accountId: 'c'.repeat(64), publicKey: 'ed25519:C', keyRef: 'k' })
      expect((await r.attribute(CAROL, code)).result).toBe('not-new')
    })

    it('no loops: someone you referred can’t become your referrer', async () => {
      await join(BOB)
      const alice = await r.link(ALICE, 'b')
      expect((await r.attribute(BOB, alice.code)).result).toBe('attributed')
      const bob = await r.link(BOB, 'b')
      expect((await r.attribute(ALICE, bob.code)).result).toBe('loop')
    })

    it('two invites racing for one new user: exactly one wins', async () => {
      await join(BOB)
      await join(CAROL)
      const [a, c] = [await r.link(ALICE, 'b'), await r.link(CAROL, 'b')]
      const results = await Promise.all([r.attribute(BOB, a.code), r.attribute(BOB, c.code)])
      expect(results.filter((x) => x.result === 'attributed')).toHaveLength(1)
    })

    it('earns 20% of what NEARKITS received, once per trade, only for fees that reached the production account', async () => {
      await join(BOB)
      await r.attribute(BOB, (await r.link(ALICE, 'b')).code)
      // 400 raw received = 0.40% of a 100 000 raw trade: 80 to Alice, 320 NearKit's.
      expect(await trade('t1', BOB, fee(400n))).toBe(true)
      expect(await trade('t1', BOB, fee(400n))).toBe(false)
      const [e] = await r.store.earningsOf(ALICE, 'mainnet')
      expect(e).toMatchObject({ referral: 80n, net: 320n, received: 400n, volume: 100_000n, token: USDC, referredUserId: BOB })
      // A fee that went elsewhere, no fee, a zero fee, and a user nobody referred earn nothing.
      expect(await trade('t2', BOB, fee(400n, 'testone.near'))).toBe(false)
      expect(await trade('t3', BOB, null)).toBe(false)
      expect(await trade('t4', BOB, fee(0n))).toBe(false)
      await join(CAROL)
      expect(await trade('t5', CAROL, fee(400n))).toBe(false)
    })

    it('the same trade reported twice at once is earned once', async () => {
      await join(BOB)
      await r.attribute(BOB, (await r.link(ALICE, 'b')).code)
      const results = await Promise.all([trade('t1', BOB, fee(400n)), trade('t1', BOB, fee(400n)), trade('t1', BOB, fee(400n))])
      expect(results.filter(Boolean)).toHaveLength(1)
      expect(await r.store.earningsOf(ALICE, 'mainnet')).toHaveLength(1)
    })

    it('one on-chain transaction earns once, whatever record reports it (two handoffs, an intent and a handoff)', async () => {
      await join(BOB)
      await r.attribute(BOB, (await r.link(ALICE, 'b')).code)
      const once = (source: 'intent' | 'handoff', id: string) => r.recordTrade({ source, sourceId: id, userId: BOB, fee: fee(400n), txHash: 'SAME-TX', trader: 'bob.near' })
      expect(await once('handoff', 'h1')).toBe(true)
      expect(await once('handoff', 'h2')).toBe(false)
      expect(await once('intent', 'i1')).toBe(false)
      expect(await r.store.earningsOf(ALICE, 'mainnet')).toHaveLength(1)
    })

    it('a referrer trading through the referred account with their own wallet earns nothing', async () => {
      await join(BOB)
      await r.attribute(BOB, (await r.link(ALICE, 'b')).code)
      expect(await trade('t1', BOB, fee(400n), 'alice.near')).toBe(false)
      expect(await r.store.earningsOf(ALICE, 'mainnet')).toEqual([])
    })

    it('summary and claims: available until claimed, one open claim per token, paid or released, never paid twice', async () => {
      await join(BOB)
      await r.attribute(BOB, (await r.link(ALICE, 'b')).code)
      await trade('t1', BOB, fee(400n))
      await trade('t2', BOB, fee(1000n))
      let s = await r.summary(ALICE, 'NearKitBot')
      expect(s.referred).toBe(1)
      expect(s.tokens).toEqual([{ token: USDC, volume: 350_000n, earned: 280n, claimed: 0n, pending: 0n, available: 280n }])
      const first = await r.requestClaim(ALICE, USDC, 'alice.near')
      expect(first).toMatchObject({ kind: 'created', claim: { amount: 280n, destination: 'alice.near', status: 'requested' } })
      expect(await r.requestClaim(ALICE, USDC, 'alice.near')).toMatchObject({ kind: 'open' })
      await trade('t3', BOB, fee(500n))
      s = await r.summary(ALICE, 'NearKitBot')
      expect(s.tokens[0]).toMatchObject({ pending: 280n, available: 100n })
      const id = first.kind === 'created' ? first.claim.id : ''
      expect(await r.store.markPaid(id, 'payout-tx')).toBe(true)
      expect(await r.store.markPaid(id, 'payout-tx')).toBe(false)
      s = await r.summary(ALICE, 'NearKitBot')
      expect(s.tokens[0]).toMatchObject({ claimed: 280n, pending: 0n, available: 100n })
      // A rejected claim releases its earnings; a forfeited one keeps them out for good.
      const second = await r.requestClaim(ALICE, USDC, 'alice.near')
      expect(second).toMatchObject({ kind: 'created', claim: { amount: 100n } })
      await r.store.reject(second.kind === 'created' ? second.claim.id : '', 'review', false)
      expect((await r.summary(ALICE, 'b')).tokens[0]).toMatchObject({ available: 100n })
      const third = await r.requestClaim(ALICE, USDC, 'alice.near')
      await r.store.reject(third.kind === 'created' ? third.claim.id : '', 'abuse', true)
      expect((await r.summary(ALICE, 'b')).tokens[0]).toMatchObject({ earned: 280n, available: 0n })
      expect(await r.requestClaim(ALICE, USDC, 'alice.near')).toEqual({ kind: 'empty' })
    })

    it('two claims at once: one claim, the earnings in it once', async () => {
      await join(BOB)
      await r.attribute(BOB, (await r.link(ALICE, 'b')).code)
      await trade('t1', BOB, fee(400n))
      const both = await Promise.all([r.requestClaim(ALICE, USDC, 'alice.near'), r.requestClaim(ALICE, USDC, 'alice.near')])
      const ids = new Set(both.map((c) => (c.kind === 'empty' ? null : c.claim.id)))
      expect(ids.size).toBe(1)
      expect(await r.store.claims('mainnet')).toHaveLength(1)
      expect((await r.store.claims('mainnet'))[0]?.amount).toBe(80n)
    })

    it('a claim another request made meanwhile is answered as open, never as "nothing to claim"', async () => {
      await join(BOB)
      await r.attribute(BOB, (await r.link(ALICE, 'b')).code)
      await trade('t1', BOB, fee(400n))
      // The other request commits between this one's look for an open claim and its read of
      // the earnings (PostgreSQL's READ COMMITTED allows that): its claim is visible by then,
      // and the earnings are no longer unclaimed.
      let raced = false
      const racing = new Proxy(db, {
        get(target, prop) {
          const value = Reflect.get(target, prop) as unknown
          if (prop !== 'all') return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
          return async (sql: string, params?: SqlParams) => {
            if (!raced && sql.startsWith('SELECT id, referral_raw FROM referral_earnings')) {
              raced = true
              await target.run(
                "INSERT INTO referral_claims (id, referrer_user_id, network, token, amount_raw, destination, status, requested_at) VALUES ('first', ?, 'mainnet', ?, '80', 'alice.near', 'requested', ?)",
                [ALICE, USDC, now],
              )
              await target.run("UPDATE referral_earnings SET claim_id = 'first' WHERE referrer_user_id = ? AND claim_id IS NULL", [ALICE])
            }
            return target.all(sql, params)
          }
        },
      })
      const c = await new ReferralStore(racing, () => now).createClaim({ referrerUserId: ALICE, network: 'mainnet', token: USDC, destination: 'alice.near' })
      expect(raced).toBe(true)
      expect(c).toMatchObject({ kind: 'open', claim: { id: 'first', amount: 80n } })
      expect(await r.store.claims('mainnet')).toHaveLength(1)
    })

    it('one payout transaction can’t settle two claims', async () => {
      await join(BOB)
      await r.attribute(BOB, (await r.link(ALICE, 'b')).code)
      await trade('t1', BOB, fee(400n))
      await trade('t2', BOB, fee(400n, PRODUCTION_FEE_RECIPIENT, 'wrap.near'))
      const a = await r.requestClaim(ALICE, USDC, 'alice.near')
      const b = await r.requestClaim(ALICE, 'wrap.near', 'alice.near')
      expect(await r.store.markPaid(a.kind === 'created' ? a.claim.id : '', 'same-tx')).toBe(true)
      await expect(r.store.markPaid(b.kind === 'created' ? b.claim.id : '', 'same-tx')).rejects.toThrow()
    })
  },
  ENGINE_TIMEOUT_MS,
)

describe('payout check', () => {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64')
  const tx = (receiver: string, actions: unknown[], ok = true): RpcTxResult =>
    ({
      status: ok ? { SuccessValue: '' } : { Failure: {} },
      transaction: { hash: 'h', signer_id: 'nearkitfee.near', receiver_id: receiver, actions },
      transaction_outcome: { id: 'h', outcome: { status: { SuccessReceiptId: 'r' }, logs: [], receipt_ids: [], gas_burnt: 0, executor_id: 'nearkitfee.near' } },
      receipts_outcome: [],
    }) as unknown as RpcTxResult
  const claim = { token: USDC, amount: 80n, destination: 'alice.near' }
  const ftTransfer = (to: string, amount: string) => ({ FunctionCall: { method_name: 'ft_transfer', args: b64({ receiver_id: to, amount }), gas: 1, deposit: '1' } })

  it('accepts exactly the claim’s amount of its token to its destination', () => {
    expect(checkPayout(tx(USDC, [ftTransfer('alice.near', '80')]), claim, 'wrap.near')).toEqual({ ok: true })
    expect(checkPayout(tx('alice.near', [{ Transfer: { deposit: '80' } }]), { ...claim, token: 'wrap.near' }, 'wrap.near')).toEqual({ ok: true })
  })

  it('refuses a failed transaction, another amount, destination or token, or NEAR for a token claim', () => {
    for (const t of [
      tx(USDC, [ftTransfer('alice.near', '80')], false),
      tx(USDC, [ftTransfer('alice.near', '79')]),
      tx(USDC, [ftTransfer('mallory.near', '80')]),
      tx('usdt.tether-token.near', [ftTransfer('alice.near', '80')]),
      tx('alice.near', [{ Transfer: { deposit: '80' } }]),
    ])
      expect(checkPayout(t, claim, 'wrap.near').ok).toBe(false)
  })
})
