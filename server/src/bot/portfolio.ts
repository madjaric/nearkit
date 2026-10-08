import { LIMITATION_TEXT } from '@/features/portfolio/pnlText'
import { formatCompact, formatPct, NEAR_FORMAT, USD_FORMAT } from '@/lib/format'
import { createPnlTracker, type PnlTracker } from '@/services/real/pnlTracker'
import { buildPnlReport } from '@/services/real/pnlReport'
import { historyOf, reportTokenIds, reportTokens, tokenPnl } from '@/services/real/positionsPnl'
import type { PnlLimitation, PnlRange } from '@/types/domain'
import { bold, code, esc } from '../telegram/html'
import { btn, documented, keyboard, urlBtn, type BotCtx, type BotModule } from './context'
import { friendlyError, LIMITATION_TAG, nearText, UNKNOWN } from './ui'

/**
 * /positions and /pnl: the same engine (src/lib/pnl.ts), tracker and report as the
 * web app, over the user's linked accounts. The first screen is compact; Details has
 * the full figures and every reason a figure is partial. Unknown is shown as —.
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

/** The NearKit wallet first (when there is one), then the linked accounts. */
/** After a trade: the next Positions/PnL reads the chain again (no optimistic figures). */
export function refreshPortfolio(deps: BotCtx['deps'], accountId: string) {
  deps.near.ctx.balances.invalidate(accountId)
  trackers.get(deps.near)?.invalidate(accountId)
}

async function accounts(ctx: BotCtx): Promise<string[]> {
  // Every NearKit wallet of the user, then the linked wallets.
  const nearkit = ((await ctx.deps.custody?.store.activeWallets(ctx.user.id, ctx.deps.config.network.id)) ?? []).map((w) => w.accountId)
  return [...nearkit, ...(await ctx.deps.store.linksOf(ctx.user.id, ctx.deps.config.network.id)).map((l) => l.accountId)]
}

async function needAccounts(ctx: BotCtx): Promise<string[] | null> {
  const list = await accounts(ctx)
  if (!list.length) {
    await ctx.reply('Link a NEAR account or create a NEARKITS wallet first to see positions.', keyboard([btn('🔗 Link wallet', 'acct:link'), btn('👛 Wallet', 'menu:wallet')]))
    return null
  }
  return list
}

const who = (list: string[]) => (list.length === 1 ? code(list[0] as string) : `${list.length} accounts`)
/** The first reason a figure is unknown or partial, in a few words. */
const tag = (limits: readonly PnlLimitation[]) => (limits.length ? ` · ${LIMITATION_TAG[limits[0] as PnlLimitation]}` : '')
const num = (v: number | bigint | null) => (v === null ? null : typeof v === 'bigint' ? Number(v) / 1e24 : v)

function limitationsNote(limits: Set<PnlLimitation>): string[] {
  return limits.size ? ['', ...[...limits].map((l) => `⚠️ ${esc(LIMITATION_TEXT[l])}`)] : []
}

async function showPositions(ctx: BotCtx, details: boolean) {
  const list = await needAccounts(ctx)
  if (!list) return
  if (!ctx.message) await ctx.reply('📊 Reading your on-chain history…')
  const near = ctx.deps.near
  const usd = near.ctx.capabilities.prices
  const money = usd ? USD_FORMAT : NEAR_FORMAT
  try {
    const [ledgers, balances] = await Promise.all([Promise.all(list.map((a) => tracker(ctx).ledger(a))), Promise.all(list.map((a) => near.ctx.balances.get(a)))])
    const held = [...new Set(balances.flatMap((b) => b.fts.map((f) => f.contract)))]
    const tokens = (await near.market.listTokens(held)).filter((t) => t.contract && held.includes(t.id))
    const limits = new Set<PnlLimitation>()
    const blocks = tokens.map((t) => {
      const perAccount = new Map(balances.map((b) => [b.accountId, b.fts.find((f) => f.contract === t.id)?.raw ?? 0n]))
      const { combined } = tokenPnl(t, ledgers, perAccount)
      for (const l of combined.limitations) limits.add(l)
      const qty = Number([...perAccount.values()].reduce((s, v) => s + v, 0n)) / 10 ** t.decimals
      const value = t.market ? (usd ? qty * t.market.priceUsd : qty * t.market.priceNear) : null
      const f = usd ? combined.usd : combined.near
      const unrealized = num(f.unrealized)
      const cost = num(f.costBasis)
      const pct = unrealized !== null && cost !== null && cost > 0 ? (unrealized / cost) * 100 : null
      const pnl =
        unrealized === null
          ? `${UNKNOWN}${tag(combined.limitations)}`
          : `${money.full(unrealized, { signed: true })}${pct !== null ? ` (${formatPct(pct, { signed: true, decimals: 1 })})` : ''}${combined.complete ? '' : ' · partial'}`
      const head = `${bold(t.symbol)} · ${esc(formatCompact(qty, 2))}${value !== null ? ` ≈ ${esc(money.full(value))}` : ''}`
      if (!details) return [head, `PnL ${esc(pnl)}`].join('\n')
      const costKnown = f.avgEntry !== null || combined.quantity === 0n
      return [
        head,
        `PnL ${esc(pnl)}`,
        `Cost ${costKnown && cost !== null ? esc(money.full(cost)) : UNKNOWN} · avg entry ${f.avgEntry === null ? UNKNOWN : esc(money.full(f.avgEntry))}`,
        `Realized ${esc(money.full(num(f.realized) ?? 0, { signed: true }))} · ${combined.trades} ${combined.trades === 1 ? 'trade' : 'trades'}`,
      ].join('\n')
    })
    const nearNow = balances.reduce((s, b) => s + (b.state?.availableYocto ?? 0n), 0n)
    await ctx.show(
      [
        `📊 ${bold('Positions')} · ${who(list)}`,
        '',
        ...(blocks.length ? [blocks.join('\n\n')] : ['No tokens held.']),
        '',
        `NEAR ${bold(nearText(nearNow))}`,
        ...(details
          ? [...limitationsNote(limits), '', `Average cost from your on-chain history${usd ? '; USD at each trade’s hour' : ', in NEAR (no USD prices on this network)'}.`]
          : []),
      ].join('\n'),
      keyboard(
        [btn(details ? '🔎 Less' : '🔎 Details', details ? 'pf:positions' : 'pf:posdetails'), btn('📈 PnL', 'pf:pnl')],
        ...(details ? [[urlBtn('Open in NEARKITS', `${ctx.deps.config.webUrl}/positions`)]] : []),
        [btn('🔄 Refresh', details ? 'pf:posdetails' : 'pf:positions'), btn('« Menu', 'menu:home')],
      ),
    )
  } catch (e) {
    await ctx.reply(`⚠️ Couldn’t read positions: ${esc(friendlyError(e, { network: ctx.deps.config.network.id, log: ctx.deps.log, context: 'positions failed' }))}`)
  }
}

