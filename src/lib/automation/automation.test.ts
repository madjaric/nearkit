import { describe, expect, it } from 'vitest'
import {
  AUTOMATION_MAX_SLIPPAGE,
  parseStrategy,
  tokenOfStrategy,
  validateCopy,
  validateDca,
  validateLimit,
  validateSniper,
  type CopyConfig,
  type LimitConfig,
  type StrategyConfig,
} from './config'
import { formatPrice, meetsTrigger, priceYocto, targetYocto } from './price'

const NOW = 1_800_000_000_000
const KITS = { id: 'kits.nearlytrade.near', symbol: 'KITS', decimals: 18 }
const ONE_NEAR = 10n ** 24n
const ONE_TOKEN = 10n ** 18n

const limit = (patch: Partial<LimitConfig> = {}): LimitConfig => ({
  type: 'limit-buy',
  token: KITS,
  amount: { kind: 'near', value: '1' },
  triggerPriceNear: '0.002',
  slippagePct: 1,
  expiresAt: null,
  ...patch,
})

describe('trigger arithmetic, exact', () => {
  const target = targetYocto('0.002') as bigint
  it('reads a decimal NEAR target as yoctoNEAR per whole token, and refuses what isn’t one', () => {
    expect(target).toBe(2n * 10n ** 21n)
    for (const bad of ['0', '-1', 'abc', '1e3', '0.0000000000000000000000001', '']) expect(targetYocto(bad)).toBeNull()
  })

  it('a limit buy triggers at or below the target, exactly at the boundary', () => {
    // 1 NEAR for 500 tokens = 0.002 NEAR per token: exactly the target.
    expect(meetsTrigger('limit-buy', ONE_NEAR, 500n * ONE_TOKEN, 18, target)).toBe(true)
    // One raw token less for the same NEAR: a hair above the target.
    expect(meetsTrigger('limit-buy', ONE_NEAR, 500n * ONE_TOKEN - 1n, 18, target)).toBe(false)
    expect(meetsTrigger('limit-buy', ONE_NEAR, 600n * ONE_TOKEN, 18, target)).toBe(true)
  })

  it('a limit sell and a take profit trigger at or above the target; a stop loss at or below it', () => {
    // Selling 500 tokens for 1 NEAR: 0.002 exactly.
    for (const t of ['limit-sell', 'take-profit'] as const) {
      expect(meetsTrigger(t, ONE_NEAR, 500n * ONE_TOKEN, 18, target)).toBe(true)
      expect(meetsTrigger(t, ONE_NEAR - 1n, 500n * ONE_TOKEN, 18, target)).toBe(false)
    }
    expect(meetsTrigger('stop-loss', ONE_NEAR, 500n * ONE_TOKEN, 18, target)).toBe(true)
    expect(meetsTrigger('stop-loss', ONE_NEAR + 1n, 500n * ONE_TOKEN, 18, target)).toBe(false)
  })

  it('a quote of nothing never triggers anything', () => {
    for (const t of ['limit-buy', 'limit-sell', 'take-profit', 'stop-loss'] as const) {
      expect(meetsTrigger(t, 0n, ONE_TOKEN, 18, target)).toBe(false)
      expect(meetsTrigger(t, ONE_NEAR, 0n, 18, target)).toBe(false)
    }
    expect(priceYocto(0n, ONE_TOKEN, 18)).toBeNull()
  })

  it('prices read as short decimals for messages', () => {
    expect(formatPrice(priceYocto(ONE_NEAR, 500n * ONE_TOKEN, 18) as bigint)).toBe('0.002')
    expect(formatPrice(3n * ONE_NEAR + ONE_NEAR / 4n)).toBe('3.25')
  })
})

