import { describe, expect, it } from 'vitest'
import { actionsOf, applyAction, emptyPosition, type Position, type RawTrade, type TokenAction } from './accounting'

/**
 * Top Wallets' accounting (DISCOVERY.md): Intear's swap legs become token actions per wallet and
 * transaction, then a weighted-average-cost position per wallet and token, in USD at each trade's own
 * value. Transfers in, buys before the index and unpriced legs never become profit.
 */

const NEAR = 'wrap.near'
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
const CURRENCY = new Set([NEAR, USDC, 'usdt.tether-token.near'])
const X = 'x.nearlytrade.near'
const Y = 'y.nearlytrade.near'
const B = 'b.meme-cooking.near'

let nextId = 1
const leg = (o: Partial<RawTrade> & Pick<RawTrade, 'tokenIn' | 'amountIn' | 'tokenOut' | 'amountOut'>): RawTrade => ({
  id: nextId++,
  ts: 1_000,
  height: 1,
  trader: 'alice.near',
  poolId: 'REFDCL-x|wrap.near|10000',
  usd: 10,
  tx: `tx${nextId}`,
  ...o,
})

const at = (a: Partial<TokenAction> & Pick<TokenAction, 'side' | 'qty' | 'usd'>): TokenAction => ({ trader: 'alice.near', token: X, ts: 1_000, tx: 't', id: 1, ...a })

/** Applies actions in order from an empty position; returns the last position and every effect. */
function run(actions: TokenAction[]) {
  let p: Position = emptyPosition()
  const effects = actions.map((a) => {
    const r = applyAction(p, a)
    p = r.position
    return r.effect
  })
  return { p, effects }
}

describe('swap legs become token actions per wallet and transaction', () => {
  it('NEAR for a token is a buy at the leg’s USD value; a token for NEAR is a sale', () => {
    expect(actionsOf([leg({ tokenIn: NEAR, amountIn: '1', tokenOut: X, amountOut: '500', usd: 4.5, tx: 'a' })], CURRENCY)).toEqual([
      expect.objectContaining({ trader: 'alice.near', token: X, side: 'buy', qty: 500, usd: 4.5, tx: 'a' }),
    ])
    expect(actionsOf([leg({ tokenIn: X, amountIn: '200', tokenOut: USDC, amountOut: '3', usd: 3, tx: 'b' })], CURRENCY)).toEqual([
      expect.objectContaining({ token: X, side: 'sell', qty: 200, usd: 3 }),
    ])
  })

  it('a token for another token is a sale of one and a purchase of the other, at the same value', () => {
    const acts = actionsOf([leg({ tokenIn: X, amountIn: '100', tokenOut: Y, amountOut: '7', usd: 12, tx: 'c' })], CURRENCY)
    expect(acts.map((a) => [a.side, a.token, a.qty, a.usd])).toEqual([
      ['sell', X, 100, 12],
      ['buy', Y, 7, 12],
    ])
  })

  it('a route through an intermediate token nets out: A → B → C in one transaction sells A and buys C, nothing in B', () => {
    const acts = actionsOf(
      [
        leg({ tokenIn: X, amountIn: '100', tokenOut: B, amountOut: '55', usd: 20, tx: 'r', id: 10 }),
        leg({ tokenIn: B, amountIn: '55', tokenOut: Y, amountOut: '9', usd: 19.8, tx: 'r', id: 11 }),
      ],
      CURRENCY,
    )
    expect(acts.map((a) => [a.side, a.token, a.qty, a.usd])).toEqual([
      ['sell', X, 100, 20],
      ['buy', Y, 9, 19.8],
    ])
  })

  it('a route through NEAR (X → NEAR → Y) is the same sale and purchase', () => {
    const acts = actionsOf(
      [leg({ tokenIn: X, amountIn: '100', tokenOut: NEAR, amountOut: '2', usd: 9, tx: 'n' }), leg({ tokenIn: NEAR, amountIn: '2', tokenOut: Y, amountOut: '40', usd: 9, tx: 'n' })],
      CURRENCY,
    )
    expect(acts.map((a) => [a.side, a.token])).toEqual([
      ['sell', X],
      ['buy', Y],
    ])
  })

  it('currency for currency (NEAR ↔ USDC) is not a token trade; liquidity rows (no amounts) are skipped', () => {
    expect(actionsOf([leg({ tokenIn: NEAR, amountIn: '1', tokenOut: USDC, amountOut: '4', tx: 'cc' })], CURRENCY)).toEqual([])
    expect(actionsOf([leg({ tokenIn: null, amountIn: null, tokenOut: null, amountOut: null, tx: 'lp' })], CURRENCY)).toEqual([])
  })

  it('the same transaction by two wallets stays two wallets’ trades; an unpriced leg keeps a null value', () => {
    const acts = actionsOf(
      [
        leg({ trader: 'a.near', tokenIn: NEAR, amountIn: '1', tokenOut: X, amountOut: '5', tx: 'same' }),
        leg({ trader: 'b.near', tokenIn: NEAR, amountIn: '1', tokenOut: X, amountOut: '6', usd: null, tx: 'same' }),
      ],
      CURRENCY,
    )
    expect(acts.map((a) => [a.trader, a.qty, a.usd])).toEqual([
      ['a.near', 5, 10],
      ['b.near', 6, null],
    ])
  })

  it('huge raw amounts (24 decimals) are netted exactly before they become numbers', () => {
    const big = '983045162211753390054894'
    const acts = actionsOf(
      [
        leg({ tokenIn: X, amountIn: '57946846802226780008023', tokenOut: NEAR, amountOut: big, usd: 5.2, tx: 'big' }),
        leg({ tokenIn: NEAR, amountIn: big, tokenOut: Y, amountOut: '1', usd: 5.2, tx: 'big' }),
      ],
      CURRENCY,
    )
    expect(acts.map((a) => a.token)).toEqual([X, Y])
    expect(acts[0]?.qty).toBeCloseTo(5.794684680222678e22, -8)
  })
})

