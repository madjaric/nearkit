import { describe, expect, it } from 'vitest'
import type { ExecutionView } from '@/lib/automation/api'
import { STRATEGY_STATUSES, validateCopy, validateDca, validateLimit, validateSniper, type TokenRef } from '@/lib/automation/config'
import { LinkRequestError } from '@/services/telegramLink'
import {
  buildCopy,
  buildDca,
  buildLimit,
  buildSniper,
  buildStopLossPair,
  controlsFor,
  decimalText,
  describeStrategy,
  executionAmounts,
  EXECUTION_LAMP,
  issuesByField,
  refusalOf,
  shownRaw,
  SLIPPAGE_CHOICES,
  STATUS_LAMP,
  tabOf,
  tokenRefOf,
  type CopyDraft,
  type LimitDraft,
} from './model'
import { automationLive } from './queries'

/**
 * NEARKITS web's automation forms validate with the server's own rules (src/lib/automation/config.ts):
 * a form the web accepts is one the server accepts. States are shown as the server reports them, and a
 * trade reads as confirmed only once the server says the chain confirmed it.
 */

const NOW = 1_800_000_000_000
const USDT: TokenRef = { id: 'usdt.tether-token.near', symbol: 'USDt', decimals: 6 }
const fields = (issues: { field: string }[]) => issues.map((i) => i.field)

describe('the limit order form', () => {
  const draft = (o: Partial<LimitDraft> = {}): LimitDraft => ({
    type: 'limit-buy',
    token: USDT,
    sellBy: 'tokens',
    amountText: '2',
    triggerText: '0.25',
    slippagePct: 1,
    expiry: 'gtc',
    ...o,
  })

  it('a complete limit buy spends NEAR and passes the shared validator unchanged', () => {
    const { config, issues } = buildLimit(draft(), NOW)
    expect(issues).toEqual([])
    expect(config).toEqual({ type: 'limit-buy', token: USDT, amount: { kind: 'near', value: '2' }, triggerPriceNear: '0.25', slippagePct: 1, expiresAt: null })
    expect(validateLimit(config, NOW)).toEqual([])
  })

  it('typed decimals are written the way the server reads them', () => {
    expect(decimalText('.5')).toBe('0.5')
    expect(decimalText('1.')).toBe('1')
    expect(decimalText('007.10')).toBe('7.10')
    expect(buildLimit(draft({ triggerText: '.0001', amountText: '3.' }), NOW).issues).toEqual([])
  })

  it('the same refusals as the server, field by field', () => {
    const { issues } = buildLimit(draft({ amountText: '0.01', triggerText: '', slippagePct: 7 }), NOW)
    expect(fields(issues).sort()).toEqual(['amount', 'slippagePct', 'triggerPriceNear'])
    expect(issuesByField(issues).amount).toBe('Spend at least 0.05 NEAR')
  })

  it('no token chosen is one issue on the token field', () => {
    expect(fields(buildLimit(draft({ token: null }), NOW).issues)).toEqual(['token.id'])
  })

  it('a sell spends tokens, or a whole percentage of the balance at trigger', () => {
    expect(buildLimit(draft({ type: 'limit-sell', amountText: '100' }), NOW).config.amount).toEqual({ kind: 'tokens', value: '100' })
    const pct = buildLimit(draft({ type: 'take-profit', sellBy: 'percent', amountText: '50' }), NOW)
    expect(pct.config.amount).toEqual({ kind: 'percent', value: 50 })
    expect(pct.issues).toEqual([])
    expect(fields(buildLimit(draft({ type: 'stop-loss', sellBy: 'percent', amountText: '12.5' }), NOW).issues)).toEqual(['amount'])
  })

  it('an expiry counts from now', () => {
    expect(buildLimit(draft({ expiry: '24h' }), NOW).config.expiresAt).toBe(NOW + 86_400_000)
  })

  it('a take profit’s stop loss shares its token, amount, slippage and expiry, with its own trigger', () => {
    const tp = buildLimit(draft({ type: 'take-profit', triggerText: '0.5' }), NOW).config
    const pair = buildStopLossPair(tp, '0.2', NOW)
    expect(pair.issues).toEqual([])
    expect(pair.config).toEqual({ ...tp, type: 'stop-loss', triggerPriceNear: '0.2' })
    expect(buildStopLossPair(tp, '', NOW).issues).toEqual([{ field: 'pair.triggerPriceNear', message: 'Enter a trigger price in NEAR above 0' }])
  })
})

