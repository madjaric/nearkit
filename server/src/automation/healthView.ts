import type { AutomationKind } from '../config'

/**
 * What /health says about trading automation (secret-free): the kinds the worker runs, and whether
 * snipers may buy — only when the worker runs Sniper and NEARKITS switched buying on
 * (NEARKIT_AUTOMATION_SNIPER_BUY). Each buy still needs its owner's explicit yes.
 */
export function automationHealth(running: boolean, enabled: ReadonlySet<AutomationKind>, sniperBuy: boolean): { automation: string; sniperBuy: 'on' | 'off' } {
  return {
    automation: running ? [...enabled].join(',') || 'off' : 'off',
    sniperBuy: running && enabled.has('sniper') && sniperBuy ? 'on' : 'off',
  }
}
