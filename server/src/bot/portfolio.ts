import { LIMITATION_TEXT } from '@/features/portfolio/pnlText'
import { formatCompact, formatPct, NEAR_FORMAT, USD_FORMAT } from '@/lib/format'
import { describeError } from '@/services/errors'
import { createPnlTracker, type PnlTracker } from '@/services/real/pnlTracker'
import { buildPnlReport } from '@/services/real/pnlReport'
import { historyOf, reportTokenIds, reportTokens, tokenPnl } from '@/services/real/positionsPnl'
import type { PnlLimitation, PnlRange } from '@/types/domain'
import { bold, esc } from '../telegram/html'
import { btn, documented, keyboard, urlBtn, type BotCtx, type BotModule } from './context'

/**
 * /positions and /pnl: the same engine (src/lib/pnl.ts), tracker and report as the
 * web app, over the user's linked accounts. Figures that history can't support are
 * marked partial, with the reason, never filled in.
 */

const trackers = new WeakMap<object, PnlTracker>()
const tracker = (ctx: BotCtx) => {
  let t = trackers.get(ctx.deps.near)
  if (!t) {
    t = createPnlTracker(ctx.deps.near.ctx)
    trackers.set(ctx.deps.near, t)
  }
  return t
}

function accounts(ctx: BotCtx): string[] {
  return ctx.deps.store.linksOf(ctx.user.id, ctx.deps.config.network.id).map((l) => l.accountId)
}

async function needAccounts(ctx: BotCtx): Promise<string[] | null> {
  const list = accounts(ctx)
  if (!list.length) {
    await ctx.reply('Link a NEAR account first to see its positions: /link', keyboard([btn('🔗 Link wallet', 'acct:link')]))
    return null
  }
  return list
}

function limitationsNote(limits: Set<PnlLimitation>): string[] {
  return limits.size ? ['', ...[...limits].map((l) => `⚠️ ${esc(LIMITATION_TEXT[l])}`)] : []
}

async function showPositions(ctx: BotCtx) {
  const list = await needAccounts(ctx)
  if (!list) return
  await ctx.reply('📊 Reading your on-chain history…')
  const near = ctx.deps.near
  try {
    const [ledgers, balances] = await Promise.all([Promise.all(list.map((a) => tracker(ctx).ledger(a))), Promise.all(list.map((a) => near.ctx.balances.get(a)))])
    const held = [...new Set(balances.flatMap((b) => b.fts.map((f) => f.contract)))]
    const tokens = (await near.market.listTokens(held)).filter((t) => t.contract && held.includes(t.id))
    const usd = near.ctx.capabilities.prices
    const money = usd ? USD_FORMAT : NEAR_FORMAT
    const limits = new Set<PnlLimitation>()
    const lines = tokens.map((t) => {
      const perAccount = new Map(balances.map((b) => [b.accountId, b.fts.find((f) => f.contract === t.id)?.raw ?? 0n]))
      const { combined } = tokenPnl(t, ledgers, perAccount)
      for (const l of combined.limitations) limits.add(l)
      const qty = Number([...perAccount.values()].reduce((s, v) => s + v, 0n)) / 10 ** t.decimals
      const value = usd ? (t.market ? qty * t.market.priceUsd : null) : t.market ? qty * t.market.priceNear : null
      const unrealized = usd ? combined.usd.unrealized : combined.near.unrealized === null ? null : Number(combined.near.unrealized) / 1e24
      const cost = usd ? combined.usd.costBasis : Number(combined.near.costBasis) / 1e24
      const pct = unrealized !== null && cost > 0 ? (unrealized / cost) * 100 : null
      return `• ${bold(t.symbol)} ${esc(formatCompact(qty, 2))}${value !== null ? ` ≈ ${esc(money.full(value))}` : ''}${
        unrealized !== null ? ` · unrealized ${esc(money.full(unrealized, { signed: true }))}${pct !== null ? ` (${esc(formatPct(pct, { signed: true, decimals: 1 }))})` : ''}` : ''
      }${combined.complete ? '' : ' · partial'}`
    })
    const nearAvailable = balances.reduce((s, b) => s + (b.state?.availableYocto ?? 0n), 0n)
    await ctx.reply(
      [
        bold(`Positions · ${list.length === 1 ? list[0] : `${list.length} accounts`}`),
        '',
        ...(lines.length ? lines : ['No tokens held.']),
        '',
        `NEAR available: ${esc(NEAR_FORMAT.full(Number(nearAvailable) / 1e24))}`,
        ...limitationsNote(limits),
        '',
        `Average cost from your on-chain history${usd ? '; USD at each trade’s hour' : ', in NEAR (no USD prices on this network)'}.`,
      ].join('\n'),
      keyboard([urlBtn('Open Positions in NearKit', `${ctx.deps.config.webUrl}/positions`)], [btn('📈 PnL', 'pf:pnl')]),
    )
  } catch (e) {
    await ctx.reply(`⚠️ Couldn’t read positions right now: ${esc(describeError(e).message)}`)
  }
}