describe('the Copy Trade, Sniper and DCA forms', () => {
  const copy = (o: Partial<CopyDraft> = {}): CopyDraft => ({
    target: ' Trader.NEAR ',
    copy: 'both',
    sizing: 'fixed',
    fixedText: '1',
    pctText: '25',
    maxTradeText: '5',
    minTradeText: '',
    maxExposureText: '20',
    slippagePct: 2,
    minLiquidityText: '',
    exclude: [],
    ...o,
  })

  it('Copy Trade: optional limits are null, the account is normalized, and the shared validator agrees', () => {
    const { config, issues } = buildCopy(copy())
    expect(issues).toEqual([])
    expect(config).toMatchObject({ target: 'trader.near', sizing: { mode: 'fixed', amountNear: 1 }, minTradeNear: null, minLiquidityUsd: null })
    expect(validateCopy(config)).toEqual([])
    expect(fields(buildCopy(copy({ maxExposureText: '2' })).issues)).toEqual(['maxExposureNear'])
    expect(fields(buildCopy(copy({ target: 'not an account' })).issues)).toEqual(['target'])
    expect(fields(buildCopy(copy({ sizing: 'percent', pctText: '' })).issues)).toEqual(['sizing'])
  })

  it('Sniper: notify only by default shape, attempts bounded, as the server checks', () => {
    const base = { token: USDT, amountText: '1', slippagePct: 1, maxImpactText: '10', minLiquidityText: '', maxAttemptsText: '3', expiry: 'gtc' as const, mode: 'notify' as const }
    const ok = buildSniper(base, NOW)
    expect(ok.issues).toEqual([])
    expect(validateSniper(ok.config, NOW)).toEqual([])
    expect(fields(buildSniper({ ...base, maxAttemptsText: '11' }, NOW).issues)).toEqual(['maxAttempts'])
    expect(fields(buildSniper({ ...base, token: null }, NOW).issues)).toEqual(['token.id'])
  })

  it('DCA: starts now unless a start is set, ends by runs or date, as the server checks', () => {
    const base = { token: USDT, amountText: '0.5', everySec: 86_400, startText: '', endBy: 'never' as const, maxRunsText: '30', endText: '', slippagePct: 1 }
    const ok = buildDca(base, NOW)
    expect(ok.issues).toEqual([])
    expect(ok.config).toMatchObject({ startAt: NOW, endAt: null, maxRuns: null })
    expect(validateDca(ok.config, NOW)).toEqual([])
    expect(buildDca({ ...base, endBy: 'runs' }, NOW).config.maxRuns).toBe(30)
    expect(fields(buildDca({ ...base, everySec: 60 }, NOW).issues)).toEqual(['everySec'])
    expect(fields(buildDca({ ...base, amountText: '0' }, NOW).issues)).toEqual(['amountNear'])
  })

  it('slippage choices never exceed the NEARKITS-wallet cap', () => {
    expect(Math.max(...SLIPPAGE_CHOICES)).toBe(5)
  })

  it('a listed token names its contract; one without a contract is no token', () => {
    expect(tokenRefOf({ contract: 'usdt.tether-token.near', symbol: 'USDt', decimals: 6 })).toEqual(USDT)
    expect(tokenRefOf({ contract: null, symbol: 'NEAR', decimals: 24 })).toBeNull()
  })
})

