import { describe, expect, it } from 'vitest'
import { aggregatorFee, feeTokenFor, trueMinimum } from './fees'

const WHITELIST = new Set(['wrap.near', 'usdt.tether-token.near'])

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

describe('aggregatorFee: appFeeRate=200 (20000 ppm), protocol 1000 ppm, Rhea keeps 20% of the app fee', () => {
  it('splits an input-side fee exactly: user pays 2.00%, NearKit receives 1.60%, Rhea 0.40%, plus Rhea’s 0.10%', () => {
    const fee = aggregatorFee({ base: 100n * 10n ** 24n, appFeePpm: 20000, protocolFeePpm: 1000, routerShareBps: 2000 })
    expect(fee.app).toBe(2n * 10n ** 24n)
    expect(fee.nearkit).toBe(16n * 10n ** 23n)
    expect(fee.router).toBe(4n * 10n ** 23n)
    expect(fee.protocol).toBe(10n ** 23n)
    expect(fee.nearkit + fee.router).toBe(fee.app)
  })

  it('rounds each share down and never charges more than the rate', () => {
    const fee = aggregatorFee({ base: 999n, appFeePpm: 20000, protocolFeePpm: 1000, routerShareBps: 2000 })
    expect(fee.app).toBe(19n) // 19.98 → 19
    expect(fee.nearkit + fee.router).toBe(fee.app)
    expect(fee.protocol).toBe(0n)
  })
})

describe('trueMinimum', () => {
  it('is the signed minimum when the fee comes off before the last swap', () => {
    expect(trueMinimum(1_000_000n, 'input', 20000, 1000)).toBe(1_000_000n)
    expect(trueMinimum(1_000_000n, 'intermediate', 20000, 1000)).toBe(1_000_000n)
  })
  it('is 2.1% lower when Rhea takes the fees from the output after the DEX checked the minimum', () => {
    expect(trueMinimum(1_000_000n, 'output', 20000, 1000)).toBe(979_000n)
    expect(trueMinimum(999n, 'output', 20000, 1000)).toBe(978n)
  })
})