describe('a limit order’s configuration', () => {
  it('a valid limit buy, limit sell, take profit and stop loss', () => {
    expect(validateLimit(limit(), NOW)).toEqual([])
    expect(validateLimit(limit({ type: 'limit-sell', amount: { kind: 'tokens', value: '1000' } }), NOW)).toEqual([])
    expect(validateLimit(limit({ type: 'take-profit', amount: { kind: 'percent', value: 50 } }), NOW)).toEqual([])
    expect(validateLimit(limit({ type: 'stop-loss', amount: { kind: 'percent', value: 100 } }), NOW)).toEqual([])
  })

  it('a buy spends NEAR and a sell spends the token; the amounts are real', () => {
    const fields = (c: LimitConfig) => validateLimit(c, NOW).map((i) => i.field)
    expect(fields(limit({ amount: { kind: 'tokens', value: '5' } }))).toContain('amount')
    expect(fields(limit({ type: 'limit-sell', amount: { kind: 'near', value: '5' } }))).toContain('amount')
    expect(fields(limit({ amount: { kind: 'near', value: '0.01' } }))).toContain('amount')
    expect(fields(limit({ type: 'stop-loss', amount: { kind: 'percent', value: 0 } }))).toContain('amount')
    expect(fields(limit({ type: 'stop-loss', amount: { kind: 'percent', value: 101 } }))).toContain('amount')
    expect(fields(limit({ triggerPriceNear: '0' }))).toContain('triggerPriceNear')
    expect(fields(limit({ expiresAt: NOW - 1 }))).toContain('expiresAt')
  })

  it('slippage stays within what NEARKITS wallets may trade with (inside the signer’s floor)', () => {
    expect(AUTOMATION_MAX_SLIPPAGE).toBe(5)
    expect(validateLimit(limit({ slippagePct: 5 }), NOW)).toEqual([])
    expect(validateLimit(limit({ slippagePct: 5.01 }), NOW).map((i) => i.field)).toContain('slippagePct')
    expect(validateLimit(limit({ slippagePct: 10 }), NOW).map((i) => i.field)).toContain('slippagePct')
    expect(validateLimit(limit({ slippagePct: 0 }), NOW).map((i) => i.field)).toContain('slippagePct')
  })
})

