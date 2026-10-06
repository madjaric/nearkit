import { describe, expect, it } from 'vitest'
import { GAS_RESERVE_NEAR } from '@/lib/fees'
import { defaultBotConfig, MAX_BOT_WALLETS, MIN_EDGE_BPS, MIN_INTERVAL_SEC, parseBotConfig, validateBotConfig } from './config'
import type { BotConfig } from './types'

const TOKEN = { id: 'token.example.near', symbol: 'TKN', decimals: 18 }
const mm = (patch: (c: BotConfig) => void = () => {}): BotConfig => {
  const c = defaultBotConfig('market-maker', TOKEN, ['w1', 'w2'])
  patch(c)
  return c
}
const fields = (c: BotConfig) => validateBotConfig(c).map((i) => i.field)

describe('a Volume Bot configuration', () => {
  it('starts from defaults that are valid for every strategy', () => {
    expect(validateBotConfig(mm())).toEqual([])
    const acc = defaultBotConfig('accumulate', TOKEN, ['w1'])
    acc.twap.totalNear = 10
    expect(validateBotConfig(acc)).toEqual([])
    const dist = defaultBotConfig('distribute', TOKEN, ['w1'])
    dist.twap.totalTokens = 1000
    expect(validateBotConfig(dist)).toEqual([])
  })

  it('never lets the market maker trade without an edge over fair value: the edge has a floor', () => {
    expect(fields(mm((c) => (c.marketMaker.minEdgeBps = MIN_EDGE_BPS - 1)))).toContain('marketMaker.minEdgeBps')
    expect(fields(mm((c) => (c.marketMaker.minEdgeBps = 0)))).toContain('marketMaker.minEdgeBps')
    expect(validateBotConfig(mm((c) => (c.marketMaker.minEdgeBps = MIN_EDGE_BPS)))).toEqual([])
  })

  it('sets no monetary ceiling of its own: the owner decides the sizes and limits', () => {
    expect(
      validateBotConfig(
        mm((c) => {
          c.risk.maxTradeNear = 1_000_000
          c.sizing.fixedNear = 250_000
          c.inventory.maxNearDeployed = 5_000_000
          c.risk.maxDailyLossNear = 100_000
        }),
      ),
    ).toEqual([])
  })

  it('refuses amounts that are not positive finite numbers', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(fields(mm((c) => (c.risk.maxTradeNear = bad)))).toContain('risk.maxTradeNear')
      expect(fields(mm((c) => (c.inventory.maxNearDeployed = bad)))).toContain('inventory.maxNearDeployed')
      expect(fields(mm((c) => (c.risk.maxDailyLossNear = bad)))).toContain('risk.maxDailyLossNear')
    }
  })

  it('keeps the inventory bounds ordered: min ≤ target ≤ max, all within 0–100 %', () => {
    expect(fields(mm((c) => (c.inventory.targetTokenPct = 90)))).toContain('inventory.targetTokenPct')
    expect(fields(mm((c) => (c.inventory.minTokenPct = -5)))).toContain('inventory.minTokenPct')
    expect(fields(mm((c) => (c.inventory.maxTokenPct = 120)))).toContain('inventory.maxTokenPct')
  })

  it('evaluates no more often than every few seconds, and the interval range is ordered', () => {
    expect(fields(mm((c) => (c.schedule.minIntervalSec = MIN_INTERVAL_SEC - 1)))).toContain('schedule.minIntervalSec')
    expect(
      fields(
        mm((c) => {
          c.schedule.minIntervalSec = 120
          c.schedule.maxIntervalSec = 60
        }),
      ),
    ).toContain('schedule.maxIntervalSec')
  })

  it('takes UTC hour windows that are real and not empty', () => {
    expect(fields(mm((c) => (c.schedule.activeHours = { from: 9, to: 9 })))).toContain('schedule.activeHours')
    expect(fields(mm((c) => (c.schedule.activeHours = { from: 25, to: 3 })))).toContain('schedule.activeHours')
    expect(validateBotConfig(mm((c) => (c.schedule.activeHours = { from: 22, to: 6 })))).toEqual([])
    expect(fields(mm((c) => (c.schedule.pauseWindows = [{ from: 3, to: 3 }])))).toContain('schedule.pauseWindows')
  })

  it('trades from at least one wallet, each named once, up to the operational cap', () => {
    expect(fields(mm((c) => (c.walletIds = [])))).toContain('walletIds')
    expect(fields(mm((c) => (c.walletIds = ['w1', 'w1'])))).toContain('walletIds')
    expect(fields(mm((c) => (c.walletIds = Array.from({ length: MAX_BOT_WALLETS + 1 }, (_, i) => `w${i}`))))).toContain('walletIds')
  })

  it('trades a real token against NEAR, never NEAR itself', () => {
    expect(fields(mm((c) => (c.tokenId = 'near')))).toContain('tokenId')
    expect(fields(mm((c) => (c.tokenId = 'wrap.near')))).toContain('tokenId')
    expect(fields(mm((c) => (c.tokenId = 'Not An Account')))).toContain('tokenId')
  })

  it('keeps at least the minimum wallet reserve of NEAR in every wallet', () => {
    expect(fields(mm((c) => (c.risk.gasReserveNear = GAS_RESERVE_NEAR / 2)))).toContain('risk.gasReserveNear')
    expect(validateBotConfig(mm((c) => (c.risk.gasReserveNear = GAS_RESERVE_NEAR)))).toEqual([])
  })

  it('needs a budget for accumulate and an amount for distribute', () => {
    const acc = defaultBotConfig('accumulate', TOKEN, ['w1'])
    expect(validateBotConfig(acc).map((i) => i.field)).toContain('twap.totalNear')
    const dist = defaultBotConfig('distribute', TOKEN, ['w1'])
    expect(validateBotConfig(dist).map((i) => i.field)).toContain('twap.totalTokens')
    dist.twap.totalTokens = 5
    dist.twap.durationSec = 60
    expect(validateBotConfig(dist).map((i) => i.field)).toContain('twap.durationSec')
  })

  it('caps slippage and price impact at sane percentages', () => {
    expect(fields(mm((c) => (c.risk.maxSlippageBps = 6000)))).toContain('risk.maxSlippageBps')
    expect(fields(mm((c) => (c.risk.maxPriceImpactBps = 0)))).toContain('risk.maxPriceImpactBps')
  })
})

describe('reading a configuration sent to the API', () => {
  it('accepts a valid configuration exactly', () => {
    const c = mm()
    const parsed = parseBotConfig(JSON.parse(JSON.stringify(c)))
    expect(parsed).toEqual({ ok: true, config: c })
  })

  it('names every field of the wrong type, and never coerces', () => {
    const raw = JSON.parse(JSON.stringify(mm())) as Record<string, unknown>
    ;(raw.risk as Record<string, unknown>).maxTradeNear = '5'
    raw.walletIds = 'w1'
    raw.strategy = 'volume'
    const parsed = parseBotConfig(raw)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.issues.map((i) => i.field).sort()).toEqual(['risk.maxTradeNear', 'strategy', 'walletIds'])
  })

  it('refuses something that is not an object', () => {
    expect(parseBotConfig(null).ok).toBe(false)
    expect(parseBotConfig('{}').ok).toBe(false)
  })
})
