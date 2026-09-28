import { describe, expect, it } from 'vitest'
import twoHop from './fixtures/findpath-testnet-two-hop.json'
import single from './fixtures/findpath-testnet-wrap-usdt.json'
import { classicSwapMsg, findPathUrl, parseFindPath } from './classic'

// Real responses from smartroutertest.refburrow.top/findPath (testnet), saved 2026-09-28.
const ONE = 10n ** 24n

describe('findPath (classic router, testnet)', () => {
  it('builds the request the router expects', () => {
    const url = new URL(
      findPathUrl('https://smartroutertest.refburrow.top/findPath', { tokenIn: 'wrap.testnet', tokenOut: 'usdt.itachicara.testnet', amountIn: ONE, slippage: 0.005 }),
    )
    expect(url.searchParams.get('amountIn')).toBe(ONE.toString())
    expect(url.searchParams.get('pathDeep')).toBe('3')
    expect(url.searchParams.get('slippage')).toBe('0.005')
  })

  it('parses a single-pool route with exact amounts', () => {
    const r = parseFindPath(single, { tokenIn: 'wrap.testnet', tokenOut: 'usdt.itachicara.testnet', amountIn: ONE, slippage: 0.005 })
    expect(r.amountOut).toBe(4039113319885286092760441n)
    expect(r.minAmountOut).toBe(4018917753285859662296638n)
    expect(r.actions).toEqual([
      { pool_id: 1352, token_in: 'wrap.testnet', token_out: 'usdt.itachicara.testnet', amount_in: ONE.toString(), min_amount_out: '4018917753285859662296638' },
    ])
    expect(r.routeTokens).toEqual(['wrap.testnet', 'usdt.itachicara.testnet'])
  })

  it('keeps the input amount only on the first hop of a multi-hop route', () => {
    const r = parseFindPath(twoHop, { tokenIn: 'wrap.testnet', tokenOut: 'rft.tokenfactory.testnet', amountIn: ONE, slippage: 0.005 })
    expect(r.actions).toHaveLength(2)
    expect(r.actions[0]?.amount_in).toBe(ONE.toString())
    expect(r.actions[1]).not.toHaveProperty('amount_in')
    expect(r.actions[1]?.min_amount_out).toBe('1157410516')
    expect(r.minAmountOut).toBe(1157410516n)
    expect(r.routeTokens).toEqual(['wrap.testnet', 'usdc.itachicara.testnet', 'rft.tokenfactory.testnet'])
  })

  it.each([
    ['another input token', { tokenIn: 'usdc.itachicara.testnet' }],
    ['another output token', { tokenOut: 'ref.fakes.testnet' }],
    ['another amount', { amountIn: ONE + 1n }],
  ])('refuses a route for %s', (_, patch) => {
    expect(() => parseFindPath(single, { tokenIn: 'wrap.testnet', tokenOut: 'usdt.itachicara.testnet', amountIn: ONE, slippage: 0.005, ...patch })).toThrow(
      expect.objectContaining({ code: 'QUOTE_REJECTED' }),
    )
  })

  it('refuses a route whose minimum is looser than the chosen slippage', () => {
    expect(() => parseFindPath(single, { tokenIn: 'wrap.testnet', tokenOut: 'usdt.itachicara.testnet', amountIn: ONE, slippage: 0.001 })).toThrow(/slippage/)
  })

  it('reports “no route” as unavailable', () => {
    expect(() =>
      parseFindPath({ result_code: 0, result_data: { routes: [], amount_out: '0' } }, { tokenIn: 'a.testnet', tokenOut: 'b.testnet', amountIn: 1n, slippage: 0.005 }),
    ).toThrow(expect.objectContaining({ code: 'QUOTE_UNAVAILABLE' }))
  })

  it('asks the exchange for native NEAR only when NEAR is the output', () => {
    const r = parseFindPath(single, { tokenIn: 'wrap.testnet', tokenOut: 'usdt.itachicara.testnet', amountIn: ONE, slippage: 0.005 })
    expect(JSON.parse(classicSwapMsg(r, { unwrapNear: false }))).toEqual({ actions: r.actions })
    expect(JSON.parse(classicSwapMsg(r, { unwrapNear: true }))).toEqual({ actions: r.actions, skip_unwrap_near: false })
  })
})
