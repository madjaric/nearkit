import { describe, expect, it } from 'vitest'
import type { StrategyKind } from '@/lib/automation/config'
import { automationDocState, automationSummary, type AutomationDocState } from './status'

const held = { access: 'held' as const, comingSoon: true, available: true, known: true }

describe('an automation’s row in the Documentation status table', () => {
  it('the server runs it: live from NEARKITS wallets, with or without a session yet', () => {
    expect(automationDocState({ ...held, access: 'live' })).toBe('nearkits')
    expect(automationDocState({ ...held, access: 'sign-in' })).toBe('nearkits')
  })

  it('the answer is on its way: checking, never a guess', () => {
    expect(automationDocState({ ...held, access: 'checking', known: false })).toBe('checking')
  })

  it('a mainnet build whose server answered without it: switched off on the server', () => {
    expect(automationDocState(held)).toBe('off')
  })

  it('a mainnet build whose server didn’t answer: unknown; a build without the server: not live here', () => {
    expect(automationDocState({ ...held, known: false })).toBe('unknown')
    expect(automationDocState({ ...held, available: false, known: false })).toBe('soon')
  })

  it('the demo and the dev server (nothing held back): drafts, as their pages save them', () => {
    expect(automationDocState({ ...held, comingSoon: false })).toBe('drafts')
    expect(automationDocState({ ...held, comingSoon: false, available: false, known: false })).toBe('drafts')
  })
})

const all = (state: AutomationDocState): Record<StrategyKind, AutomationDocState> => ({ limit: state, dca: state, copy: state, sniper: state })
const ctx = { network: 'mainnet', bot: '@NearKitBot' }

describe('the Documentation’s Automation paragraph', () => {
  it('all four live: where they run, from which wallets, how to sign in, and that a browser wallet can’t run them', () => {
    const text = automationSummary(all('nearkits'), ctx)
    expect(text).toMatch(/^Limit Orders, DCA, Copy Trade and the Sniper run on NEARKITS’ server on NEAR mainnet, from your NEARKITS wallets/)
    expect(text).toContain('send /web to @NearKitBot')
    expect(text).toMatch(/A browser wallet you connect can’t run them/)
    expect(text).not.toMatch(/coming soon|not running/i)
  })

  it('some live: those named as live, the rest as not running now', () => {
    const text = automationSummary({ limit: 'nearkits', dca: 'nearkits', copy: 'off', sniper: 'off' }, ctx)
    expect(text).toMatch(/^Limit Orders and DCA run on NEARKITS’ server on NEAR mainnet/)
    expect(text).toMatch(/Copy Trade and the Sniper are not running now/)
  })

  it('the server runs none: switched off, and how they would run', () => {
    const text = automationSummary(all('off'), ctx)
    expect(text).toMatch(/^Limit Orders, DCA, Copy Trade and the Sniper are switched off on NEARKITS’ server: nothing watches prices or wallets for them/)
    expect(text).toMatch(/a browser wallet can’t run them/)
  })

  it('checking, the demo’s and dev’s drafts, and a build without the server', () => {
    expect(automationSummary({ ...all('off'), limit: 'checking' }, ctx)).toMatch(/^Checking which automations NEARKITS’ server runs/)
    expect(automationSummary(all('drafts'), ctx)).toMatch(/saved as drafts in this browser \(in standby in the demo\): nothing watches prices or wallets, and nothing executes/)
    expect(automationSummary(all('soon'), ctx)).toMatch(/COMING SOON: nothing watches prices or wallets for them, and nothing executes them yet/)
    expect(automationSummary(all('unknown'), ctx)).toMatch(/COMING SOON/)
  })
})

describe('the Automation paragraph with one automation live', () => {
  it('says it in the singular', () => {
    const text = automationSummary({ limit: 'off', dca: 'nearkits', copy: 'off', sniper: 'off' }, ctx)
    expect(text).toMatch(/^DCA runs on NEARKITS’ server on NEAR mainnet/)
    expect(text).toContain('Sign in with Telegram to use it:')
    expect(text).toContain('A browser wallet you connect can’t run it:')
    expect(text).toMatch(/Limit Orders, Copy Trade and the Sniper are not running now/)
  })
})
