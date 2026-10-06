import { describe, expect, it } from 'vitest'
import { defaultBotConfig, validateBotConfig } from '@/lib/volumeBot/config'
import { applyText, fieldsFor, sizingModes, textOf } from './fields'

const config = () => defaultBotConfig('market-maker', { id: 'usdt.tether-token.near', symbol: 'USDt', decimals: 6 }, ['w1'])

describe('the setup form’s fields', () => {
  it('show each value in its unit and read it back exactly: a % kept in bps, minutes kept in seconds', () => {
    const c = config()
    const text = textOf(c)
    expect(text['marketMaker.minEdgeBps']).toBe('0.5')
    expect(text['marketMaker.fairValueWindowSec']).toBe('60')
    expect(text['risk.maxSlippageBps']).toBe('1')
    expect(applyText(c, fieldsFor(c), text)).toEqual(c)
  })

  it('reads a typed % into whole bps, blank optional limits as none, and keeps unreadable text unreadable for validation', () => {
    const c = config()
    const fields = fieldsFor(c)
    const next = applyText(c, fields, { ...textOf(c), 'marketMaker.minEdgeBps': '0.755', 'schedule.maxTrades': '', 'risk.maxTradeNear': '' })
    expect(next.marketMaker.minEdgeBps).toBe(76)
    expect(next.schedule.maxTrades).toBeNull()
    expect(Number.isNaN(next.risk.maxTradeNear)).toBe(true)
    expect(validateBotConfig(next).map((i) => i.field)).toEqual(['risk.maxTradeNear'])
  })

  it('offers each strategy only the sizing modes that mean something for it', () => {
    expect(sizingModes('market-maker')).not.toContain('auto')
    expect(sizingModes('accumulate')).not.toContain('inventory-pct')
    expect(sizingModes('distribute')).not.toContain('capital-pct')
  })
})
