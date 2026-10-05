import { generateValuePath } from '@/mocks/pnl'
import { SEED_COST_BASIS, TOKEN_IDS } from '@/mocks/tokens'
import { DAY, HOUR, startOfDay } from '@/mocks/time'
import { NEARKIT_FEE_BPS } from '@/lib/fees'
import { executableWallets } from '@/lib/wallets'
import type { PnlPoint, PnlRange, PnlReport, Position, TokenPnl } from '@/types/domain'
import type { PortfolioService } from '../types'
import { balanceOf, nearPrice, tickMarket, tokenOf, wait, type MockState } from './state'

const RANGE_DAYS: Record<PnlRange, number> = { '7d': 7, '30d': 30, '90d': 90, all: 180 }

/** Demo positions always carry every figure; the shared type allows null for real mode. */
type DemoPosition = Position & { avgEntryUsd: number; priceUsd: number; change24hPct: number; valueUsd: number; costUsd: number; pnlUsd: number; pnlPct: number }

export function buildPositions(state: MockState): DemoPosition[] {
  // The portfolio's wallets: a watch-only account's holdings are shown with it, never counted here.
  const executable = new Set(executableWallets(state.wallets).map((w) => w.id))
  const byToken = new Map<string, { walletId: string; amount: number }[]>()
  for (const h of state.holdings) {
    if (h.amount <= 0 || !executable.has(h.walletId)) continue
    const list = byToken.get(h.tokenId) ?? []
    list.push({ walletId: h.walletId, amount: h.amount })
    byToken.set(h.tokenId, list)
  }
  const positions: DemoPosition[] = []
  for (const [tokenId, wallets] of byToken) {
    const token = tokenOf(state, tokenId)
    const market = state.market.get(tokenId)
    const balance = wallets.reduce((s, w) => s + w.amount, 0)
    const priceUsd = market?.priceUsd ?? 0
    const avgEntryUsd = SEED_COST_BASIS[tokenId] ?? priceUsd
    const valueUsd = balance * priceUsd
    const costUsd = balance * avgEntryUsd
    positions.push({
      token,
      balance,
      avgEntryUsd,
      priceUsd,
      change24hPct: market?.change24hPct ?? 0,
      valueUsd,
      costUsd,
      pnlUsd: valueUsd - costUsd,
      pnlPct: costUsd > 0 ? ((valueUsd - costUsd) / costUsd) * 100 : 0,
      wallets: wallets.sort((a, b) => b.amount - a.amount),
    })
  }
  return positions.sort((a, b) => b.valueUsd - a.valueUsd)
}

export function createPortfolioService(state: MockState): PortfolioService {
  return {
    async getSummary() {
      await wait('read')
      tickMarket(state)
      const positions = state.session ? buildPositions(state) : []
      const valueUsd = positions.reduce((s, p) => s + p.valueUsd, 0)
      const pnl24hUsd = positions.reduce((s, p) => s + p.valueUsd * (p.change24hPct / (100 + p.change24hPct)), 0)
      const executable = executableWallets(state.wallets)
      const availableNear = state.session ? executable.reduce((s, w) => s + balanceOf(state, w.id, TOKEN_IDS.near), 0) : 0
      return {
        valueUsd,
        pnl24hUsd,
        pnl24hPct: valueUsd - pnl24hUsd > 0 ? (pnl24hUsd / (valueUsd - pnl24hUsd)) * 100 : 0,
        unrealizedPnlUsd: positions.reduce((s, p) => s + p.pnlUsd, 0),
        availableNear,
        availableNearUsd: availableNear * nearPrice(state),
        mainNear: state.session ? balanceOf(state, 'w01', TOKEN_IDS.near) : 0,
        activePositions: positions.length,
        openOrders: state.session ? state.orders.filter((o) => o.status === 'open').length : 0,
        walletCount: state.session ? state.wallets.length : 0,
        executableWalletCount: state.session ? executable.length : 0,
        updatedAt: Date.now(),
      }
    },

    async listPositions() {
      await wait('read')
      tickMarket(state)
      return state.session ? buildPositions(state) : []
    },

    async getValueHistory(days) {
      await wait('read')
      tickMarket(state)
      if (!state.session) return []
      const current = buildPositions(state).reduce((s, p) => s + p.valueUsd, 0)
      const path = generateValuePath(180)
      // One point every 6 hours; the last day at 15-minute steps.
      const stepMs = days === 1 ? HOUR / 4 : 6 * HOUR
      const steps = Math.round((days * 24 * HOUR) / stepMs)
      const slice = path.slice(-Math.min(steps, path.length))
      const last = slice[slice.length - 1] ?? 1
      const now = Date.now()
      return slice.map((m, i) => ({ t: now - (slice.length - 1 - i) * stepMs, valueUsd: (current * m) / last }))
    },

    async getPnl(range): Promise<PnlReport> {
      await wait('read')
      tickMarket(state)
      const days = RANGE_DAYS[range]
      const today = startOfDay(Date.now())
      const from = today - (days - 1) * DAY
      const trades = state.trades.filter((t) => t.at >= from)
      const points: PnlPoint[] = []
      let cumulative = 0
      for (let d = 0; d < days; d++) {
        const dayStart = from + d * DAY
        const dayTrades = trades.filter((t) => t.at >= dayStart && t.at < dayStart + DAY)
        const daily = dayTrades.reduce((s, t) => s + t.pnlUsd, 0)
        const volumeUsd = dayTrades.reduce((s, t) => s + t.valueUsd + (t.valueUsd - t.pnlUsd), 0)
        cumulative += daily
        points.push({ t: dayStart, daily, cumulative, volumeUsd })
      }
      const positions = buildPositions(state)
      const wins = trades.filter((t) => t.pnlUsd > 0).length
      const volumeUsd = trades.reduce((s, t) => s + t.valueUsd + (t.valueUsd - t.pnlUsd), 0)

      const tokenIds = new Set([...trades.map((t) => t.tokenId), ...positions.map((p) => p.token.id)])
      const byToken: TokenPnl[] = [...tokenIds].map((tokenId) => {
        const tt = trades.filter((t) => t.tokenId === tokenId)
        const w = tt.filter((t) => t.pnlUsd > 0).length
        return {
          token: tokenOf(state, tokenId),
          trades: tt.length,
          volumeUsd: tt.reduce((s, t) => s + t.valueUsd + (t.valueUsd - t.pnlUsd), 0),
          realizedUsd: tt.reduce((s, t) => s + t.pnlUsd, 0),
          unrealizedUsd: positions.find((p) => p.token.id === tokenId)?.pnlUsd ?? 0,
          winRatePct: tt.length ? (w / tt.length) * 100 : 0,
        }
      })
      byToken.sort((a, b) => (b.realizedUsd ?? 0) + (b.unrealizedUsd ?? 0) - ((a.realizedUsd ?? 0) + (a.unrealizedUsd ?? 0)))

      return {
        range,
        points,
        realizedUsd: cumulative,
        unrealizedUsd: positions.reduce((s, p) => s + p.pnlUsd, 0),
        volumeUsd,
        feesUsd: (volumeUsd * NEARKIT_FEE_BPS) / 10_000,
        trades: trades.length,
        wins,
        losses: trades.length - wins,
        winRatePct: trades.length ? (wins / trades.length) * 100 : 0,
        byToken,
        recentTrades: [...trades].sort((a, b) => b.at - a.at).slice(0, 12),
      }
    },

    async listActivity(limit = 20) {
      await wait('read')
      return state.session ? state.activity.slice(0, limit).map((a) => ({ ...a })) : []
    },
  }
}
