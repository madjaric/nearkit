import { describe, expect, it } from 'vitest'
import type { DclPool } from './pools'
import { dclImpactPct, dclMidRate } from './impact'

/**
 * Price impact on DCL v2: how far a trade's own execution price falls short of the pools' price just
 * before it ("how far your own order moves the pool price"). Both prices come from the very pools the
 * trade runs through, read in the same quote: the mid price at each pool's current point, less that
 * pool's fee, against what the pools pay for what they receive. NEARKITS' fee and a token's own tax are
 * outside the pools' amounts, so they are never counted as impact, and no USD price list is involved.
 */

const KITS = 'kits.nearlytrade.near'
const WRAP = 'wrap.near'
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
const pool = (over: Partial<DclPool> = {}): DclPool => ({
  id: `${KITS}|${WRAP}|10000`,
  tokenX: KITS,
  tokenY: WRAP,
  fee: 10000,
  liquidity: 10n ** 22n,
  running: true,
  point: 5299,
  ...over,
})
/** wNEAR raw per KITS raw at point 5299 (X = KITS, Y = wNEAR): 1.0001^5299. */
const MID = Math.pow(1.0001, 5299)

describe('the pools’ price before the trade', () => {
  it('is 1.0001^point of Y per X in raw units, and its inverse the other way', () => {
    expect(dclMidRate(pool(), KITS)).toBeCloseTo(MID, 12)
    expect(dclMidRate(pool(), WRAP)).toBeCloseTo(1 / MID, 12)
    // As people read it: 1 NEAR ≈ 588,679 KITS at point 5299 (the live pool on 2026-10-12).
    expect(((dclMidRate(pool(), WRAP) as number) * 10 ** 24) / 10 ** 18).toBeCloseTo(588_679, -1)
  })

  it('is unknown without the pool’s point, or for a token that isn’t the pool’s', () => {
    expect(dclMidRate(pool({ point: null }), WRAP)).toBeNull()
    expect(dclMidRate(pool(), USDC)).toBeNull()
  })
})

describe('price impact of a DCL trade', () => {
  it('the live trade of 2026-10-12: 0.332845 NEAR in (0.5% to NEARKITS first) → 192,964.39 KITS from the pool is about 0.02%, not 22%', () => {
    const poolIn = 331_180_775_000_000_000_000_000n // 0.332845 NEAR less NEARKITS' 0.5%
    const poolOut = 192_964_390_000_000_000_000_000n // what the pool paid, before KITS' 2% buy tax
    const impact = dclImpactPct([{ pool: pool(), tokenIn: WRAP }], poolIn, poolOut)
    expect(impact).not.toBeNull()
    expect(impact as number).toBeGreaterThan(0)
    expect(impact as number).toBeLessThan(0.1)
  })

  it('normal and high impact: the shortfall of the execution price against the pool’s marginal price (mid less its fee)', () => {
    const poolIn = 10n ** 24n
    const marginalOut = (1 / MID) * 0.99 * 1e24
    expect(dclImpactPct([{ pool: pool(), tokenIn: WRAP }], poolIn, BigInt(Math.round(marginalOut * 0.995)))).toBeCloseTo(0.5, 6)
    expect(dclImpactPct([{ pool: pool(), tokenIn: WRAP }], poolIn, BigInt(Math.round(marginalOut * 0.7)))).toBeCloseTo(30, 6)
  })

  it('the pool’s own fee is not impact: a trade filled at the marginal price has none, on any fee tier', () => {
    for (const fee of [100, 400, 2000, 10000]) {
      const out = BigInt(Math.round((1 / MID) * (1 - fee / 1e6) * 1e24))
      expect(dclImpactPct([{ pool: pool({ fee }), tokenIn: WRAP }], 10n ** 24n, out)).toBeCloseTo(0, 6)
    }
  })

  it('decimals: the same impact selling KITS (18 decimals) for wNEAR (24) as buying', () => {
    const kitsIn = 100_000n * 10n ** 18n
    const out = BigInt(Math.round(100_000 * 1e18 * MID * 0.99 * 0.98))
    expect(dclImpactPct([{ pool: pool(), tokenIn: KITS }], kitsIn, out)).toBeCloseTo(2, 6)
  })

  it('two hops multiply their marginal prices (wNEAR → USDC → KITS)', () => {
    const a: DclPool = { id: `${USDC}|${WRAP}|400`, tokenX: USDC, tokenY: WRAP, fee: 400, liquidity: 1n, running: true, point: 100_000 }
    const b: DclPool = { id: `${USDC}|${KITS}|2000`, tokenX: USDC, tokenY: KITS, fee: 2000, liquidity: 1n, running: true, point: 300_000 }
    const marginal = (1 / Math.pow(1.0001, 100_000)) * (1 - 400 / 1e6) * Math.pow(1.0001, 300_000) * (1 - 2000 / 1e6)
    const out = BigInt(Math.round(1e24 * marginal * 0.9))
    expect(
      dclImpactPct(
        [
          { pool: a, tokenIn: WRAP },
          { pool: b, tokenIn: USDC },
        ],
        10n ** 24n,
        out,
      ),
    ).toBeCloseTo(10, 4)
  })

  it('missing or mismatched data gives no figure (unknown), never a guess', () => {
    expect(dclImpactPct([{ pool: pool({ point: null }), tokenIn: WRAP }], 10n ** 24n, 10n ** 23n)).toBeNull()
    expect(dclImpactPct([{ pool: pool(), tokenIn: USDC }], 10n ** 24n, 10n ** 23n)).toBeNull()
    expect(dclImpactPct([], 10n ** 24n, 10n ** 23n)).toBeNull()
    expect(dclImpactPct([{ pool: pool(), tokenIn: WRAP }], 0n, 10n ** 23n)).toBeNull()
    expect(dclImpactPct([{ pool: pool(), tokenIn: WRAP }], 10n ** 24n, 0n)).toBeNull()
  })

  it('a fill at or above the marginal price (rounding) is 0, never negative', () => {
    const out = BigInt(Math.round((1 / MID) * 0.99 * 1e24 * 1.000001))
    expect(dclImpactPct([{ pool: pool(), tokenIn: WRAP }], 10n ** 24n, out)).toBe(0)
    // Within a tick: the pool's price sits anywhere inside its current point's tick.
    const inTick = BigInt(Math.round((1 / MID) * 0.99 * 1e24 * 1.00009))
    expect(dclImpactPct([{ pool: pool(), tokenIn: WRAP }], 10n ** 24n, inTick)).toBe(0)
  })

  it('stale pool data: a fill better than the pool’s price by more than a tick means the point read isn’t the pool the quote ran on, so unknown', () => {
    const out = BigInt(Math.round((1 / MID) * 0.99 * 1e24 * 1.01))
    expect(dclImpactPct([{ pool: pool(), tokenIn: WRAP }], 10n ** 24n, out)).toBeNull()
    // The same quote against the point it really ran at measures normally.
    expect(dclImpactPct([{ pool: pool({ point: 5299 - 100 }), tokenIn: WRAP }], 10n ** 24n, out)).not.toBeNull()
  })
})
