import { NEAR_DECIMALS } from '@/config/networks'
import { formatUnits } from '@/lib/amounts'
import { MAX_LIVE_BOTS_PER_USER } from '@/lib/volumeBot/config'
import { pnlNear } from '@/lib/volumeBot/inventory'
import { bold, esc } from '../telegram/html'
import { freshRunState } from '../volumebot/runner'
import type { VolumeBot, VolumeBotStore } from '../volumebot/store'
import { btn, documented, keyboard, urlBtn, type BotCtx, type BotModule } from './context'

/**
 * /volume: the user's Volume Bots in Telegram. Status (volume, PnL, trades, exposure, the last
 * trade, why it waits or paused), and Start, Pause, Resume and Stop. Configuring one happens on
 * NEARKITS web; Telegram never shows a key or a secret.
 */

const STATUS_WORD: Record<VolumeBot['status'], string> = {
  draft: '⚪ Not started',
  running: '🟢 Running',
  paused: '⏸ Paused',
  stopping: '⏹ Stopping',
  stopped: '⏹ Stopped',
  completed: '✅ Completed',
}

const n = (v: number, digits = 4) => (Number.isFinite(v) ? v.toFixed(digits).replace(/\.?0+$/, '') || '0' : '—')

function storeOf(ctx: BotCtx): VolumeBotStore | null {
  return ctx.deps.volumeBots ?? null
}

async function card(store: VolumeBotStore, b: VolumeBot, now: number): Promise<string> {
  const run = await store.currentRun(b.id)
  const trades = run ? await store.tradesOfRun(run.id) : []
  const done = trades.filter((t) => t.status === 'confirmed')
  const volume = done.reduce((s, t) => s + (t.nearRaw ? Number(formatUnits(BigInt(t.nearRaw), NEAR_DECIMALS)) : 0), 0)
  const st = run?.state
  const price = st?.prevMarket?.midNear ?? null
  const pnl = st && price !== null ? Object.values(st.books).reduce((s, book) => s + pnlNear(book, price), 0) : null
  const held = st?.expected ?? []
  const value = price !== null ? held.reduce((s, w) => s + w.near + w.tokens * price, 0) : 0
  const exposure = price !== null && value > 0 ? (held.reduce((s, w) => s + w.tokens * price, 0) / value) * 100 : null
  const last = done.at(-1)
  return [
    `🤖 ${bold(`Volume Bot · ${b.config.tokenSymbol}`)} · ${esc(b.strategy)}`,
    STATUS_WORD[b.status] + (b.pauseReason && (b.status === 'paused' || b.status === 'stopping') ? `: ${esc(b.pauseReason)}` : ''),
    `Volume ${bold(`${n(volume)} NEAR`)} · ${done.length} trade${done.length === 1 ? '' : 's'}${trades.length > done.length ? ` · ${trades.length - done.length} failed or in flight` : ''}`,
    `PnL ${pnl === null ? '—' : bold(`${pnl >= 0 ? '+' : ''}${n(pnl)} NEAR`)} · exposure ${exposure === null ? '—' : `${n(exposure, 1)}%`}`,
    last ? `Last trade ${last.side === 'buy' ? 'BUY' : 'SELL'} ${Math.max(0, Math.round((now - last.createdAt) / 60_000))} min ago` : 'No trade yet',
    ...(b.status === 'running' && st?.waiting ? [`Now: ${esc(st.waiting)}`] : []),
  ].join('\n')
}

function controls(b: VolumeBot) {
  const row =
    b.status === 'running'
      ? [btn('⏸ Pause', `vb:p:${b.id}`), btn('⏹ Stop', `vb:s:${b.id}`)]
      : b.status === 'paused'
        ? [btn('▶️ Resume', `vb:r:${b.id}`), btn('⏹ Stop', `vb:s:${b.id}`)]
        : b.status === 'stopping'
          ? []
          : [btn('▶️ Start', `vb:go:${b.id}`)]
  return row
}

async function showStatus(ctx: BotCtx): Promise<void> {
  const store = storeOf(ctx)
  if (!store) return void (await ctx.reply('The Volume Bot isn’t available on this server.'))
  const bots = await store.ofUser(ctx.user.id, ctx.deps.config.network.id)
  const console = urlBtn('🌐 Open the Volume Bot console', `${ctx.deps.config.webUrl}/volume-bot/console`)
  if (bots.length === 0)
    return void (await ctx.show(
      `🤖 ${bold('Volume Bot')}\nNo bot yet. Configure one on NEARKITS web (token, strategy, wallets and every limit), then start it there or with /volume start.`,
      keyboard([console]),
    ))
  const shown = bots.slice(0, 3)
  const cards = await Promise.all(shown.map((b) => card(store, b, ctx.deps.now())))
  await ctx.show(cards.join('\n\n'), keyboard(...shown.map(controls).filter((r) => r.length > 0), [console]))
}

