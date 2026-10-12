import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerNear } from '../near'
import { renderBuy, type BuyView } from './format'
import { createBuyMarket } from './market'

/**
 * The holder count in buy alerts. NearBlocks' `GET /v1/fts/{contract}/holders/count` answers
 * `{"holders":[{"count":"<n>"}]}`: the accounts its FT index records with a balance above zero. Its index
 * can lack a token entirely: for $KITS (kits.nearlytrade.near) on 2026-10-12 it answered count "0" and an
 * empty holder list while the chain showed 995,746,521 KITS in supply, 775,331,913 of them in the DCL
 * pool alone. A token with supply above zero has at least one holder, so a 0 there is NearBlocks not
 * knowing, not a fact: the alert says the count is unavailable. A 0 is shown only when the token's own
 * supply is 0 too. Any other failure (an error, a rate limit, a timeout, an unreadable answer) is
 * unavailable as well, never a number.
 */

const KITS = 'kits.nearlytrade.near'
const NEARBLOCKS = 'https://api.nearblocks.io'
const KITS_SUPPLY = 995_746_521_273_196_823_497_484_000n

type Answer = (url: string, init?: RequestInit) => Promise<Response> | Response
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function market(answer: Answer, supply: bigint | 'fails' = KITS_SUPPLY) {
  const calls: string[] = []
  let t = 1_000_000
  const near = {
    ctx: {
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        calls.push(String(input))
        return answer(String(input), init)
      },
      network: { discovery: { nearblocksUrl: NEARBLOCKS }, wrapContract: 'wrap.near' },
      reader: {
        totalSupply: async () => {
          if (supply === 'fails') throw new Error('RPC down')
          return supply
        },
      },
    },
  } as unknown as ServerNear
  return { m: createBuyMarket(near, () => t), calls, advance: (ms: number) => void (t += ms) }
}

afterEach(() => vi.useRealTimers())

describe('NearBlocks’ holder count', () => {
  it('asks for exactly this token’s count and reads it, as a string or a number', async () => {
    const a = market(() => json({ holders: [{ count: '286262' }] }))
    expect(await a.m.holders(KITS)).toBe(286_262)
    expect(a.calls).toEqual([`${NEARBLOCKS}/v1/fts/${KITS}/holders/count`])
    expect(await market(() => json({ holders: [{ count: 12 }] })).m.holders(KITS)).toBe(12)
  })

  it('a genuine zero: NearBlocks says 0 and the token’s own supply is 0', async () => {
    expect(await market(() => json({ holders: [{ count: '0' }] }), 0n).m.holders(KITS)).toBe(0)
  })

  it('$KITS on 2026-10-12: NearBlocks says 0 while the chain has 995.7M KITS in supply, so the count is unavailable, not 0', async () => {
    expect(await market(() => json({ holders: [{ count: '0' }] }), KITS_SUPPLY).m.holders(KITS)).toBeNull()
    // With the supply unreadable too, a 0 can't be confirmed either.
    expect(await market(() => json({ holders: [{ count: '0' }] }), 'fails').m.holders(KITS)).toBeNull()
  })

  it('missing fields, an empty answer or an unreadable count: unavailable', async () => {
    for (const body of [
      {},
      { holders: [] },
      { holders: [{}] },
      { holders: [{ count: 'lots' }] },
      { holders: [{ count: -1 }] },
      { data: null, errors: [{ message: 'Server Error' }] },
    ])
      expect(await market(() => json(body)).m.holders(KITS)).toBeNull()
    expect(await market(() => new Response('', { status: 200 })).m.holders(KITS)).toBeNull()
  })

  it('an error or a rate limit (HTTP 500, 429): unavailable', async () => {
    expect(await market(() => json({ data: null, errors: [{ message: 'Server Error' }] }, 500)).m.holders(KITS)).toBeNull()
    expect(await market(() => json({ message: 'Too Many Requests' }, 429)).m.holders(KITS)).toBeNull()
  })

  it('NearBlocks taking longer than 5 seconds: unavailable, and the alert isn’t held for it', async () => {
    vi.useFakeTimers()
    const slow = market(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    const pending = slow.m.holders(KITS)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await pending).toBeNull()
  })

  it('a count is kept 10 minutes; an unavailable one is asked again after a minute', async () => {
    let answer: unknown = { holders: [{ count: '5' }] }
    const a = market(() => json(answer))
    expect(await a.m.holders(KITS)).toBe(5)
    answer = { holders: [{ count: '6' }] }
    a.advance(9 * 60_000)
    expect(await a.m.holders(KITS)).toBe(5)
    a.advance(2 * 60_000)
    expect(await a.m.holders(KITS)).toBe(6)
    const b = market(() => json({ holders: [{ count: '0' }] }))
    expect(await b.m.holders(KITS)).toBeNull()
    await Promise.resolve()
    b.advance(61_000)
    await b.m.holders(KITS)
    expect(b.calls).toHaveLength(2)
  })
})

describe('the alert’s holders line', () => {
  const view = (holders: BuyView['holders']): BuyView => ({
    side: 'buy',
    symbol: 'KITS',
    name: 'Near Kits',
    token: KITS,
    decimals: 18,
    amount: 10n ** 21n,
    paid: [{ text: '1 NEAR' }],
    paidUsd: 5,
    valueNear: 10n ** 24n,
    paidInNear: true,
    buyer: 'buyer.near',
    buyerUrl: 'https://nearblocks.io/address/buyer.near',
    txUrl: 'https://nearblocks.io/txns/abc',
    priceUsd: 0.005,
    marketCapUsd: null,
    fdvUsd: null,
    holders,
    emoji: '🟢',
    emojiCount: 1,
    networkLabel: 'Mainnet',
  })

  it('a count, in its place between the caps and the CA', () => {
    const text = renderBuy(view(286_262))
    expect(text).toContain('👥 Holders 286,262 (NearBlocks)')
    expect(text.indexOf('👥 Holders')).toBeLessThan(text.indexOf('📄 CA'))
  })

  it('a genuine zero is shown as 0', () => {
    expect(renderBuy(view(0))).toContain('👥 Holders 0 (NearBlocks)')
  })

  it('unavailable says so, in the same place, and never shows a number', () => {
    const text = renderBuy(view('unavailable'))
    expect(text).toContain('👥 Holders unavailable (NearBlocks)')
    expect(text).not.toMatch(/Holders \d/)
    expect(text.indexOf('👥 Holders')).toBeLessThan(text.indexOf('📄 CA'))
  })

  it('not asked (a layout preview): no holders line', () => {
    expect(renderBuy(view(null))).not.toContain('Holders')
  })
})
