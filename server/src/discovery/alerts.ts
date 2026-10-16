import type { Logger } from '../log'
import { esc } from '../telegram/html'
import type { TokenAction } from './accounting'
import type { DiscoveryStore } from './store'

/**
 * Alerts for followed wallets (DISCOVERY.md): when a wallet a NEARKITS user follows with alerts on
 * swaps, the bot tells them, once per transaction, with the transaction's link. Evidence only: no
 * advice, no prediction. At most ALERTS_PER_WINDOW messages per user per ALERT_WINDOW_MS, so a busy
 * wallet can't flood anyone.
 */

export const ALERTS_PER_WINDOW = 20
export const ALERT_WINDOW_MS = 10 * 60_000
const FOLLOWERS_TTL = 60_000

const usd = (v: number | null) => (v === null ? '' : ` for $${v >= 1000 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2)}`)

export function createDiscoveryAlerts(deps: {
  store: DiscoveryStore
  network: { id: string; explorerUrl: string }
  webUrl: string
  notify: (userId: number, html: string) => Promise<unknown>
  log: Logger
  now?: () => number
}): (actions: readonly TokenAction[]) => Promise<void> {
  const now = deps.now ?? Date.now
  let followers = new Map<string, number[]>()
  let loadedAt = -Infinity
  const sent = new Map<number, number[]>()

  const allowed = (userId: number): boolean => {
    const t = now()
    const recent = (sent.get(userId) ?? []).filter((x) => t - x < ALERT_WINDOW_MS)
    if (recent.length >= ALERTS_PER_WINDOW) {
      sent.set(userId, recent)
      return false
    }
    sent.set(userId, [...recent, t])
    return true
  }

  return async (actions) => {
    if (now() - loadedAt > FOLLOWERS_TTL) {
      followers = await deps.store.alertFollowers(deps.network.id)
      loadedAt = now()
    }
    if (followers.size === 0) return
    // One message per wallet and transaction (a token-for-token swap is one sale and one purchase).
    const groups = new Map<string, TokenAction[]>()
    for (const a of actions) {
      if (!followers.has(a.trader)) continue
      const key = `${a.trader}\u0000${a.tx}`
      groups.set(key, [...(groups.get(key) ?? []), a])
    }
    if (groups.size === 0) return
    const symbols = await deps.store.tokens(deps.network.id, [...new Set([...groups.values()].flat().map((a) => a.token))])
    for (const legs of groups.values()) {
      const first = legs[0] as TokenAction
      const parts = legs.map((a) => `${a.side === 'buy' ? 'bought' : 'sold'} <b>${esc(symbols.get(a.token)?.symbol ?? a.token)}</b>${usd(a.usd)}`)
      const html = [
        `👛 <b>${esc(first.trader)}</b> ${parts.join(' and ')}`,
        `<a href="${deps.network.explorerUrl}/txns/${encodeURIComponent(first.tx)}">Transaction</a> · <a href="${deps.webUrl}/top-wallets/${encodeURIComponent(first.trader)}">Wallet on NEARKITS</a>`,
        '<i>A wallet you follow on NEARKITS Top Wallets. Not advice.</i>',
      ].join('\n')
      for (const userId of followers.get(first.trader) ?? []) {
        if (!allowed(userId)) continue
        await deps.notify(userId, html).catch((e: unknown) => deps.log.warn('discovery alert not sent', { error: e instanceof Error ? e.message : String(e) }))
      }
    }
  }
}