/** The one bot an action means: the only one it applies to, or (several) a choice. */
async function pick(ctx: BotCtx, statuses: readonly VolumeBot['status'][], verb: string): Promise<VolumeBot | null> {
  const store = storeOf(ctx)
  if (!store) return null
  const fits = (await store.ofUser(ctx.user.id, ctx.deps.config.network.id)).filter((b) => statuses.includes(b.status))
  if (fits.length === 1) return fits[0] as VolumeBot
  if (fits.length === 0) {
    await ctx.reply(`No Volume Bot to ${verb}. /volume shows yours.`)
    return null
  }
  await ctx.reply(`Which bot?`, keyboard(...fits.slice(0, 6).map((b) => [btn(`${b.config.tokenSymbol} · ${b.strategy}`, `vb:${verb === 'start' ? 'go' : verb[0]}:${b.id}`)])))
  return null
}

async function act(ctx: BotCtx, action: string, botId: string): Promise<void> {
  const store = storeOf(ctx)
  if (!store) return
  const b = await store.owned(ctx.user.id, botId)
  if (!b) return void (await ctx.reply('That Volume Bot isn’t one of yours, or it’s gone.'))
  const switches = await ctx.deps.custody?.ops.state().catch(() => null)
  const halted = !switches
    ? 'NEARKITS can’t confirm trading is allowed right now.'
    : switches.volumebot.paused || switches.trading.paused
      ? 'NEARKITS has paused the Volume Bot right now.'
      : null
  switch (action) {
    case 'p':
      if (await store.pause(b.id, 'owner', 'Paused by its owner')) await store.event(b.id, 'paused', 'Paused by its owner in Telegram', 'owner')
      break
    case 'r':
      if (halted) return void (await ctx.reply(`⏸ ${esc(halted)}`))
      if (await store.resume(b.id)) await store.event(b.id, 'resumed', 'Resumed by its owner in Telegram')
      break
    case 's':
      if (await store.stop(b.id, 'Stopped by its owner')) await store.event(b.id, 'stopping', 'Stopped by its owner in Telegram')
      break
    case 'go': {
      if (halted) return void (await ctx.reply(`⏸ ${esc(halted)}`))
      for (const id of b.config.walletIds) {
        const w = await ctx.deps.custody?.store.ownedWallet(ctx.user.id, id)
        if (!w || w.frozenAt !== null)
          return void (await ctx.reply('One of its wallets is no longer an active NEARKITS wallet of yours: change its wallets on NEARKITS web first.'))
      }
      const r = await store.start(b.id, freshRunState(ctx.deps.now()))
      if (!r.ok)
        return void (await ctx.reply(
          r.reason === 'busy-token'
            ? `Another of your bots is live on ${esc(b.config.tokenSymbol)}: stop it first (one bot per token).`
            : r.reason === 'too-many'
              ? `You have ${MAX_LIVE_BOTS_PER_USER} live Volume Bots, the most at once: stop one first.`
              : 'This bot is already running.',
        ))
      await store.event(b.id, 'started', 'Started in Telegram')
      break
    }
  }
  await showStatus(ctx)
}

async function command(ctx: BotCtx, args: string): Promise<void> {
  const sub = args.trim().toLowerCase().split(/\s+/)[0] ?? ''
  if (!storeOf(ctx)) return void (await ctx.reply('The Volume Bot isn’t available on this server.'))
  if (sub === '' || sub === 'status') return showStatus(ctx)
  const verbs: Record<string, { statuses: VolumeBot['status'][]; action: string }> = {
    start: { statuses: ['draft', 'stopped', 'completed'], action: 'go' },
    pause: { statuses: ['running'], action: 'p' },
    resume: { statuses: ['paused'], action: 'r' },
    stop: { statuses: ['running', 'paused'], action: 's' },
  }
  const v = verbs[sub]
  if (!v) return void (await ctx.reply('Use /volume, /volume start, /volume pause, /volume resume or /volume stop.'))
  const b = await pick(ctx, v.statuses, sub)
  if (b) await act(ctx, v.action, b.id)
}

export function volumeModule(): BotModule {
  return {
    commands: {
      volume: { ...documented('volume'), run: (ctx, args) => command(ctx, args) },
    },
    callbacks: {
      vb: async (ctx, action, arg) => {
        await ctx.answer()
        if (['p', 'r', 's', 'go'].includes(action) && arg) return act(ctx, action, arg)
        return showStatus(ctx)
      },
    },
  }
}