describe('Copy Trade, Sniper and DCA configurations', () => {
  const copy = (patch: Partial<CopyConfig> = {}): CopyConfig => ({
    target: 'whale.near',
    copy: 'both',
    sizing: { mode: 'fixed', amountNear: 1 },
    maxTradeNear: 2,
    minTradeNear: null,
    maxExposureNear: 10,
    slippagePct: 1,
    minLiquidityUsd: 10_000,
    exclude: [],
    ...patch,
  })
  it('copy limits are ordered: a minimum not above the maximum, an exposure of at least one maximum trade', () => {
    expect(validateCopy(copy())).toEqual([])
    expect(validateCopy(copy({ minTradeNear: 3 })).map((i) => i.field)).toContain('minTradeNear')
    expect(validateCopy(copy({ maxExposureNear: 1 })).map((i) => i.field)).toContain('maxExposureNear')
    expect(validateCopy(copy({ target: 'Not An Account' })).map((i) => i.field)).toContain('target')
    expect(validateCopy(copy({ sizing: { mode: 'percent', pct: 150 } })).map((i) => i.field)).toContain('sizing')
  })

  it('a sniper buys a real token within limits; attempts are bounded', () => {
    const s = {
      target: 'token' as const,
      token: KITS,
      sources: [],
      minPoolNear: null,
      maxBuys: 1,
      amountNear: 1,
      slippagePct: 3,
      maxImpactPct: 10,
      minLiquidityUsd: null,
      maxAttempts: 3,
      expiresAt: null,
      mode: 'notify' as const,
    }
    expect(validateSniper(s, NOW)).toEqual([])
    expect(validateSniper({ ...s, maxAttempts: 11 }, NOW).map((i) => i.field)).toContain('maxAttempts')
    expect(validateSniper({ ...s, token: { ...KITS, id: 'near' } }, NOW).map((i) => i.field)).toContain('token.id')
  })

  it('a new-pools sniper names no token, watches chosen sources, has a pool NEAR minimum and a bounded number of buys', () => {
    const s = {
      target: 'new-pools' as const,
      token: null,
      sources: ['nearly' as const, 'other' as const],
      minPoolNear: 5,
      maxBuys: 2,
      amountNear: 1,
      slippagePct: 3,
      maxImpactPct: 10,
      minLiquidityUsd: null,
      maxAttempts: 3,
      expiresAt: null,
      mode: 'notify' as const,
    }
    expect(validateSniper(s, NOW)).toEqual([])
    const fields = (patch: Record<string, unknown>) => validateSniper({ ...s, ...patch } as typeof s, NOW).map((i) => i.field)
    expect(fields({ sources: [] })).toContain('sources')
    expect(fields({ sources: ['nearly', 'nearly'] })).toContain('sources')
    expect(fields({ sources: ['pumpfun'] })).toContain('sources')
    expect(fields({ minPoolNear: null })).toContain('minPoolNear')
    expect(fields({ maxBuys: 11 })).toContain('maxBuys')
    expect(fields({ token: KITS })).toContain('token')
    expect(fields({ minLiquidityUsd: 1000 })).toContain('minLiquidityUsd')
  })

  it('a sniper sent without a target (an older client) is a sniper on its token; a new-pools one keeps its fields', () => {
    const old = parseStrategy(
      { kind: 'sniper', sniper: { token: KITS, amountNear: 1, slippagePct: 3, maxImpactPct: 10, minLiquidityUsd: null, maxAttempts: 3, expiresAt: null, mode: 'notify' } },
      NOW,
    )
    expect(old).toMatchObject({ ok: true, config: { sniper: { target: 'token', token: { id: KITS.id }, sources: [], minPoolNear: null, maxBuys: 1 } } })
    const pools = parseStrategy(
      {
        kind: 'sniper',
        sniper: {
          target: 'new-pools',
          token: null,
          sources: ['meme-cooking'],
          minPoolNear: 2,
          maxBuys: 1,
          amountNear: 1,
          slippagePct: 3,
          maxImpactPct: 10,
          minLiquidityUsd: null,
          maxAttempts: 3,
          expiresAt: null,
          mode: 'notify',
        },
      },
      NOW,
    )
    expect(pools).toMatchObject({ ok: true, config: { sniper: { target: 'new-pools', token: null, sources: ['meme-cooking'], minPoolNear: 2 } } })
    expect(tokenOfStrategy((pools as { config: StrategyConfig }).config)).toBeNull()
  })

  it('DCA runs on the listed intervals, from now on', () => {
    const d = { token: KITS, amountNear: 0.5, everySec: 86_400, startAt: NOW, endAt: null, slippagePct: 1, maxRuns: 10 }
    expect(validateDca(d, NOW)).toEqual([])
    expect(validateDca({ ...d, everySec: 60 }, NOW).map((i) => i.field)).toContain('everySec')
    expect(validateDca({ ...d, startAt: NOW - 3_600_000 }, NOW).map((i) => i.field)).toContain('startAt')
  })
})

describe('reading a configuration from the network', () => {
  it('takes exactly its fields, of the right types, and validates them', () => {
    const parsed = parseStrategy(JSON.parse(JSON.stringify({ kind: 'limit', limit: limit() })), NOW)
    expect(parsed).toEqual({ ok: true, config: { kind: 'limit', limit: limit() } })
  })

  it('never coerces: a number sent as a string is an issue', () => {
    const raw = JSON.parse(JSON.stringify({ kind: 'limit', limit: limit() })) as { limit: Record<string, unknown> }
    raw.limit.slippagePct = '1'
    expect(parseStrategy(raw, NOW).ok).toBe(false)
    expect(parseStrategy({ kind: 'nope' }, NOW).ok).toBe(false)
    expect(parseStrategy(null, NOW).ok).toBe(false)
  })
})
