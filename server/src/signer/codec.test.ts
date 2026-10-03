import { describe, expect, it } from 'vitest'
import type { WalletOperation } from '../custody/policy'
import { decodeOp, encodeOp } from './codec'

/** What the app sends over the wire is exactly what the signer checks: every route fact survives the trip. */
describe('operation codec', () => {
  const direct: WalletOperation = {
    kind: 'swap',
    authorizedMinOut: 17_000n * 10n ** 18n,
    route: {
      router: 'dcl',
      routeIn: 'wrap.near',
      routeOut: 'singularty.nearlytrade.near',
      nativeIn: true,
      nativeOut: false,
      amountIn: 10n ** 24n,
      receiver: 'dclv2.ref-labs.near',
      msg: '{"Swap":{"pool_ids":["singularty.nearlytrade.near|wrap.near|10000"],"output_token":"singularty.nearlytrade.near","min_output_amount":"17000000000000000000000"}}',
      routeTokens: ['wrap.near', 'singularty.nearlytrade.near'],
      minOut: 17_000n * 10n ** 18n,
      pools: ['singularty.nearlytrade.near|wrap.near|10000'],
      direct: { swapAmount: 995n * 10n ** 21n, fee: 5n * 10n ** 21n, feeRecipient: 'nearkitfee.near' },
    },
  }
  const trip = (op: WalletOperation) => decodeOp(JSON.parse(JSON.stringify(encodeOp(op))) as unknown)

  it('round-trips a direct DCL route with its pools and fee, on mainnet and (fee-less) on testnet', () => {
    expect(trip(direct)).toEqual(direct)
    const testnet: WalletOperation = { ...direct, route: { ...direct.route, direct: { swapAmount: 10n ** 24n, fee: 0n, feeRecipient: null } } }
    expect(trip(testnet)).toEqual(testnet)
  })

  it('round-trips an aggregator route with its signed minimum, and no pools', () => {
    const agg: WalletOperation = {
      kind: 'swap',
      authorizedMinOut: 1n,
      route: { ...direct.route, router: 'aggregator', receiver: 'aggregatedex.near', msg: '{"msg":"x","signature":"y"}', signedMin: 1n, pools: undefined, direct: undefined },
    }
    const back = trip(agg)
    expect(back).toEqual({ ...agg, route: { ...agg.route, pools: undefined, direct: undefined } })
    expect(back.kind === 'swap' && 'pools' in back.route).toBe(false)
  })

  it('refuses more pools than a route may have, a fee that is not a whole number, an incomplete fee, or an unknown router', () => {
    const enc = encodeOp(direct) as { route: Record<string, unknown> }
    expect(() => decodeOp({ ...enc, route: { ...enc.route, pools: ['a|b|100', 'b|c|100', 'c|d|100', 'd|e|100'] } })).toThrow()
    expect(() => decodeOp({ ...enc, route: { ...enc.route, direct: { swapAmount: '1', fee: '-1', feeRecipient: null } } })).toThrow()
    expect(() => decodeOp({ ...enc, route: { ...enc.route, direct: { swapAmount: '1', fee: '1' } } })).toThrow()
    expect(() => decodeOp({ ...enc, route: { ...enc.route, router: 'uniswap' } })).toThrow(/router/)
  })
})
