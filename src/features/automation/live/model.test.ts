import { describe, expect, it } from 'vitest'
import { REQUEST_KEY, type CreateStrategyInput, type ExecutionView, type StrategyView } from '@/lib/automation/api'
import { parseStrategy, STRATEGY_STATUSES, validateCopy, validateDca, validateLimit, validateSniper, type TokenRef } from '@/lib/automation/config'
import { LinkRequestError } from '@/services/telegramLink'
import {
  buildCopy,
  buildDca,
  buildLimit,
  buildSniper,
  buildStopLossPair,
  buyConfirmation,
  controlsFor,
  createRefusalOf,
  decimalText,
  describeStrategy,
  DETECTION_LAMP,
  detectionLamp,
  detectionSourceOf,
  detectionTitle,
  endedNote,
  endPrompt,
  executionAmounts,
  EXECUTION_LAMP,
  issuesByField,
  newRequestKey,
  pairSibling,
  refusalOf,
  retryableCreate,
  REVIEW_AGAIN,
  reviewOf,
  sendCreate,
  shownRaw,
  SLIPPAGE_CHOICES,
  sniperCreatedNote,
  sniperSummary,
  sourcesText,
  STATUS_LAMP,
  tabOf,
  tokenRefOf,
  validRequestKey,
  type CopyDraft,
  type LimitDraft,
  type Reviewed,
  type SniperDraft,
} from './model'
import { automationAccess, automationLive } from './queries'

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

