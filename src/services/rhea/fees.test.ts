import { describe, expect, it } from 'vitest'
import { NEARKIT_FEE_BPS } from '@/lib/fees'
import { aggregatorFee, feeTokenFor, trueMinimum } from './fees'

const WHITELIST = new Set(['wrap.near', 'usdt.tether-token.near'])
/** NearKit's app fee as the aggregator counts it: 50 bps = 5000 ppm. */
const APP_PPM = NEARKIT_FEE_BPS * 100

describe('which token Rhea takes the fee from', () => {
  it('uses the input when it is on the fee whitelist', () => {
    expect(feeTokenFor(['wrap.near', 'blackdragon.tkn.near'], ['wrap.near'], WHITELIST)).toEqual({ token: 'wrap.near', stage: 'input' })
  })
  it('uses a whitelisted token between DEX steps, before the last swap', () => {
    expect(feeTokenFor(['darai.tkn.near', 'wrap.near', 'usdc.near'], ['darai.tkn.near', 'wrap.near'], WHITELIST)).toEqual({ token: 'wrap.near', stage: 'intermediate' })
  })
  it('falls back to the output token', () => {
    expect(feeTokenFor(['blackdragon.tkn.near', 'wrap.near'], ['blackdragon.tkn.near'], WHITELIST)).toEqual({ token: 'wrap.near', stage: 'output' })
    expect(feeTokenFor(['a.near', 'b.near'], ['a.near'], WHITELIST)).toEqual({ token: 'b.near', stage: 'output' })
  })
})

describe('aggregatorFee: NEARKITS’ 0.50% (5000 ppm), Rhea’s protocol 1000 ppm, Rhea keeps 20% of the app fee', () => {
  it('splits an input-side fee exactly: user pays 0.50%, NEARKITS receives 0.40%, Rhea 0.10%, plus Rhea’s own 0.10%', () => {
    expect(APP_PPM).toBe(5000)
    const fee = aggregatorFee({ base: 100n * 10n ** 24n, appFeePpm: APP_PPM, protocolFeePpm: 1000, routerShareBps: 2000 })
    expect(fee.app).toBe(5n * 10n ** 23n)
    expect(fee.nearkit).toBe(4n * 10n ** 23n)
    expect(fee.router).toBe(10n ** 23n)
    // Rhea's own fee is separate from NearKit's, never part of it.
    expect(fee.protocol).toBe(10n ** 23n)
    expect(fee.nearkit + fee.router).toBe(fee.app)
  })

  it('rounds each share down and never charges more than the rate', () => {
    const fee = aggregatorFee({ base: 99_999n, appFeePpm: APP_PPM, protocolFeePpm: 1000, routerShareBps: 2000 })
    expect(fee.app).toBe(499n) // 499.995 → 499
    expect(fee.router).toBe(99n) // 99.8 → 99
    expect(fee.nearkit + fee.router).toBe(fee.app)
    expect(fee.protocol).toBe(99n)
  })
})

describe('trueMinimum', () => {
  it('is the signed minimum when the fee comes off before the last swap', () => {
    expect(trueMinimum(1_000_000n, 'input', APP_PPM, 1000)).toBe(1_000_000n)
    expect(trueMinimum(1_000_000n, 'intermediate', APP_PPM, 1000)).toBe(1_000_000n)
  })
  it('is 0.60% lower when Rhea takes both fees from the output after the DEX checked the minimum', () => {
    expect(trueMinimum(1_000_000n, 'output', APP_PPM, 1000)).toBe(994_000n)
    expect(trueMinimum(999n, 'output', APP_PPM, 1000)).toBe(993n)
  })
})
