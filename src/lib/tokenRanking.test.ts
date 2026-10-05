import { describe, expect, it } from 'vitest'
import type { Holding, TokenListing } from '@/types/domain'
import { heldBalances, rankByHoldings } from './tokenRanking'

/**
 * A wallet-aware token picker: what the wallets hold comes first, then everything else. Tokens are
 * keyed by their contract (two tokens may share a symbol); a missing price never hides a token.
 */

const token = (id: string, symbol: string, priceUsd: number | null = null, name = symbol): TokenListing => ({
  id,
  symbol,
  name,
  decimals: 18,
  contract: id === 'near' ? null : id,
  status: 'listed',
  market: priceUsd === null ? null : { tokenId: id, priceUsd, priceNear: 0, change24hPct: null, liquidityUsd: null, volume24hUsd: null, updatedAt: 0 },
})

// The static order a list arrives in: NEAR, then the configured tokens, then the rest.
const NEAR = token('near', 'NEAR', 5)
const WNEAR = token('wrap.near', 'wNEAR', 5)
const USDC = token('usdc.example.near', 'USDC', 1)
const USDT = token('usdt.tether-token.near', 'USDt', 1)
const BLACKDRAGON = token('blackdragon.tkn.near', 'BLACKDRAGON', 0.0000001)
const SHITZU = token('token.0xshitzu.near', 'SHITZU', 0.01)
const SING = token('singularty.nearlytrade.near', 'SINGULARTY', null, 'Singularity is NEAR')
const NEARLY = token('nearly-2.nearlytrade.near', 'NEARLY', 0.002, 'Not early. Nearly.')
const NEARLY_OTHER = token('nearly-10.nearlytrade.near', 'NEARLY', null, 'NEARLY')
const LIST = [NEAR, WNEAR, USDC, USDT, BLACKDRAGON, SHITZU, SING, NEARLY, NEARLY_OTHER]

const hold = (walletId: string, tokenId: string, amount: number): Holding => ({ walletId, tokenId, amount, raw: '1', verified: true })
const ids = (list: readonly TokenListing[]) => list.map((t) => t.id)

describe('heldBalances', () => {
  const holdings = [hold('A', SING.id, 1_000_000), hold('B', SING.id, 250_000), hold('B', NEARLY.id, 40_000), hold('W', SHITZU.id, 9), hold('A', USDC.id, 0)]

  it('a token held only in wallet A, or only in wallet B, is held; one held in both is one entry with the sum', () => {
    expect(heldBalances(holdings, ['A'])).toEqual(new Map([[SING.id, 1_000_000]]))
    expect(heldBalances(holdings, ['B'])).toEqual(
      new Map([
        [SING.id, 250_000],
        [NEARLY.id, 40_000],
      ]),
    )
    expect(heldBalances(holdings, ['A', 'B'])).toEqual(
      new Map([
        [SING.id, 1_250_000],
        [NEARLY.id, 40_000],
      ]),
    )
  })

  it('counts only the wallets asked about (a watch-only wallet left out stays out) and never a zero balance', () => {
    expect(heldBalances(holdings, ['A', 'B']).has(SHITZU.id)).toBe(false)
    expect(heldBalances(holdings, ['A']).has(USDC.id)).toBe(false)
    expect(heldBalances(holdings, []).size).toBe(0)
  })

  it('keys by contract: two tokens sharing a symbol stay two tokens', () => {
    const both = heldBalances([hold('A', NEARLY.id, 5), hold('B', NEARLY_OTHER.id, 7), hold('B', NEARLY.id, 1)], ['A', 'B'])
    expect(both).toEqual(
      new Map([
        [NEARLY.id, 6],
        [NEARLY_OTHER.id, 7],
      ]),
    )
  })
})

describe('rankByHoldings (no search)', () => {
  it('held tokens first, then the ones not held in the order the list had them', () => {
    const held = new Map([[SING.id, 1_000_000]])
    expect(ids(rankByHoldings(LIST, { query: '', selectedId: null, held }))).toEqual([
      SING.id,
      NEAR.id,
      WNEAR.id,
      USDC.id,
      USDT.id,
      BLACKDRAGON.id,
      SHITZU.id,
      NEARLY.id,
      NEARLY_OTHER.id,
    ])
  })

  it('among held tokens: the larger USD value first; a token without a price stays in the held section, after the priced ones, by balance', () => {
    const held = new Map([
      [USDC.id, 2], // $2
      [NEAR.id, 3], // $15
      [SING.id, 1_000_000], // no price
      [NEARLY_OTHER.id, 50], // no price
      [NEARLY.id, 40_000], // $80
    ])
    const ranked = ids(rankByHoldings(LIST, { query: '', selectedId: null, held }))
    expect(ranked.slice(0, 5)).toEqual([NEARLY.id, NEAR.id, USDC.id, SING.id, NEARLY_OTHER.id])
    // Not held: after every held token, unmoved.
    expect(ranked.slice(5)).toEqual([WNEAR.id, USDT.id, BLACKDRAGON.id, SHITZU.id])
  })

  it('the selected token stays at the top, held or not', () => {
    const held = new Map([[SING.id, 1_000_000]])
    expect(ids(rankByHoldings(LIST, { query: '', selectedId: USDT.id, held })).slice(0, 2)).toEqual([USDT.id, SING.id])
    expect(ids(rankByHoldings(LIST, { query: '', selectedId: SING.id, held })).slice(0, 2)).toEqual([SING.id, NEAR.id])
  })

  it('is deterministic: equal values fall back to the symbol, then the contract', () => {
    const a = token('a.near', 'AAA', null)
    const b = token('b.near', 'BBB', null)
    const c = token('c.near', 'AAA', null)
    const held = new Map([
      [b.id, 10],
      [a.id, 10],
      [c.id, 10],
    ])
    expect(ids(rankByHoldings([b, c, a], { query: '', selectedId: null, held }))).toEqual([a.id, c.id, b.id])
  })

  it('nothing held: the list as it came (the selected one first)', () => {
    expect(ids(rankByHoldings(LIST, { query: '', selectedId: null, held: new Map() }))).toEqual(ids(LIST))
  })
})

describe('rankByHoldings (search)', () => {
  it('searches every token, held or not: the closest match first, held before not held for an equally close match', () => {
    const held = new Map([[NEARLY_OTHER.id, 50]])
    // "nearly": both NEARLY tokens match exactly by symbol; the held one comes first.
    expect(ids(rankByHoldings(LIST, { query: 'nearly', selectedId: null, held }))).toEqual([NEARLY_OTHER.id, NEARLY.id, SING.id])
    // A token nobody holds is still found.
    expect(ids(rankByHoldings(LIST, { query: 'shitzu', selectedId: null, held }))).toEqual([SHITZU.id])
    expect(ids(rankByHoldings(LIST, { query: 'usd', selectedId: null, held }))).toEqual([USDC.id, USDT.id])
  })

  it('finds a token by its exact contract (not its symbol)', () => {
    expect(ids(rankByHoldings(LIST, { query: 'singularty.nearlytrade.near', selectedId: null, held: new Map() }))).toEqual([SING.id])
    expect(ids(rankByHoldings(LIST, { query: 'nearly-10.nearlytrade.near', selectedId: null, held: new Map() }))[0]).toBe(NEARLY_OTHER.id)
  })

  it('a selected token that doesn’t match the search isn’t forced into the results', () => {
    expect(ids(rankByHoldings(LIST, { query: 'usdt', selectedId: SING.id, held: new Map([[SING.id, 1]]) }))).toEqual([USDT.id])
  })
})
