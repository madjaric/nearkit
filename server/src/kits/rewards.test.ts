import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { KIT_LAUNCHPAD, KITS_CONTRACT } from '@/config/kit'
import { NETWORKS } from '@/config/networks'
import { fromFastnear } from '@/services/near/flows'
import { HttpError, type Route } from '../api/http'
import fastnear from './fixtures/fastnear-holder-payouts.json'
import { createKitsRewardsTracker, nearblocksPayouts, verifyPayout } from './rewards'
import { kitsRoutes } from './routes'

/**
 * $KITS' holder rewards, read from NEAR mainnet. The fixtures are FastNEAR's record of three real
 * `pay_tax_holders` transactions (2026-10-08): two for $KITS' launch 2699 (8 and 2 holder payments,
 * paid in native NEAR), and one for another launch (2710, paid in a token). NearBlocks' list of them is
 * built here from those transactions' own arguments, as its API returns it.
 */

const KITS_A = 'CUsuBcPL6iMGJK313cnZfwmMJA48UACXTZAvauu4mWFV'
const KITS_B = '7eW3uDUYo3sZeFnqspYD6RvM6wXTNG8NbjHJUwZ24xXM'
const OTHER = '3qU697d8MgbisyDHdNPpv1zAwcL5hz16nofMP83YvPsS'
const A_AMOUNT = '214275357901757820022881'
const B_AMOUNT = '18251265282793359486094'
const PAID = (BigInt(A_AMOUNT) + BigInt(B_AMOUNT)).toString()
const WAITING = '90769292844558304509419'
const CREATED = 1791401415744
const ids = { launchpad: KIT_LAUNCHPAD, launchId: '2699' }

const raw = (hash: string) => fastnear.transactions.find((t) => t.transaction.hash === hash)
const argsOf = (hash: string) => {
  const fc = (raw(hash)?.transaction.actions as { FunctionCall?: { args: string } }[])[0]?.FunctionCall
  return Buffer.from(fc?.args ?? '', 'base64').toString('utf8')
}
const nsOf = (hash: string) => raw(hash)?.receipts[0]?.execution_outcome.block_timestamp as number
const listed = (hash: string, args = argsOf(hash), ok = true) => ({
  transaction_hash: hash,
  receiver_account_id: KIT_LAUNCHPAD,
  predecessor_account_id: KIT_LAUNCHPAD,
  block_timestamp: String(BigInt(Math.round(nsOf(hash) / 1e6)) * 1_000_000n),
  outcomes: { status: ok },
  actions: [{ action: 'FUNCTION_CALL', method: 'pay_tax_holders', args }],
})

/** NearBlocks' pages, newest first: the other launch's payout (arguments whole), then $KITS' (one whole, one cut short). */
const PAGES: Record<string, unknown> = {
  first: { cursor: 'p2', txns: [listed(OTHER), listed(KITS_A)] },
  p2: { cursor: null, txns: [listed(KITS_B, argsOf(KITS_B).slice(0, 40))] },
}

const VIEWS: Record<string, unknown> = {
  [`${KITS_CONTRACT}|get_tax`]: { tax: { admin: KIT_LAUNCHPAD } },
  [`${KIT_LAUNCHPAD}|get_launch_by_token`]: { id: 2699, token: KITS_CONTRACT, quote: 'wrap.near', created_at_ms: CREATED },
  [`${KIT_LAUNCHPAD}|get_tax`]: { holders_bps: 5000, burn_bps: 5000, paid_holders: PAID, holders_bucket: WAITING, burned: '1' },
}