const sniper = (o: Partial<SniperDraft> = {}): SniperDraft => ({
  target: 'token',
  token: USDT,
  sources: [],
  minPoolText: '',
  maxBuysText: '1',
  amountText: '1',
  slippagePct: 1,
  maxImpactText: '10',
  minLiquidityText: '',
  maxAttemptsText: '3',
  expiry: 'gtc',
  mode: 'notify',
  ...o,
})
const pools = (o: Partial<SniperDraft> = {}): SniperDraft => sniper({ target: 'new-pools', token: USDT, sources: ['nearly', 'meme-cooking'], minPoolText: '5', ...o })

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
    const ok = buildSniper(sniper(), NOW)
    expect(ok.issues).toEqual([])
    expect(ok.config).toMatchObject({ target: 'token', token: USDT, sources: [], minPoolNear: null, maxBuys: 1, mode: 'notify' })
    expect(validateSniper(ok.config, NOW)).toEqual([])
    expect(fields(buildSniper(sniper({ maxAttemptsText: '11' }), NOW).issues)).toEqual(['maxAttempts'])
    expect(fields(buildSniper(sniper({ token: null }), NOW).issues)).toEqual(['token.id'])
    // Pool settings typed before switching back to one token are never sent with it.
    expect(buildSniper(sniper({ sources: ['other'], minPoolText: '9', maxBuysText: '4', mode: 'execute' }), NOW).config).toMatchObject({
      sources: [],
      minPoolNear: null,
      maxBuys: 1,
    })
  })

  it('Sniper on new pools: no token, its sources and pool minimum, no market-liquidity check; the server’s parser takes it unchanged', () => {
    const { config, issues } = buildSniper(pools({ minLiquidityText: '1000' }), NOW)
    expect(issues).toEqual([])
    expect(config).toEqual({
      target: 'new-pools',
      token: null,
      sources: ['nearly', 'meme-cooking'],
      minPoolNear: 5,
      maxBuys: 1,
      amountNear: 1,
      slippagePct: 1,
      maxImpactPct: 10,
      minLiquidityUsd: null,
      maxAttempts: 3,
      expiresAt: null,
      mode: 'notify',
    })
    expect(validateSniper(config, NOW)).toEqual([])
    expect(parseStrategy({ kind: 'sniper', sniper: config }, NOW)).toEqual({ ok: true, config: { kind: 'sniper', sniper: config } })
    // In the sources' own order, whatever order they were ticked in.
    expect(buildSniper(pools({ sources: ['other', 'nearly'] }), NOW).config.sources).toEqual(['nearly', 'other'])
    // Buy mode buys up to its number of tokens; notify-only buys nothing (one, as the server requires).
    expect(buildSniper(pools({ mode: 'execute', maxBuysText: '3' }), NOW).config.maxBuys).toBe(3)
    expect(buildSniper(pools({ mode: 'notify', maxBuysText: '3' }), NOW).config.maxBuys).toBe(1)
  })

  it('Sniper on new pools: the shared validator’s refusals, field by field', () => {
    expect(fields(buildSniper(pools({ sources: [] }), NOW).issues)).toEqual(['sources'])
    expect(fields(buildSniper(pools({ minPoolText: '' }), NOW).issues)).toEqual(['minPoolNear'])
    expect(buildSniper(pools({ minPoolText: '0' }), NOW).issues).toEqual([])
    expect(fields(buildSniper(pools({ mode: 'execute', maxBuysText: '11' }), NOW).issues)).toEqual(['maxBuys'])
    expect(fields(buildSniper(pools({ mode: 'execute', maxBuysText: '' }), NOW).issues)).toEqual(['maxBuys'])
    const ok = buildSniper(pools(), NOW).config
    expect(fields(validateSniper({ ...ok, minLiquidityUsd: 100 }, NOW))).toEqual(['minLiquidityUsd'])
    expect(fields(validateSniper({ ...ok, token: USDT }, NOW))).toEqual(['token'])
    expect(fields(validateSniper({ ...ok, minPoolNear: null }, NOW))).toEqual(['minPoolNear'])
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
    expect(automationLive('demo', ['sniper'], 'sniper')).toBe(false)
  })

  const base = { mode: 'near' as const, available: true, session: false, sessionKinds: undefined, sessionPending: false, serverKinds: undefined, serverPending: false }

  it('no NEARKITS session, the server runs it (public /health): the live page asks to sign in, never drafts or "coming soon"', () => {
    expect(automationAccess({ ...base, serverKinds: ['limit', 'dca', 'sniper', 'copy'] }, 'copy')).toBe('sign-in')
    // The server runs other kinds, or none: the page as it was.
    expect(automationAccess({ ...base, serverKinds: ['dca'] }, 'copy')).toBe('held')
    expect(automationAccess({ ...base, serverKinds: [] }, 'copy')).toBe('held')
    // The answer is on its way: nothing is shown as held (or live) yet; it failed: as it was.
    expect(automationAccess({ ...base, serverPending: true }, 'copy')).toBe('checking')
    expect(automationAccess({ ...base, serverKinds: null }, 'copy')).toBe('held')
  })

  it('with a session, its own answer decides: live, held, or checking while it is read', () => {
    const signedIn = { ...base, session: true, serverKinds: ['limit', 'dca', 'sniper', 'copy'] as const }
    expect(automationAccess({ ...signedIn, sessionKinds: ['limit'] }, 'limit')).toBe('live')
    expect(automationAccess({ ...signedIn, sessionKinds: ['dca'] }, 'limit')).toBe('held')
    expect(automationAccess({ ...signedIn, sessionPending: true }, 'limit')).toBe('checking')
    // The session's read failed: as it was (the live page needs it).
    expect(automationAccess(signedIn, 'limit')).toBe('held')
  })

  it('the demo and a build without a server: always the page as it was', () => {
    expect(automationAccess({ ...base, mode: 'demo', serverKinds: ['limit'] }, 'limit')).toBe('held')
    expect(automationAccess({ ...base, available: false, serverKinds: ['limit'] }, 'limit')).toBe('held')
  })
})

