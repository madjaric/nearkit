import type { StrategyKind } from '@/lib/automation/config'
import type { AutomationAccess } from './live/queries'

/**
 * An automation's status as the Documentation states it, from the same answer its page uses:
 * 'nearkits' (NEARKITS' server runs it, from NEARKITS wallets after a Telegram sign-in), 'checking'
 * (the answer is on its way), 'off' (the server answered without it), 'unknown' (the server didn't
 * answer), 'soon' (a build without NEARKITS' server), 'drafts' (the demo and the dev server, whose
 * pages save drafts or standby rules and run nothing).
 */
export type AutomationDocState = 'nearkits' | 'checking' | 'off' | 'unknown' | 'soon' | 'drafts'

export function automationDocState(i: {
  access: AutomationAccess
  /** The build holds the page back (a production build of the real services). */
  comingSoon: boolean
  /** The build names NEARKITS' server. */
  available: boolean
  /** The server's answer is in (the session's or its public /health). */
  known: boolean
}): AutomationDocState {
  if (i.access === 'live' || i.access === 'sign-in') return 'nearkits'
  if (i.access === 'checking') return 'checking'
  if (!i.comingSoon) return 'drafts'
  if (!i.available) return 'soon'
  return i.known ? 'off' : 'unknown'
}

/** The automations by name, in the sidebar's order, as a sentence names them. */
export const AUTOMATION_ORDER: readonly StrategyKind[] = ['limit', 'dca', 'copy', 'sniper']
export const AUTOMATION_NAME: Record<StrategyKind, string> = { limit: 'Limit Orders', dca: 'DCA', copy: 'Copy Trade', sniper: 'the Sniper' }

const listOf = (kinds: readonly StrategyKind[]) => {
  const names = kinds.map((k) => AUTOMATION_NAME[k])
  const text = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? '')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

const ALL = listOf(AUTOMATION_ORDER)

/** The Documentation's Automation paragraph: what runs, where, from which wallets, and what doesn't. */
export function automationSummary(states: Record<StrategyKind, AutomationDocState>, ctx: { network: string; bot: string }): string {
  const live = AUTOMATION_ORDER.filter((k) => states[k] === 'nearkits')
  if (live.length) {
    const rest = AUTOMATION_ORDER.filter((k) => states[k] !== 'nearkits')
    const [runs, them] = live.length > 1 ? ['run', 'them'] : ['runs', 'it']
    return [
      `${listOf(live)} ${runs} on NEARKITS’ server on NEAR ${ctx.network}, from your NEARKITS wallets, within your own settings and NEARKITS’ limits.`,
      `Sign in with Telegram to use ${them}: send /web to ${ctx.bot} for a one-time sign-in link.`,
      `A browser wallet you connect can’t run ${them}: it signs every transaction itself.`,
      ...(rest.length ? [`${listOf(rest)} ${rest.length > 1 ? 'are' : 'is'} not running now (see the table above).`] : []),
    ].join(' ')
  }
  const all = AUTOMATION_ORDER.map((k) => states[k])
  if (all.includes('checking')) return 'Checking which automations NEARKITS’ server runs…'
  if (all.every((s) => s === 'drafts'))
    return 'DCA plans, copy-trade rules, sniper configs and limit orders can be created and managed now. They are saved as drafts in this browser (in standby in the demo): nothing watches prices or wallets, and nothing executes.'
  if (all.includes('off'))
    return `${ALL} are switched off on NEARKITS’ server: nothing watches prices or wallets for them, and nothing executes them. When it switches them on, they run from NEARKITS wallets after a Telegram sign-in; a browser wallet can’t run them.`
  return 'Limit, take-profit and stop-loss orders, DCA, copy trading and the sniper are COMING SOON: nothing watches prices or wallets for them, and nothing executes them yet.'
}