describe('the average-cost position', () => {
  it('buy then sell everything at a profit: realized, a winning closed trade, the holding time, and the position closes', () => {
    const { p, effects } = run([at({ side: 'buy', qty: 100, usd: 10, ts: 1_000 }), at({ side: 'sell', qty: 100, usd: 15, ts: 61_000 })])
    expect(effects[1]).toMatchObject({ realized: 5, costClosed: 10, closed: 1, win: 1, gain: 5, loss: 0, unmatchedUsd: 0, holdMs: 60_000 })
    expect(p).toMatchObject({ qty: 0, cost: 0, unknownQty: 0, openSince: null, realized: 5, closed: 1, wins: 1, holds: 1, holdMs: 60_000 })
  })

  it('partial sales use the average cost of everything bought', () => {
    const { p, effects } = run([
      at({ side: 'buy', qty: 100, usd: 10 }),
      at({ side: 'buy', qty: 100, usd: 30 }), // average 0.2 per unit
      at({ side: 'sell', qty: 50, usd: 5 }), // cost 10 → loss 5
    ])
    expect(effects[2]).toMatchObject({ realized: -5, costClosed: 10, closed: 1, win: 0, loss: 5, holdMs: null })
    expect(p.qty).toBe(150)
    expect(p.cost).toBeCloseTo(30)
  })

  it('a sale with no indexed purchase (a transfer in, a buy before the index) is unmatched: no profit, no closed trade', () => {
    const { p, effects } = run([at({ side: 'sell', qty: 40, usd: 25 })])
    expect(effects[0]).toMatchObject({ realized: 0, costClosed: 0, closed: 0, win: 0, unmatchedUsd: 25, sellUsd: 25 })
    expect(p.realized).toBe(0)
  })

  it('selling more than was bought: the bought part is realized, the rest is unmatched', () => {
    const { effects } = run([at({ side: 'buy', qty: 100, usd: 10 }), at({ side: 'sell', qty: 200, usd: 40 })])
    expect(effects[1]).toMatchObject({ realized: 10, costClosed: 10, closed: 1, win: 1, unmatchedUsd: 20 })
  })

  it('an unpriced buy adds units of unknown cost; selling them is unmatched, never profit', () => {
    const { effects } = run([at({ side: 'buy', qty: 100, usd: null }), at({ side: 'sell', qty: 100, usd: 50 })])
    expect(effects[0]).toMatchObject({ unpriced: 1 })
    expect(effects[1]).toMatchObject({ realized: 0, closed: 0, unmatchedUsd: 50 })
  })

  it('an unpriced sale removes the units and their cost without a result', () => {
    const { p, effects } = run([at({ side: 'buy', qty: 100, usd: 10 }), at({ side: 'sell', qty: 50, usd: null })])
    expect(effects[1]).toMatchObject({ realized: 0, closed: 0, unpriced: 1, unmatchedUsd: 0 })
    expect(p.qty).toBe(50)
    expect(p.cost).toBeCloseTo(5)
  })

  it('dust left after a sale (under a millionth) closes the position', () => {
    const { p, effects } = run([at({ side: 'buy', qty: 1e24, usd: 10, ts: 0 }), at({ side: 'sell', qty: 1e24 - 1e10, usd: 12, ts: 3_600_000 })])
    expect(effects[1]?.holdMs).toBe(3_600_000)
    expect(p).toMatchObject({ qty: 0, cost: 0, openSince: null })
  })

  it('a break-even sale is a closed trade but not a win', () => {
    const { effects } = run([at({ side: 'buy', qty: 10, usd: 10 }), at({ side: 'sell', qty: 10, usd: 10 })])
    expect(effects[1]).toMatchObject({ closed: 1, win: 0, realized: 0, gain: 0, loss: 0 })
  })
})