describe('a new-pools sniper, in words', () => {
  const describe1 = (o: Partial<SniperDraft> = {}) => describeStrategy({ config: { kind: 'sniper', sniper: buildSniper(pools(o), NOW).config } })

  it('notify only: where its pools come from, the pool minimum, the amount', () => {
    expect(describe1()).toBe('Notify only: new pools from Nearly launches, meme.cooking · pool ≥ 5 NEAR · 1 NEAR each')
    expect(describe1({ sources: ['other', 'meme-cooking', 'nearly'] })).toBe(
      'Notify only: new pools from Nearly launches, meme.cooking and other new pools · pool ≥ 5 NEAR · 1 NEAR each',
    )
    expect(describe1({ sources: ['other'], minPoolText: '0', amountText: '0.5' })).toBe('Notify only: other new pools · pool ≥ 0 NEAR · 0.5 NEAR each')
    expect(sourcesText(['meme-cooking'])).toBe('meme.cooking')
  })

  it('buying: up to its number of tokens', () => {
    expect(describe1({ mode: 'execute', maxBuysText: '3' })).toBe('Buys up to 3 new tokens from Nearly launches, meme.cooking · pool ≥ 5 NEAR · 1 NEAR each')
    expect(describe1({ mode: 'execute', maxBuysText: '1', sources: ['nearly'] })).toBe('Buys up to 1 new token from Nearly launches · pool ≥ 5 NEAR · 1 NEAR each')
  })

  it('a sniper on one token reads as it did', () => {
    expect(describeStrategy({ config: { kind: 'sniper', sniper: buildSniper(sniper(), NOW).config } })).toBe('Notify only: 1 NEAR of USDt · max impact 10%')
    expect(describeStrategy({ config: { kind: 'sniper', sniper: buildSniper(sniper({ mode: 'execute' }), NOW).config } })).toBe('Buys 1 NEAR of USDt · max impact 10%')
  })

  it('the review: its limits, the explicit yes in words of what it buys, and what the toast says', () => {
    const notify = buildSniper(pools(), NOW).config
    expect(sniperSummary(notify)).toBe(
      'Notify only: new pools from Nearly launches, meme.cooking · pool ≥ 5 NEAR · 1 NEAR each. Price impact at most 10%; a round trip loses at most 25%; slippage 1%.',
    )
    const buys = buildSniper(pools({ mode: 'execute', maxBuysText: '3', amountText: '2' }), NOW).config
    expect(buyConfirmation(buys)).toBe('I confirm: buy 2 NEAR of each new token that passes these checks, up to 3 tokens, from my NEARKITS wallet without asking me again.')
    expect(sniperSummary(buys)).toContain('It stops after 3 buys that weren’t made.')
    expect(sniperCreatedNote(buys).title).toBe('Sniper armed to buy new pools')
    expect(sniperCreatedNote(notify).detail).toBe('It buys nothing: it tells you about each new pool that passes its checks.')
    expect(buyConfirmation(buildSniper(sniper({ mode: 'execute' }), NOW).config)).toContain('buy 1 NEAR of USDt from my NEARKITS wallet when it trades')
  })
})

