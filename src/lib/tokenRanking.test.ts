import { describe, expect, it } from 'vitest'
import type { Holding, TokenListing } from '@/types/domain'
import { heldBalances, holdingTiers, rankTokenList } from './tokenRanking'

/**
 * NEARKITS' one token order, in every picker and search: $KITS, NEAR, what the picker's wallets hold,
 * what the user's other executable wallets hold, popular tokens, then the rest; a search ranks by how
 * closely each token matches first. Tokens are keyed by their contract (two tokens may share a
 * symbol); a missing price never hides a token.
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
const KIT = token('kits.nearlytrade.near', 'KITS', null, 'Near Kits')
const LIST = [NEAR, WNEAR, USDC, USDT, BLACKDRAGON, SHITZU, SING, NEARLY, NEARLY_OTHER]
const WITH_KIT = [...LIST, KIT]
const POPULAR = [USDC.id, USDT.id, BLACKDRAGON.id, SHITZU.id]

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

describe('rankTokenList without a search', () => {
  it('orders $KITS, NEAR, held here, held in the other wallets, popular, then the rest as listed', () => {
    const held = new Map([[SING.id, 1_000_000]])
    const heldElsewhere = new Map([[SHITZU.id, 50]])
    expect(ids(rankTokenList(WITH_KIT, { kitId: KIT.id, held, heldElsewhere, popular: POPULAR }))).toEqual([
      KIT.id,
      NEAR.id,
      SING.id,
      SHITZU.id,
      USDC.id,
      USDT.id,
      BLACKDRAGON.id,
      WNEAR.id,
      NEARLY.id,
      NEARLY_OTHER.id,
    ])
  })

  it('without $KITS listed (a network without it), NEAR leads', () => {
    expect(ids(rankTokenList(LIST, { kitId: null, popular: POPULAR })).slice(0, 3)).toEqual([NEAR.id, USDC.id, USDT.id])
  })

  it('keeps the held-token order: the larger USD value first; held tokens without a price after the priced ones, by balance', () => {
    const held = new Map([
      [USDC.id, 2], // $2
      [SING.id, 1_000_000], // no price
      [NEARLY_OTHER.id, 50], // no price
      [NEARLY.id, 40_000], // $80
    ])
    const ranked = ids(rankTokenList(LIST, { held }))
    expect(ranked.slice(0, 5)).toEqual([NEAR.id, NEARLY.id, USDC.id, SING.id, NEARLY_OTHER.id])
    // Not held anywhere: after every held token, in the list's own order.
    expect(ranked.slice(5)).toEqual([WNEAR.id, USDT.id, BLACKDRAGON.id, SHITZU.id])
  })

  it('puts the selected token at the top, held or not', () => {
    const held = new Map([[SING.id, 1_000_000]])
    expect(ids(rankTokenList(WITH_KIT, { selectedId: USDT.id, kitId: KIT.id, held })).slice(0, 4)).toEqual([USDT.id, KIT.id, NEAR.id, SING.id])
    expect(ids(rankTokenList(WITH_KIT, { selectedId: SING.id, kitId: KIT.id, held })).slice(0, 3)).toEqual([SING.id, KIT.id, NEAR.id])
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
    expect(ids(rankTokenList([b, c, a], { held }))).toEqual([a.id, c.id, b.id])
  })

  it('a token held both here and in another wallet counts as held here', () => {
    const held = new Map([[USDT.id, 5]])
    const heldElsewhere = new Map([
      [USDT.id, 9],
      [SHITZU.id, 1],
    ])
    expect(ids(rankTokenList(LIST, { held, heldElsewhere })).slice(0, 3)).toEqual([NEAR.id, USDT.id, SHITZU.id])
  })
})

describe('rankTokenList with a search', () => {
  it('relevance wins: "USDC" finds USDC first, whatever $KITS, NEAR or the wallets hold', () => {
    const held = new Map([[SING.id, 1_000_000]])
    expect(ids(rankTokenList(WITH_KIT, { query: 'USDC', kitId: KIT.id, held, popular: POPULAR }))[0]).toBe(USDC.id)
    expect(ids(rankTokenList(WITH_KIT, { query: 'usd', kitId: KIT.id, held, popular: POPULAR }))).toEqual([USDC.id, USDT.id])
  })

  it('finds $KITS by "$KITS", "KITS", "Near Kits" and its contract', () => {
    for (const query of ['$KITS', 'KITS', 'kits', 'Near Kits', 'kits.nearlytrade.near']) expect(ids(rankTokenList(WITH_KIT, { query, kitId: KIT.id }))[0], query).toBe(KIT.id)
  })

  it('searches every token, held or not; for an equally close match, held first', () => {
    const held = new Map([[NEARLY_OTHER.id, 50]])
    expect(ids(rankTokenList(LIST, { query: 'nearly', held }))).toEqual([NEARLY_OTHER.id, NEARLY.id, SING.id])
    expect(ids(rankTokenList(LIST, { query: 'shitzu', held }))).toEqual([SHITZU.id])
  })

  it('finds a token by its exact contract (not its symbol)', () => {
    expect(ids(rankTokenList(LIST, { query: 'singularty.nearlytrade.near' }))).toEqual([SING.id])
    expect(ids(rankTokenList(LIST, { query: 'nearly-10.nearlytrade.near' }))[0]).toBe(NEARLY_OTHER.id)
  })

  it('a selected token that doesn’t match the search isn’t forced into the results', () => {
    expect(ids(rankTokenList(LIST, { query: 'usdt', selectedId: SING.id, held: new Map([[SING.id, 1]]) }))).toEqual([USDT.id])
  })
})

describe('holdingTiers', () => {
  const wallets = [
    { id: 'main', source: 'nearkit' as const },
    { id: 'sniper', source: 'nearkit' as const },
    { id: 'hot', source: 'external' as const },
    { id: 'watched', source: 'watch' as const },
    { id: 'watched-too', source: 'external' as const, access: 'watch' as const },
  ]
  const holdings = [hold('main', SING.id, 10), hold('sniper', SHITZU.id, 3), hold('hot', USDC.id, 4), hold('watched', NEARLY.id, 99), hold('watched-too', USDT.id, 1)]

  it('splits what the picker’s wallets hold from what the other executable wallets hold', () => {
    const t = holdingTiers(holdings, wallets, ['main'])
    expect(t.held).toEqual(new Map([[SING.id, 10]]))
    expect(t.heldElsewhere).toEqual(
      new Map([
        [SHITZU.id, 3],
        [USDC.id, 4],
      ]),
    )
  })

  it('never counts a watch-only wallet, not even when a picker names it', () => {
    const t = holdingTiers(holdings, wallets, ['watched'])
    expect(t.held.size).toBe(0)
    expect([...t.heldElsewhere.keys()]).not.toContain(NEARLY.id)
    expect([...t.heldElsewhere.keys()]).not.toContain(USDT.id)
  })

  it('with no picker wallets, everything executable is "held"', () => {
    const t = holdingTiers(holdings, wallets, null)
    expect(t.held).toEqual(
      new Map([
        [SING.id, 10],
        [SHITZU.id, 3],
        [USDC.id, 4],
      ]),
    )
    expect(t.heldElsewhere.size).toBe(0)
  })
})