async function showPnl(ctx: BotCtx, range: PnlRange) {
  const list = await needAccounts(ctx)
  if (!list) return
  await ctx.reply('📈 Reading your on-chain history…')
  const near = ctx.deps.near
  try {
    const ledgers = await Promise.all(list.map((a) => tracker(ctx).ledger(a)))
    const balances = await Promise.all(list.map((a) => near.ctx.balances.get(a)))
    // token → account → raw balance now
    const held = new Map<string, Map<string, bigint>>()
    for (const b of balances) for (const f of b.fts) if (f.raw > 0n) held.set(f.contract, (held.get(f.contract) ?? new Map<string, bigint>()).set(b.accountId, f.raw))
    const listings = new Map((await near.market.listTokens(reportTokenIds(ledgers, held))).map((t) => [t.id, t]))
    const currency = near.ctx.capabilities.prices ? 'USD' : 'NEAR'
    const money = currency === 'USD' ? USD_FORMAT : NEAR_FORMAT
    const tokens = reportTokens({ ledgers, held, listings, currency })
    const history = historyOf(ledgers)
    const gasNear = ledgers.reduce((s, l) => s + Number(l.gasPaid) / 1e24, 0)
    const r = buildPnlReport({ range, now: ctx.deps.now(), currency, tokens, gasNear, history, walletOf: (a) => a })
    const scope = history.complete ? `whole history, ${history.txs} ${history.txs === 1 ? 'transaction' : 'transactions'}` : `latest ${history.txs} transactions only`
    // Unknown reads as —, never 0.
    const fig = (v: number | null) => (v === null ? '—' : money.full(v, { signed: true }))
    const top = r.byToken.slice(0, 5).map((t) => `• ${bold(t.token.symbol)} realized ${esc(fig(t.realizedUsd))} · open ${esc(fig(t.unrealizedUsd))}`)
    await ctx.reply(
      [
        bold(`PnL · ${range === 'all' ? 'all time' : `last ${range}`} · ${list.length === 1 ? list[0] : `${list.length} accounts`}`),
        '',
        `Realized: ${bold(fig(r.realizedUsd))} over ${r.trades} ${r.trades === 1 ? 'sale' : 'sales'}${r.wins + r.losses ? ` (${r.wins} won, ${r.losses} lost)` : ''}`,
        `Unrealized now: ${bold(fig(r.unrealizedUsd))}`,
        `Gas paid (${scope}): ${esc(NEAR_FORMAT.full(r.gasNear ?? 0))}`,
        ...(top.length ? ['', ...top] : []),
        ...limitationsNote(new Set(r.limitations ?? [])),
        '',
        `Average cost, ${currency === 'USD' ? 'USD at each trade’s hour' : 'in NEAR (no USD prices on this network)'}. Swap fees are inside trade values.`,
      ].join('\n'),
      keyboard(
        [btn('7D', 'pf:pnl7d'), btn('30D', 'pf:pnl30d'), btn('90D', 'pf:pnl90d'), btn('All', 'pf:pnlall')],
        [urlBtn('Open PnL in NearKit', `${ctx.deps.config.webUrl}/pnl`)],
      ),
    )
  } catch (e) {
    await ctx.reply(`⚠️ Couldn’t compute PnL right now: ${esc(describeError(e).message)}`)
  }
}

export function portfolioModule(): BotModule {
  return {
    commands: {
      positions: { ...documented('positions'), run: (ctx) => showPositions(ctx) },
      pnl: {
        ...documented('pnl'),
        run: (ctx, args) => {
          const a = args.trim().toLowerCase()
          const range: PnlRange = a === '7d' || a === '30d' || a === '90d' ? a : 'all'
          return showPnl(ctx, range)
        },
      },
    },
    callbacks: {
      pf: async (ctx, action) => {
        await ctx.answer()
        if (action === 'positions') return showPositions(ctx)
        const range = action.replace('pnl', '')
        return showPnl(ctx, range === '7d' || range === '30d' || range === '90d' ? range : 'all')
      },
    },
  }
}