describe('states and controls, as the server allows them', () => {
  it('every status has a lamp; ended ones are history, paused its own tab, the rest active', () => {
    for (const s of STRATEGY_STATUSES) expect(STATUS_LAMP[s].label).toBeTruthy()
    expect(tabOf('paused')).toBe('paused')
    for (const s of ['filled', 'completed', 'cancelled', 'stopped', 'expired', 'failed'] as const) expect(tabOf(s)).toBe('history')
    for (const s of ['draft', 'active', 'triggered', 'executing', 'submitted'] as const) expect(tabOf(s)).toBe('active')
  })

  it('pause while it waits, resume when paused, cancel until it ends; nothing while a trade is under way', () => {
    expect(controlsFor('active')).toEqual({ pause: true, resume: false, cancel: true })
    expect(controlsFor('paused')).toEqual({ pause: false, resume: true, cancel: true })
    for (const s of ['triggered', 'executing', 'submitted', 'filled', 'cancelled', 'failed'] as const)
      expect(controlsFor(s)).toEqual({ pause: false, resume: false, cancel: false })
  })

  it('a trade is shown confirmed only when the server says so; before that, the quote’s figures, labelled', () => {
    const e: ExecutionView = {
      id: 'x1',
      side: 'buy',
      token: USDT.id,
      status: 'submitted',
      amountInRaw: '2000000000000000000000000',
      expectedOutRaw: '8000000',
      minOutRaw: '7920000',
      nearRaw: null,
      tokenRaw: null,
      priceNear: null,
      txHashes: [],
      message: null,
      source: null,
      createdAt: NOW,
      updatedAt: NOW,
    }
    expect(EXECUTION_LAMP.submitted.label).toBe('Submitted · not confirmed')
    expect(EXECUTION_LAMP.executing.label).not.toMatch(/confirm/i)
    expect(executionAmounts(e, USDT)).toEqual({ spent: '2 NEAR', received: 'min 7.92 USDt', quoted: true })
    const done = { ...e, status: 'confirmed' as const, nearRaw: '2000000000000000000000000', tokenRaw: '7950000' }
    expect(executionAmounts(done, USDT)).toEqual({ spent: '2 NEAR', received: '7.95 USDt', quoted: false })
    expect(EXECUTION_LAMP.confirmed.label).toBe('Confirmed on chain')
  })

  it('raw amounts read exactly; unknown is a dash, never 0', () => {
    expect(shownRaw(null, 24)).toBe('—')
    expect(shownRaw('1', 24)).toBe('< 0.000001')
    expect(shownRaw('1234500000', 6)).toBe('1,234.5')
  })

  it('a strategy line says what it does, from its own configuration', () => {
    const limit = buildLimit({ type: 'stop-loss', token: USDT, sellBy: 'percent', amountText: '100', triggerText: '0.2', slippagePct: 1, expiry: 'gtc' }, NOW).config
    expect(describeStrategy({ config: { kind: 'limit', limit } })).toBe('Stop loss · 100% of USDt · ≤ 0.2 NEAR')
  })
})

describe('refusals', () => {
  it('the server’s message, and its issues per field', () => {
    const issues = [{ field: 'triggerPriceNear', message: 'Enter a trigger price in NEAR above 0' }]
    expect(refusalOf(new LinkRequestError(400, 'state', 'Check the highlighted fields.', { issues }))).toEqual({ message: 'Check the highlighted fields.', issues })
    expect(refusalOf(new LinkRequestError(409, 'target', 'That account is a NEARKITS wallet'))).toEqual({ message: 'That account is a NEARKITS wallet', issues: [] })
    expect(refusalOf(new Error('boom')).message).toBe('boom')
  })
})

describe('which page a user sees', () => {
  it('the server-backed page only with real services and the kind switched on; the demo never', () => {
    expect(automationLive('near', ['limit'], 'limit')).toBe(true)
    expect(automationLive('near', ['dca'], 'limit')).toBe(false)
    expect(automationLive('near', null, 'limit')).toBe(false)
    expect(automationLive('near', undefined, 'limit')).toBe(false)
    expect(automationLive('demo', ['limit', 'copy', 'sniper', 'dca'], 'limit')).toBe(false)
  })
})
