import { frequencyOf } from '@/features/automation/dca'
import { conditionOf, intervalLabel, KIND_LABEL, ORDER_TYPE_LABEL, sourcesText } from '@/features/automation/live/model'
import type { StrategyView } from '@/lib/automation/api'
import { FINAL_STATUSES, type StrategyKind, type StrategyStatus } from '@/lib/automation/config'
import { formatNumber, formatUsdPrice } from '@/lib/format'
import type { CopyRule, DcaPlan, LimitOrder, SniperConfig, TokenListing } from '@/types/domain'

/**
 * The Dashboard's Active Strategies, from what each source says about itself: NEARKITS' server
 * (real automation, a NEARKITS web session) or the demo's seeded orders and rules. A strategy is
 * listed while it can still act (watching, paused or settling a trade); one that ended is not.
 */

export type StrategyLampState = { source: 'server'; status: StrategyStatus } | { source: 'demo'; status: 'open' | 'standby' }

export interface StrategyRow {
  id: string
  kind: StrategyKind
  /** "Limit buy", "Take profit", "DCA", "Copy Trade", "Sniper". */
  type: string
  /** The token traded against NEAR ("KITS / NEAR"), the account followed, or "New pools". */
  subject: string
  /** The traded token's id, when there is one (its glyph and page). */
  tokenId: string | null
  trigger: string
  amount: string
  lamp: StrategyLampState
  createdAt: number
  /** The page that manages it. */
  href: string
}

export const KIND_PAGE: Record<StrategyKind, string> = { limit: '/limit-orders', dca: '/dca', copy: '/copy-trade', sniper: '/sniper' }

/** Short names for the metric's caption, in the sidebar's order. */
export const KIND_SHORT: Record<StrategyKind, string> = { limit: 'limit', dca: 'dca', copy: 'copy', sniper: 'sniper' }
const KIND_ORDER: readonly StrategyKind[] = ['limit', 'dca', 'copy', 'sniper']

const n = (v: number) => formatNumber(v, 0, 4)
const pair = (symbol: string) => `${symbol} / NEAR`

/** Still able to act: not ended, not a draft nothing runs. */
export const isActiveStatus = (status: StrategyStatus) => status !== 'draft' && !FINAL_STATUSES.includes(status)

export function rowFromServer(s: StrategyView): StrategyRow {
  const base = { id: s.id, kind: s.kind, lamp: { source: 'server', status: s.status } as const, createdAt: s.createdAt, href: KIND_PAGE[s.kind] }
  const c = s.config
  switch (c.kind) {
    case 'limit': {
      const l = c.limit
      const amount =
        l.amount.kind === 'percent' ? `${l.amount.value}% of ${l.token.symbol}` : l.amount.kind === 'near' ? `${l.amount.value} NEAR` : `${l.amount.value} ${l.token.symbol}`
      return { ...base, type: ORDER_TYPE_LABEL[l.type], subject: pair(l.token.symbol), tokenId: l.token.id, trigger: `${conditionOf(l.type)} ${l.triggerPriceNear} NEAR`, amount }
    }
    case 'dca':
      return {
        ...base,
        type: KIND_LABEL.dca,
        subject: pair(c.dca.token.symbol),
        tokenId: c.dca.token.id,
        trigger: `Every ${intervalLabel(c.dca.everySec)}`,
        amount: `${n(c.dca.amountNear)} NEAR`,
      }
    case 'copy': {
      const k = c.copy
      return {
        ...base,
        type: KIND_LABEL.copy,
        subject: k.target,
        tokenId: null,
        trigger: k.copy === 'both' ? 'Copies buys and sells' : `Copies ${k.copy}s`,
        amount: k.sizing.mode === 'fixed' ? `${n(k.sizing.amountNear)} NEAR each · max ${n(k.maxTradeNear)}` : `${n(k.sizing.pct)}% · max ${n(k.maxTradeNear)} NEAR`,
      }
    }
    case 'sniper': {
      const k = c.sniper
      const buys = k.mode === 'execute'
      if (k.target === 'new-pools')
        return {
          ...base,
          type: KIND_LABEL.sniper,
          subject: 'New pools',
          tokenId: null,
          trigger: `${buys ? 'Buys' : 'Notifies'} · ${sourcesText(k.sources)}`,
          amount: buys ? `${n(k.amountNear)} NEAR each · up to ${k.maxBuys}` : `${n(k.amountNear)} NEAR each`,
        }
      return {
        ...base,
        type: KIND_LABEL.sniper,
        subject: k.token ? pair(k.token.symbol) : 'A token',
        tokenId: k.token?.id ?? null,
        trigger: buys ? 'Buys when it trades' : 'Notifies when it trades',
        amount: `${n(k.amountNear)} NEAR`,
      }
    }
  }
}

/** The server's strategies that can still act, newest first. */
export function serverRows(list: readonly StrategyView[]): StrategyRow[] {
  return list
    .filter((s) => isActiveStatus(s.status))
    .map(rowFromServer)
    .sort((a, b) => b.createdAt - a.createdAt)
}