describe('one create per review (the request key)', () => {
  const config = { kind: 'dca', dca: { token: USDT } } as never

  it('a key the server accepts, a different one each time', () => {
    const keys = new Set(Array.from({ length: 20 }, () => newRequestKey()))
    expect(keys.size).toBe(20)
    for (const k of keys) {
      expect(validRequestKey(k)).toBe(true)
      expect(REQUEST_KEY.test(k)).toBe(true)
    }
  })

  it('every Confirm of one review sends its key; editing and reviewing again makes a new one', () => {
    const first = reviewOf({ amount: 1 }, 'w1')
    const input = (r: Reviewed<unknown>): CreateStrategyInput => ({ walletId: r.walletId, config, requestKey: r.requestKey })
    // A second click, or a retry after a network failure: the same review, the same key.
    expect(input(first).requestKey).toBe(input(first).requestKey)
    const edited = reviewOf({ amount: 2 }, 'w1')
    expect(edited.requestKey).not.toBe(first.requestKey)
    expect(reviewOf({ amount: 1 }, 'w1', 'fixed-key-123').requestKey).toBe('fixed-key-123')
  })

  it('a create the server never answered is sent once more, unchanged; a refusal never is', async () => {
    const sent: CreateStrategyInput[] = []
    const wait = async () => undefined
    const flaky = (failures: unknown[]) => async (i: CreateStrategyInput) => {
      sent.push(i)
      const e = failures.shift()
      if (e) throw e
      return ['made']
    }
    const input: CreateStrategyInput = { walletId: 'w1', config, requestKey: 'review-key-1' }
    expect(await sendCreate(flaky([new LinkRequestError(0, 'unreachable', 'The NEARKITS server can’t be reached right now.')]), input, wait)).toEqual(['made'])
    expect(sent).toEqual([input, input])
    sent.length = 0
    expect(await sendCreate(flaky([new LinkRequestError(502, 'error', 'The NEARKITS server answered 502.')]), input, wait)).toEqual(['made'])
    expect(sent).toHaveLength(2)
    // A refusal is the server's answer: not resent.
    sent.length = 0
    await expect(sendCreate(flaky([new LinkRequestError(409, 'limit', 'Too many live snipers')]), input, wait)).rejects.toMatchObject({ status: 409 })
    expect(sent).toHaveLength(1)
    // Without a key, nothing is resent (it could make the strategy twice).
    sent.length = 0
    await expect(sendCreate(flaky([new LinkRequestError(0, 'unreachable', 'down')]), { walletId: 'w1', config }, wait)).rejects.toMatchObject({ status: 0 })
    expect(sent).toHaveLength(1)
    expect(retryableCreate(new Error('boom'))).toBe(false)
  })

  it('a key the server saw with another request (409, request) asks for a new review, in plain words', () => {
    const r = createRefusalOf(new LinkRequestError(409, 'request', 'This request was already used for a different automation: review it again.'))
    expect(r).toEqual({ message: REVIEW_AGAIN, issues: [], reviewAgain: true })
    expect(r.message).toMatch(/Review it again/)
    const issues = [{ field: 'sources', message: 'Choose where new pools come from' }]
    expect(createRefusalOf(new LinkRequestError(400, 'state', 'Check the highlighted fields.', { issues }))).toEqual({
      message: 'Check the highlighted fields.',
      issues,
      reviewAgain: true,
    })
    expect(createRefusalOf(new LinkRequestError(409, 'limit', 'Too many'))).toEqual({ message: 'Too many', issues: [], reviewAgain: false })
  })
})

const view = (o: Partial<StrategyView>): StrategyView => ({
  id: 's1',
  kind: 'limit',
  status: 'active',
  walletId: 'w1',
  walletName: 'Main',
  subject: USDT.id,
  config: { kind: 'limit', limit: { type: 'take-profit', token: USDT, amount: { kind: 'percent', value: 100 }, triggerPriceNear: '0.5', slippagePct: 1, expiresAt: null } },
  statusReason: null,
  waiting: null,
  lastPriceNear: null,
  lastQuoteAt: null,
  ocoGroup: null,
  attempts: 0,
  expiresAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  closedAt: null,
  ...o,
})

describe('a take profit / stop loss pair is cancelled together', () => {
  const tp = view({ id: 'tp', ocoGroup: 'oco-1' })
  const sl = view({
    id: 'sl',
    ocoGroup: 'oco-1',
    config: { kind: 'limit', limit: { type: 'stop-loss', token: USDT, amount: { kind: 'percent', value: 100 }, triggerPriceNear: '0.2', slippagePct: 1, expiresAt: null } },
  })

  it('the confirmation says both orders of the pair are cancelled', () => {
    const p = endPrompt(tp)
    expect(p.title).toBe('Cancel both orders of this pair?')
    expect(p.description).toContain('both orders of the pair are cancelled')
    expect(p.confirm).toBe('Cancel both orders')
    expect(endPrompt(view({})).title).toBe('Cancel this limit order?')
    expect(endPrompt(view({ kind: 'sniper' })).title).toBe('Stop this sniper?')
    expect(pairSibling(tp, [tp, sl])?.id).toBe('sl')
    expect(pairSibling(view({}), [tp, sl])).toBeNull()
  })

  it('after the cancel: "both" only when the list read again shows the other cancelled too', () => {
    const cancelled = { ...tp, status: 'cancelled' as const }
    expect(endedNote(tp, cancelled, [cancelled, { ...sl, status: 'cancelled' }]).title).toBe('Both orders of the pair are cancelled')
    // The other is trading already: it is followed to the end, and the toast says so.
    expect(endedNote(tp, cancelled, [cancelled, { ...sl, status: 'executing' }])).toEqual({
      title: 'Order cancelled',
      detail: 'The other order of its pair is trading already: its result is followed to the end.',
    })
    // Unknown (no list) or still listed active: the plain message, never a claim about the other.
    expect(endedNote(tp, cancelled, undefined)).toEqual({ title: 'Order cancelled', detail: describeStrategy(tp) })
    expect(endedNote(tp, cancelled, [cancelled, sl]).title).toBe('Order cancelled')
    // It had ended on its own (filled) before the click: said as it is.
    expect(endedNote(tp, { ...tp, status: 'filled' }, [tp, sl])).toEqual({ title: 'Not cancelled: it had ended already', detail: 'It is filled.' })
    expect(endedNote(view({ kind: 'dca' }), view({ kind: 'dca', status: 'stopped' }), undefined).title).toBe('DCA stopped')
  })
})