function fakeChain(opts: { views?: Record<string, unknown>; nearblocksStatus?: number } = {}) {
  const views = opts.views ?? VIEWS
  const calls = { nearblocks: [] as string[], fastnear: [] as string[][] }
  const rpc = {
    async viewFunction<T>(contract: string, method: string, args: Record<string, unknown> = {}): Promise<T | null> {
      if (contract === KIT_LAUNCHPAD && method === 'get_tax' && args.launch_id !== '2699') throw new Error('unknown launch')
      const key = `${contract}|${method}`
      if (!(key in views)) throw new Error(`no view ${key}`)
      return views[key] as T
    },
  }
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.origin === 'https://api.nearblocks.io' && url.pathname === `/v1/account/${KIT_LAUNCHPAD}/txns` && url.searchParams.get('method') === 'pay_tax_holders') {
      calls.nearblocks.push(url.searchParams.get('cursor') ?? 'first')
      if (opts.nearblocksStatus) return new Response('slow down', { status: opts.nearblocksStatus })
      return new Response(JSON.stringify(PAGES[url.searchParams.get('cursor') ?? 'first']), { status: 200 })
    }
    if (String(input) === 'https://tx.main.fastnear.com/v0/transactions') {
      const hashes = (JSON.parse(String(init?.body)) as { tx_hashes: string[] }).tx_hashes
      calls.fastnear.push(hashes)
      return new Response(JSON.stringify({ transactions: fastnear.transactions.filter((t) => hashes.includes(t.transaction.hash)) }), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  const kept = new Map<string, string>()
  const kv = { get: async (k: string) => kept.get(k) ?? null, set: async (k: string, v: string) => void kept.set(k, v) }
  return { rpc, fetchImpl, calls, kv, kept }
}

const tracker = (c: ReturnType<typeof fakeChain>, now = () => 1791500000000) =>
  createKitsRewardsTracker({ rpc: c.rpc, fetch: c.fetchImpl, network: NETWORKS.mainnet, kv: c.kv, now, historyTtlMs: 0 })

describe('the payout calls NearBlocks lists for the launchpad', () => {
  it('reads each one’s launch from its arguments when they are whole, and leaves it to the transaction when they are cut short', () => {
    const { list, cursor } = nearblocksPayouts(PAGES.first, KIT_LAUNCHPAD)
    expect(list.map((c) => [c.tx, c.launchId])).toEqual([
      [OTHER, '2710'],
      [KITS_A, '2699'],
    ])
    expect(cursor).toBe('p2')
    expect(nearblocksPayouts(PAGES.p2, KIT_LAUNCHPAD).list[0]?.launchId).toBeNull()
    expect(list[1]?.at).toBe(Math.round(nsOf(KITS_A) / 1e6))
  })

  it('a failed call, or one on another contract, is nothing to fetch', () => {
    const { list } = nearblocksPayouts({ txns: [listed(KITS_A, argsOf(KITS_A), false), { ...listed(KITS_B), receiver_account_id: 'evil.near' }] }, KIT_LAUNCHPAD)
    expect(list.map((c) => c.launchId)).toEqual(['none', 'none'])
  })
})

describe('a payout, checked on its transaction', () => {
  it('is the batch the launchpad signed for $KITS’ launch: its tax_holders_paid event, exactly the sum it lists, and its payments', () => {
    expect(verifyPayout(raw(KITS_A), fromFastnear(raw(KITS_A)), { tx: KITS_A, at: 1 }, ids)).toEqual({ tx: KITS_A, at: 1, amount: A_AMOUNT, payments: 8 })
    expect(verifyPayout(raw(KITS_B), fromFastnear(raw(KITS_B)), { tx: KITS_B, at: 2 }, ids)).toEqual({ tx: KITS_B, at: 2, amount: B_AMOUNT, payments: 2 })
  })

  it('another launch’s payout, a tampered event or another signer is not a $KITS payout', () => {
    expect(verifyPayout(raw(OTHER), fromFastnear(raw(OTHER)), { tx: OTHER, at: 1 }, ids)).toBeNull()
    const tampered = JSON.parse(JSON.stringify(raw(KITS_B)).replace(`"amount\\":\\"${B_AMOUNT}\\"}]}`, `"amount\\":\\"1\\"}]}`))
    expect(verifyPayout(tampered, fromFastnear(tampered), { tx: KITS_B, at: 2 }, ids)).toBeNull()
    const signer = { ...raw(KITS_B), transaction: { ...raw(KITS_B)?.transaction, signer_id: 'mallory.near' } }
    expect(verifyPayout(signer, fromFastnear(signer), { tx: KITS_B, at: 2 }, ids)).toBeNull()
  })
})

describe('the holder rewards tracker', () => {
  it('serves what the launchpad paid and allocated, and the payouts it verified: allocated is paid plus what waits, never called paid', async () => {
    const c = fakeChain()
    const t = tracker(c)
    await t.view()
    await t.settle()
    const v = await t.view()
    expect(v).toMatchObject({ token: KITS_CONTRACT, launchpad: KIT_LAUNCHPAD, launchId: '2699', asset: 'near', decimals: 24, holdersBps: 5000, paid: PAID, waiting: WAITING })
    expect(BigInt(v.allocated)).toBe(BigInt(PAID) + BigInt(WAITING))
    expect(v.payouts).toEqual([
      { tx: KITS_A, at: Math.round(nsOf(KITS_A) / 1e6), amount: A_AMOUNT, payments: 8 },
      { tx: KITS_B, at: Math.round(nsOf(KITS_B) / 1e6), amount: B_AMOUNT, payments: 2 },
    ])
    expect(v).toMatchObject({ payoutCount: 2, paymentCount: 10, historyComplete: true })
  })

  it('fetches only what may be $KITS’: another launch’s payout (its arguments say so) is never read', async () => {
    const c = fakeChain()
    const t = tracker(c)
    await t.view()
    await t.settle()
    expect(c.calls.fastnear.flat().sort()).toEqual([KITS_A, KITS_B].sort())
  })

  it('keeps how far it got: a restart goes on from there and reads only the newest page', async () => {
    const c = fakeChain()
    const first = tracker(c)
    await first.view()
    await first.settle()
    expect(c.calls.nearblocks).toEqual(['first', 'p2'])
    const again = tracker(c)
    const before = c.calls.nearblocks.length
    // What was found before is there at once, read back from where it was kept.
    expect((await again.view()).payoutCount).toBe(2)
    await again.settle()
    expect(c.calls.nearblocks.slice(before)).toEqual(['first'])
  })

  it('says the history isn’t complete when the verified payouts don’t add up to what was paid', async () => {
    const c = fakeChain({ views: { ...VIEWS, [`${KIT_LAUNCHPAD}|get_tax`]: { holders_bps: 5000, paid_holders: (BigInt(PAID) + 1n).toString(), holders_bucket: '0' } } })
    const t = tracker(c)
    await t.view()
    await t.settle()
    expect((await t.view()).historyComplete).toBe(false)
  })

  it('NearBlocks asking to slow down stops the scan for a while; the totals are still served', async () => {
    const c = fakeChain({ nearblocksStatus: 429 })
    let now = 1791500000000
    const t = tracker(c, () => now)
    const v = await t.view()
    await t.settle()
    expect(v).toMatchObject({ paid: PAID, payoutCount: 0, historyComplete: false })
    await t.view()
    await t.settle()
    expect(c.calls.nearblocks).toHaveLength(1)
    now += 61_000
    await t.view()
    await t.settle()
    expect(c.calls.nearblocks).toHaveLength(2)
  })

  it('refuses what it can’t vouch for: not the tax admin, not this token’s launch, holders not paid in NEAR, figures that aren’t whole', async () => {
    const bad = (views: Record<string, unknown>) => tracker(fakeChain({ views: { ...VIEWS, ...views } })).view()
    await expect(bad({ [`${KITS_CONTRACT}|get_tax`]: { tax: { admin: 'mallory.near' } } })).rejects.toThrow(/tax admin/)
    await expect(bad({ [`${KIT_LAUNCHPAD}|get_launch_by_token`]: { id: 2699, token: 'other.near', quote: 'wrap.near', created_at_ms: CREATED } })).rejects.toThrow(/no launch/)
    await expect(bad({ [`${KIT_LAUNCHPAD}|get_launch_by_token`]: { id: 2699, token: KITS_CONTRACT, quote: 'usdt.near', created_at_ms: CREATED } })).rejects.toThrow(/NEAR/)
    await expect(bad({ [`${KIT_LAUNCHPAD}|get_tax`]: { holders_bps: 5000, paid_holders: '4.2', holders_bucket: '0' } })).rejects.toThrow(/whole number/)
  })

  it('runs on NEAR mainnet, for kits.nearlytrade.near only', () => {
    const c = fakeChain()
    expect(() => createKitsRewardsTracker({ rpc: c.rpc, fetch: c.fetchImpl, network: NETWORKS.testnet, kv: c.kv })).toThrow(/mainnet/)
    expect(() => createKitsRewardsTracker({ rpc: c.rpc, fetch: c.fetchImpl, network: { ...NETWORKS.mainnet, kitsContract: 'evil.near' }, kv: c.kv })).toThrow()
  })
})

describe('/api/kits/rewards', () => {
  it('answers 503 when nothing could be read, never a made-up figure', async () => {
    const failing = { view: async () => Promise.reject(new Error('down')), settle: async () => undefined }
    const route = kitsRoutes({ burns: { view: async () => Promise.reject(new Error('down')) }, rewards: failing })['/api/kits/rewards'] as Route
    await expect(route({}, {} as IncomingMessage)).rejects.toMatchObject({ status: 503, code: 'chain' })
    await expect(route({}, {} as IncomingMessage)).rejects.toBeInstanceOf(HttpError)
  })
})
