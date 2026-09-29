import { describe, expect, it } from 'vitest'
import { NETWORKS } from '@/config/networks'
import aggBuy from './fixtures/flows/aggregator-buy-with-rhea.fastnear.json'
import aggSell from './fixtures/flows/aggregator-sell.fastnear.json'
import directBuy from './fixtures/flows/direct-buy-wrap-dcl.fastnear.json'
import directSell from './fixtures/flows/direct-sell-dcl.fastnear.json'
import tax from './fixtures/flows/launchpad-tax.fastnear.json'
import registration from './fixtures/flows/testone-usdc-registration.fastnear.json'
import swap1 from './fixtures/flows/testone-swap1-near-to-usdt.fastnear.json'
import swap2 from './fixtures/flows/testone-swap2-near-to-usdc.fastnear.json'
import { fetchNearUsdHours, HOUR_MS, usdAt } from './candles'
import { fromFastnear } from './flows'
import { fetchAccountTxs, ledgerEvents } from './history'

const SING = 'singularty.nearlytrade.near'
const USDT = 'usdt.tether-token.near'
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
const net = NETWORKS.mainnet
const opts = (nearUsd: number | null = 5) => ({ wrapContract: net.wrapContract, stables: net.stableTokens, nearUsdAt: () => nearUsd })
const N = 10n ** 24n

describe('ledger events from real transactions', () => {
  it('a NEAR → USDt swap is a USDt buy costing exactly the NEAR sent plus the gas the account paid', () => {
    const tx = fromFastnear(swap1)
    const events = ledgerEvents(tx, 'testone.near', opts(4.74))
    expect(events).toHaveLength(1)
    const e = events[0]
    expect(e?.token).toBe(USDT)
    expect(e?.event).toMatchObject({ kind: 'buy', amount: 883420n })
    const value = (e?.event as { value: { near: bigint; usd: number } }).value
    expect(value.near).toBe(187488840871875000000000n + tx.gasBurnt)
    expect(value.usd).toBeCloseTo((Number(value.near) / 1e24) * 4.74, 6)
  })

  it('the second swap buys USDC the same way', () => {
    const events = ledgerEvents(fromFastnear(swap2), 'testone.near', opts())
    expect(events.map((e) => [e.token, e.event.kind, e.event.amount])).toEqual([[USDC, 'buy', 623214n]])
  })

  it('a storage registration is not a position event', () => {
    expect(ledgerEvents(fromFastnear(registration), 'testone.near', opts())).toEqual([])
  })

  it('a direct DCL buy and sell of SINGULARTY', () => {
    const buy = ledgerEvents(fromFastnear(directBuy), 'mort1705.tg', opts())
    expect(buy).toHaveLength(1)
    expect(buy[0]?.event).toMatchObject({ kind: 'buy', amount: 69099416000669574619652n })
    expect((buy[0]?.event as { value: { near: bigint } }).value.near).toBeGreaterThan(N)
    const sell = ledgerEvents(fromFastnear(directSell), 'iwillwin.user.intear.near', opts())
    expect(sell).toHaveLength(1)
    expect(sell[0]?.event.kind).toBe('sell')
    const proceeds = (sell[0]?.event as { value: { near: bigint } }).value.near
    // 6.4666… NEAR received, less the gas the seller paid.
    expect(proceeds).toBeLessThan(6466620529704459818356932n)
    expect(proceeds).toBeGreaterThan(6_400_000n * 10n ** 18n)
  })

  it('a token-for-token swap has no known NEAR value on either side: flagged, not guessed', () => {
    const events = ledgerEvents(fromFastnear(aggBuy), 'alijay3637.tg', opts())
    const sing = events.find((e) => e.token === SING)
    const rhea = events.find((e) => e.token === 'token.rhealab.near')
    expect(sing?.event).toMatchObject({ kind: 'buy', value: { near: null, usd: null } })
    expect(rhea?.event).toMatchObject({ kind: 'sell', amount: 15000000000000000000n, value: { near: null, usd: null } })
  })

  it('a refunded swap leaves no event; tokens sent away without payment are a transfer out', () => {
    expect(ledgerEvents(fromFastnear(aggSell), 'pulamica.near', opts())).toEqual([])
    const out = ledgerEvents(fromFastnear(tax), 'nearlytrade.near', opts())
    expect(out).toHaveLength(1)
    expect(out[0]?.event).toMatchObject({ kind: 'transfer-out' })
  })

  it('without a NEAR/USD price for the hour, USD stays unknown while NEAR is exact', () => {
    const events = ledgerEvents(fromFastnear(swap1), 'testone.near', opts(null))
    expect((events[0]?.event as { value: { near: bigint | null; usd: number | null } }).value).toMatchObject({ usd: null })
    expect((events[0]?.event as { value: { near: bigint | null } }).value.near).not.toBeNull()
  })
})

describe('account history paging', () => {
  it('pages through the index until it runs out, newest first, and says whether it saw everything', async () => {
    const pages: Record<string, unknown> = {
      first: {
        account_txs: [
          { transaction_hash: 'h3', tx_block_height: 30, tx_block_timestamp: '3000000000' },
          { transaction_hash: 'h2', tx_block_height: 20, tx_block_timestamp: '2000000000' },
        ],
        resume_token: 'next',
      },
      next: { account_txs: [{ transaction_hash: 'h1', tx_block_height: 10, tx_block_timestamp: '1000000000' }] },
    }
    const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { resume_token?: string }
      return new Response(JSON.stringify(pages[body.resume_token ?? 'first']))
    }) as typeof fetch
    const r = await fetchAccountTxs(fetchImpl, 'https://tx.example', 'a.near', { pageSize: 2, max: 10, pace: async () => {} })
    expect(r.complete).toBe(true)
    expect(r.txs.map((t) => [t.hash, t.blockHeight, t.timestampMs])).toEqual([
      ['h3', 30, 3000],
      ['h2', 20, 2000],
      ['h1', 10, 1000],
    ])
    const capped = await fetchAccountTxs(fetchImpl, 'https://tx.example', 'a.near', { pageSize: 2, max: 2, pace: async () => {} })
    expect(capped.complete).toBe(false)
    expect(capped.txs).toHaveLength(2)
  })
})

describe('NEAR/USD history', () => {
  it('reads hourly closes from Coinbase and falls back to the previous hour only', async () => {
    const t0 = Date.UTC(2026, 8, 28, 21, 0, 0)
    const calls: string[] = []
    const fetchImpl = (async (url: RequestInfo | URL) => {
      calls.push(String(url))
      return new Response(
        JSON.stringify([
          [t0 / 1000 + 3600, 4.5, 4.9, 4.6, 4.8, 1],
          [t0 / 1000, 4.5, 4.9, 4.6, 4.7, 1],
        ]),
      )
    }) as typeof fetch
    const hours = await fetchNearUsdHours(fetchImpl, 'https://api.exchange.coinbase.com/products/NEAR-USD', [t0 + 10 * 60_000, t0 + HOUR_MS + 5])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('granularity=3600')
    expect(usdAt(hours, t0 + 1)).toBe(4.7)
    expect(usdAt(hours, t0 + HOUR_MS + 1)).toBe(4.8)
    expect(usdAt(hours, t0 + 2 * HOUR_MS + 1)).toBe(4.8)
    expect(usdAt(hours, t0 + 5 * HOUR_MS)).toBeNull()
  })
})