describe('what a Copy Trade rule or a sniper saw', () => {
  const HASH = '7Hd2kq8yW3vX1sPzN5aBcDeFgHjKmNoPqRsTuVwXyZ1a'

  it('new pools name their exchange and pool; a one-token sniper’s route is just a sighting', () => {
    expect(detectionSourceOf('pool:dcl:abc.near|wrap.near|2000', 'sniper')).toEqual({ kind: 'pool', exchange: 'Ref DCL', poolId: 'abc.near|wrap.near|2000' })
    expect(detectionSourceOf('pool:ref:5123', 'sniper')).toEqual({ kind: 'pool', exchange: 'Ref v2', poolId: '5123' })
    expect(detectionSourceOf(`route:${USDT.id}`, 'sniper')).toEqual({ kind: 'route' })
    expect(detectionTitle(detectionSourceOf('pool:ref:5123', 'sniper'))).toBe('New pool')
  })

  it('a token-for-token swap: the transaction, and its copied legs linked to it', () => {
    expect(detectionSourceOf(HASH, 'copy')).toEqual({ kind: 'tx', txHash: HASH })
    expect(detectionSourceOf(`${HASH}:sell`, 'copy')).toEqual({ kind: 'leg', side: 'sell', txHash: HASH })
    expect(detectionSourceOf(`${HASH}:buy`, 'copy')).toEqual({ kind: 'leg', side: 'buy', txHash: HASH })
    expect(detectionTitle(detectionSourceOf(`${HASH}:sell`, 'copy'))).toBe('Copied sell leg')
    expect(detectionTitle(detectionSourceOf(`${HASH}:buy`, 'copy'))).toBe('Copied buy leg')
    expect(detectionTitle(detectionSourceOf(HASH, 'copy'))).toBeNull()
    expect(detectionSourceOf('not a hash:sell', 'copy')).toEqual({ kind: 'other' })
  })

  it('"detected" is only seen, never a trade or a fill; confirmed only as the server says', () => {
    expect(DETECTION_LAMP.detected.label).toBe('Seen')
    expect(DETECTION_LAMP.detected.label).not.toMatch(/trade|fill|confirm|bought|copied/i)
    expect(detectionLamp('detected', 'sniper').label).toBe('Seen')
    expect(detectionLamp('confirmed', 'sniper').label).toBe('Bought · confirmed')
    expect(detectionLamp('confirmed', 'copy').label).toBe('Copied · confirmed')
    for (const s of ['detected', 'eligible', 'skipped', 'executing', 'submitted', 'failed'] as const) {
      // "Submitted · not confirmed" is the only mention of confirmed before the chain confirms.
      expect(detectionLamp(s, 'sniper').label).not.toMatch(/(?<!not )confirmed|filled/i)
      expect(detectionLamp(s, 'copy').label).not.toMatch(/(?<!not )confirmed|filled/i)
    }
  })
})