async function showPnl(ctx: BotCtx, range: PnlRange, details: boolean) {
  const list = await needAccounts(ctx)
  if (!list) return
  if (!ctx.message) await ctx.reply('📈 Reading your on-chain history…')
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
    const gas = ledgers.flatMap((l) => l.gas.map((g) => ({ at: g.at, near: Number(g.yocto) / 1e24 })))
    // Telegram states gas over the whole history read, whatever the range (its line below says so).
    const gasNear = ledgers.reduce((s, l) => s + Number(l.gasPaid) / 1e24, 0)
    const r = buildPnlReport({ range, now: ctx.deps.now(), currency, tokens, gas, history, walletOf: (a) => a })
    const scope = history.complete ? `whole history, ${history.txs} ${history.txs === 1 ? 'transaction' : 'transactions'}` : `latest ${history.txs} transactions only`
    // Unknown reads as —, never 0.
    const fig = (v: number | null) => (v === null ? UNKNOWN : money.full(v, { signed: true }))
    const limits = r.limitations ?? []
    const unknownWhy = r.unrealizedUsd === null ? tag(limits.includes('no-current-price') ? ['no-current-price'] : limits) : ''
    const lines = [
      `📈 ${bold('PnL')} · ${range === 'all' ? 'all time' : `last ${range}`} · ${who(list)}`,
      '',
      `Realized ${bold(fig(r.realizedUsd))} · ${r.trades} ${r.trades === 1 ? 'sale' : 'sales'}${r.wins + r.losses ? ` (${r.wins} won, ${r.losses} lost)` : ''}`,
      `Unrealized ${bold(fig(r.unrealizedUsd))}${esc(unknownWhy)}${r.complete === false && r.unrealizedUsd !== null ? ' · partial' : ''}`,
      `Gas ${esc(NEAR_FORMAT.full(gasNear))}`,
    ]
    if (details) {
      const top = r.byToken.slice(0, 8).map((t) => `• ${bold(t.token.symbol)} realized ${esc(fig(t.realizedUsd))} · open ${esc(fig(t.unrealizedUsd))}`)
      lines.push(
        ...(top.length ? ['', ...top] : []),
        ...limitationsNote(new Set(limits)),
        '',
        `Gas counted over the ${esc(scope)}. Average cost, ${currency === 'USD' ? 'USD at each trade’s hour' : 'in NEAR (no USD prices on this network)'}. Swap fees are inside trade values.`,
      )
    }
    const d = details ? 'd' : ''
    await ctx.show(
      lines.join('\n'),
      keyboard(
        [btn('7D', `pf:pnl7d${d}`), btn('30D', `pf:pnl30d${d}`), btn('90D', `pf:pnl90d${d}`), btn('All', `pf:pnlall${d}`)],
        [btn(details ? '🔎 Less' : '🔎 Details', `pf:pnl${range}${details ? '' : 'd'}`), btn('📊 Positions', 'pf:positions')],
        ...(details ? [[urlBtn('Open in NEARKITS', `${ctx.deps.config.webUrl}/pnl`)]] : []),
        [btn('« Menu', 'menu:home')],
      ),
    )
  } catch (e) {
    await ctx.reply(`⚠️ Couldn’t compute PnL: ${esc(friendlyError(e, { network: ctx.deps.config.network.id, log: ctx.deps.log, context: 'pnl failed' }))}`)
  }
}

/** pnl, pnl7d, pnl7dd (details), pnlall, pnlalld… */
const PNL_ACTION = /^pnl(7d|30d|90d|all)?(d)?$/

export function portfolioModule(): BotModule {
  return {
    commands: {
      positions: { ...documented('positions'), run: (ctx, args) => showPositions(ctx, /details/i.test(args)) },
      pnl: {
        ...documented('pnl'),
        run: (ctx, args) => {
          const a = args.trim().toLowerCase()
          const range: PnlRange = /\b7d\b/.test(a) ? '7d' : /\b30d\b/.test(a) ? '30d' : /\b90d\b/.test(a) ? '90d' : 'all'
          return showPnl(ctx, range, /details/.test(a))
        },
      },
    },
    callbacks: {
      pf: async (ctx, action) => {
        await ctx.answer()
        if (action === 'positions') return showPositions(ctx, false)
        if (action === 'posdetails') return showPositions(ctx, true)
        const m = PNL_ACTION.exec(action)
        return showPnl(ctx, (m?.[1] as PnlRange | undefined) ?? 'all', m?.[2] === 'd')
      },
    },
  }
}
