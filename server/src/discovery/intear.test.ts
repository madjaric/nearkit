import { describe, expect, it } from 'vitest'
import candles from './fixtures/candles.json'
import holders from './fixtures/holders.json'
import tokens from './fixtures/tokens.json'
import trades from './fixtures/trades.json'
import { createIntear, IntearError, LAUNCH_FIELDS } from './intear'

/**
 * The Intear client against responses recorded from api.intea.rs on 2026-10-16 (fixtures/): its
 * column/row tables become typed records; lists go comma-separated in the query; one request is in
 * flight at a time; errors keep Intear's status and code.
 */

function fakeFetch(answer: (url: URL) => { status?: number; body: unknown }) {
  const calls: string[] = []
  let inFlight = 0
  let maxInFlight = 0
  const fetch = (async (input: string | URL) => {
    const url = new URL(String(input))
    calls.push(`${url.pathname}?${url.searchParams.toString()}`)
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((r) => setTimeout(r, 5))
    inFlight -= 1
    const a = answer(url)
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
  return { fetch, calls, maxInFlight: () => maxInFlight }
}

const client = (f: ReturnType<typeof fakeFetch>) => createIntear({ baseUrl: 'https://api.intea.rs', fetch: f.fetch, spacingMs: 0 })

describe('Intear client', () => {
  it('launches: every token created after a time, newest first, with typed market fields', async () => {
    const f = fakeFetch(() => ({ body: tokens }))
    const r = await client(f).launches({ createdAfter: 1_791_500_000_000, limit: 2000 })
    expect(f.calls[0]).toContain('/tokens?')
    expect(f.calls[0]).toContain(`fields=${encodeURIComponent(LAUNCH_FIELDS.join(','))}`)
    expect(f.calls[0]).toContain('sort=-created_at_millis')
    expect(f.calls[0]).toContain('created_after_millis=1791500000000')
    expect(r.height).toBe(220147172)
    const first = r.tokens[0]
    expect(first).toMatchObject({ token: 'rear-3.nearlytrade.near', symbol: 'REAR', decimals: 18, createdHeight: 220145072, dev: 'guglch.near', reputation: 'Unknown' })
    expect(typeof first?.liquidityUsd).toBe('number')
    expect(typeof first?.priceUsd).toBe('number')
    // Absent figures stay null, never zero.
    expect(r.tokens.some((t) => t.priceChange24h === null)).toBe(true)
  })

  it('trades: oldest-first pages with the cursor, as raw legs', async () => {
    const f = fakeFetch(() => ({ body: trades }))
    const r = await client(f).trades({ afterMillis: 1, cursor: 'c1', order: 'oldest', limit: 200 })
    expect(f.calls[0]).toContain('order=oldest')
    expect(f.calls[0]).toContain('cursor=c1')
    expect(f.calls[0]).toContain('after_millis=1')
    expect(r.rows[0]).toMatchObject({
      id: 7163845,
      height: 220147164,
      trader: expect.any(String),
      tokenIn: expect.any(String),
      amountIn: expect.stringMatching(/^\d+$/),
      usd: expect.any(Number),
    })
    expect(r.nextCursor).toBe(trades.next_cursor)
  })

  it('holders: the largest balances and the total', async () => {
    const f = fakeFetch(() => ({ body: holders }))
    const r = await client(f).holders('kits.nearlytrade.near', 5)
    expect(r.rows[0]).toEqual({ account: 'dclv2.ref-labs.near', balance: '682231872707609503014725206' })
    expect(r.rows).toHaveLength(5)
  })

  it('candles: closes per token, oldest first', async () => {
    const f = fakeFetch(() => ({ body: candles }))
    const r = await client(f).closes(['kits.nearlytrade.near', 'blackdragon.tkn.near'], '60', 4)
    expect(f.calls[0]).toContain('tokens=kits.nearlytrade.near%2Cblackdragon.tkn.near')
    expect(r.get('kits.nearlytrade.near')?.time).toHaveLength(4)
    expect(r.get('kits.nearlytrade.near')?.close[0]).toBeCloseTo(0.0000118156)
  })

  it('one request at a time', async () => {
    const f = fakeFetch(() => ({ body: holders }))
    const c = client(f)
    await Promise.all([c.holders('a.near', 5), c.holders('b.near', 5), c.holders('c.near', 5)])
    expect(f.maxInFlight()).toBe(1)
  })

  it('an error keeps Intear’s status and code; a 429 is told apart', async () => {
    const bad = fakeFetch(() => ({ status: 400, body: { error: { code: 'bad_request', message: 'missing field `fields`' } } }))
    await expect(client(bad).holders('x.near', 5)).rejects.toMatchObject({ status: 400, code: 'bad_request' })
    const busy = fakeFetch(() => ({ status: 429, body: {} }))
    const e = await client(busy)
      .holders('x.near', 5)
      .catch((x: unknown) => x)
    expect(e).toBeInstanceOf(IntearError)
    expect((e as IntearError).rateLimited).toBe(true)
  })
})