/** The demo's seeded open orders and standby rules (simulated: nothing watches or executes them), newest first. */
export function demoRows(input: {
  orders: readonly LimitOrder[]
  dca: readonly DcaPlan[]
  copy: readonly CopyRule[]
  sniper: readonly SniperConfig[]
  tokens: readonly TokenListing[]
}): StrategyRow[] {
  const symbol = (id: string) => input.tokens.find((t) => t.id === id)?.symbol ?? id
  const rows: StrategyRow[] = [
    ...input.orders
      .filter((o) => o.status === 'open')
      .map((o): StrategyRow => {
        const type = o.type === 'limit' ? (o.side === 'buy' ? 'Limit buy' : 'Limit sell') : o.type === 'take-profit' ? 'Take profit' : 'Stop loss'
        const cond = o.type === 'take-profit' || (o.type === 'limit' && o.side === 'sell') ? '≥' : '≤'
        return {
          id: o.id,
          kind: 'limit',
          type,
          subject: pair(symbol(o.tokenId)),
          tokenId: o.tokenId,
          trigger: `${cond} ${formatUsdPrice(o.triggerPriceUsd)}`,
          amount: o.side === 'buy' ? `${n(o.amount)} NEAR` : `${n(o.amount)} ${symbol(o.tokenId)}`,
          lamp: { source: 'demo', status: 'open' },
          createdAt: o.createdAt,
          href: KIND_PAGE.limit,
        }
      }),
    ...input.dca
      .filter((d) => d.status === 'standby')
      .map((d): StrategyRow => ({
        id: d.id,
        kind: 'dca',
        type: KIND_LABEL.dca,
        subject: pair(symbol(d.tokenId)),
        tokenId: d.tokenId,
        trigger: `Every ${frequencyOf(d.frequency).label}`,
        amount: `${n(d.amountNear)} NEAR`,
        lamp: { source: 'demo', status: 'standby' },
        createdAt: d.createdAt,
        href: KIND_PAGE.dca,
      })),
    ...input.copy
      .filter((c) => c.status === 'standby')
      .map((c): StrategyRow => ({
        id: c.id,
        kind: 'copy',
        type: KIND_LABEL.copy,
        subject: c.target,
        tokenId: null,
        trigger: c.copy === 'both' ? 'Copies buys and sells' : `Copies ${c.copy}s`,
        amount: c.sizing.mode === 'fixed' ? `${n(c.sizing.amountNear)} NEAR each · max ${n(c.maxTradeNear)}` : `${n(c.sizing.pct)}% · max ${n(c.maxTradeNear)} NEAR`,
        lamp: { source: 'demo', status: 'standby' },
        createdAt: c.createdAt,
        href: KIND_PAGE.copy,
      })),
    ...input.sniper
      .filter((s) => s.status === 'standby')
      .map((s): StrategyRow => ({
        id: s.id,
        kind: 'sniper',
        type: KIND_LABEL.sniper,
        subject: pair(symbol(s.target)),
        tokenId: input.tokens.some((t) => t.id === s.target) ? s.target : null,
        trigger: s.trigger === 'liquidity-added' ? 'When liquidity is added' : s.trigger === 'first-trade' ? 'On the first trade' : 'At a set time',
        amount: `${n(s.amountNearPerWallet)} NEAR per wallet`,
        lamp: { source: 'demo', status: 'standby' },
        createdAt: s.createdAt,
        href: KIND_PAGE.sniper,
      })),
  ]
  return rows.sort((a, b) => b.createdAt - a.createdAt)
}

/** The kinds present, in the sidebar's order: "limit · dca · copy". */
export function kindsCaption(rows: readonly StrategyRow[]): string | null {
  const kinds = KIND_ORDER.filter((k) => rows.some((r) => r.kind === k))
  return kinds.length ? kinds.map((k) => KIND_SHORT[k]).join(' · ') : null
}

/** How many of each kind are listed (the featured tools' counters). */
export function countByKind(rows: readonly StrategyRow[]): Record<StrategyKind, number> {
  const out: Record<StrategyKind, number> = { limit: 0, dca: 0, copy: 0, sniper: 0 }
  for (const r of rows) out[r.kind] += 1
  return out
}

/** Why nothing is listed in real mode: no figure stands in for a strategy that can't exist here. */
export type StrategiesOff = 'signed-out' | 'session-ended' | 'no-session' | 'unavailable' | 'not-enabled'

/**
 * Why no strategy is listed: a session that ended, a build without NEARKITS' server, no session
 * (sign in, while the server runs automations or hasn't said yet), or none switched on ("coming soon").
 * `serverKinds` is NEARKITS' public answer (/health): an empty list means it runs none.
 */
export function strategiesOff(i: {
  sessionEnded: boolean
  available: boolean
  session: boolean
  signedOut: boolean
  serverKinds: readonly StrategyKind[] | null | undefined
}): StrategiesOff {
  if (i.sessionEnded) return 'session-ended'
  if (!i.available) return 'unavailable'
  if (i.session) return 'not-enabled'
  if (i.serverKinds?.length === 0) return 'not-enabled'
  return i.signedOut ? 'signed-out' : 'no-session'
}
