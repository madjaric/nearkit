import { NATIVE_TOKEN_ID, NEAR_DECIMALS, type NetworkConfig } from '@/config/networks'
import { formatUnits } from '@/lib/amounts'
import type { BotDetail, BotSummary } from '@/lib/volumeBot/api'
import { MAX_LIVE_BOTS_PER_USER, parseBotConfig } from '@/lib/volumeBot/config'
import { pnlNear } from '@/lib/volumeBot/inventory'
import { summarize, type TradeRecord } from '@/lib/volumeBot/metrics'
import type { BotConfig } from '@/lib/volumeBot/types'
import { accountIdError } from '@/lib/validation'
import { field } from '../api/linkRoutes'
import { HttpError, type Route } from '../api/http'
import { walletName } from '../custody/limits'
import type { CustodyDeps } from '../custody/wallets'
import type { Logger } from '../log'
import type { ServerNear } from '../near'
import { bold, esc } from '../telegram/html'
import type { WebSessions } from '../web/sessions'
import { freshRunState } from './runner'
import type { BotTrade, RunState, VolumeBot, VolumeBotStore } from './store'

/**
 * NEARKITS web's Volume Bot console: the signed-in user's bots, their configuration, and Start,
 * Pause, Resume, Stop and Emergency stop. A bot trades only from the user's own active NEARKITS
 * wallets (checked here and again by the worker at every step); its trades run through the same
 * custody path as any trade. Starting one tells the owner in Telegram, like a new wallet does.
 */

export interface BotApiDeps {
  sessions: WebSessions
  custody: CustodyDeps
  bots: VolumeBotStore
  near: ServerNear
  network: NetworkConfig
  now: () => number
  notify: (userId: number, html: string) => Promise<unknown>
  log: Logger
}

const human = (raw: string | null, decimals: number) => (raw ? Number(formatUnits(BigInt(raw), decimals)) : 0)

function tradeRecord(t: BotTrade, decimals: number): TradeRecord | null {
  if (t.status === 'submitted') return null
  return {
    at: t.createdAt,
    side: t.side,
    walletId: t.walletId,
    status: t.status,
    near: human(t.nearRaw, NEAR_DECIMALS),
    tokens: human(t.tokenRaw, decimals),
    feeNear: t.feeNear ?? 0,
    gasNear: t.gasNear ?? 0,
    nearUsd: t.nearUsd,
  }
}

/** A bot as its list shows it: what it trades, how, its status and why, and its run's headline figures. */
async function summaryOf(bots: VolumeBotStore, b: VolumeBot, now: number): Promise<BotSummary> {
  const run = await bots.currentRun(b.id)
  const trades = run ? await bots.tradesOfRun(run.id) : []
  const records = trades.flatMap((t) => tradeRecord(t, b.config.tokenDecimals) ?? [])
  const metrics = summarize(records, now)
  const st = run?.state ?? null
  const price = st?.prevMarket?.midNear ?? null
  const pnl = st && price !== null ? Object.values(st.books).reduce((s, book) => s + pnlNear(book, price), 0) : null
  return {
    id: b.id,
    token: b.token,
    symbol: b.config.tokenSymbol,
    strategy: b.strategy,
    status: b.status,
    pauseCode: b.pauseCode,
    pauseReason: b.pauseReason,
    waiting: st?.waiting ?? null,
    startedAt: b.startedAt,
    stoppedAt: b.stoppedAt,
    walletIds: b.config.walletIds,
    runtimeSec: b.startedAt !== null ? Math.max(0, ((b.status === 'stopped' || b.status === 'completed' ? (b.stoppedAt ?? now) : now) - b.startedAt) / 1000) : 0,
    trades: metrics.confirmed,
    failed: metrics.failed,
    volumeNear: metrics.volumeNear,
    pnlNear: pnl,
    roiPct: pnl !== null && st?.equity.startNear ? (pnl / st.equity.startNear) * 100 : null,
    nextTickAt: b.status === 'running' ? b.nextTickAt : null,
    priceNear: price,
    inFlight: trades.filter((t) => t.status === 'submitted').length,
    lastTradeAt: st?.progress.lastTradeAt ?? null,
    updatedAt: b.updatedAt,
  }
}

export function botRoutes(deps: BotApiDeps): Record<string, Route> {
  const { custody, bots } = deps
  const userOf = async (body: unknown): Promise<number> => {
    const userId = await deps.sessions.userOf(field(body, 'session', 64))
    if (userId === null) throw new HttpError(401, 'session', 'Your NEARKITS web session has ended. Sign in again: send /web to the NEARKITS bot.')
    return userId
  }
  const botOf = async (userId: number, body: unknown): Promise<VolumeBot> => {
    const b = await bots.owned(userId, field(body, 'botId', 32))
    if (!b) throw new HttpError(404, 'not-found', 'That Volume Bot isn’t one of yours, or it’s gone.')
    return b
  }
  /** Every wallet the bot names is one of the user's own active NEARKITS wallets, not frozen; its token is read from chain. */
  const checked = async (userId: number, config: BotConfig): Promise<BotConfig> => {
    for (const id of config.walletIds) {
      const w = await custody.store.ownedWallet(userId, id)
      if (!w) throw new HttpError(403, 'not-executable', 'A Volume Bot trades only from your own NEARKITS wallets. Watch-only and connected accounts can’t be used.')
      if (w.frozenAt !== null) throw new HttpError(409, 'frozen', `${walletName(w)} is frozen by NEARKITS for your protection: it can’t trade.`)
    }
    if (config.tokenId === NATIVE_TOKEN_ID || accountIdError(config.tokenId)) throw new HttpError(400, 'token', 'Choose a token by its contract.')
    const meta = await deps.near.ctx.reader.metadata(config.tokenId).catch(() => null)
    if (!meta) throw new HttpError(400, 'token', 'NEARKITS can’t read that token from chain. Check the contract, or try again in a moment.')
    return { ...config, tokenSymbol: meta.symbol, tokenDecimals: meta.decimals }
  }
  const notPaused = async () => {
    const s = await custody.ops.state().catch(() => null)
    if (!s) throw new HttpError(503, 'paused', 'NEARKITS can’t confirm trading is allowed right now. Try again in a moment.')
    if (s.volumebot.paused) throw new HttpError(409, 'paused', 'NEARKITS has paused every Volume Bot right now. Manual trading still works.')
    if (s.trading.paused) throw new HttpError(409, 'paused', 'Trading from NEARKITS wallets is paused by NEARKITS right now.')
  }

  return {
    '/api/web/bots': async (body) => {
      const userId = await userOf(body)
      const list = await bots.ofUser(userId, deps.network.id)
      return { bots: await Promise.all(list.map((b) => summaryOf(bots, b, deps.now()))) }
    },

    /** Creates a bot (no botId) or changes an idle one's configuration. Nothing trades until Start. */
    '/api/web/bots/save': async (body) => {
      const userId = await userOf(body)
      const parsed = parseBotConfig((body as Record<string, unknown>).config)
      if (!parsed.ok) throw new HttpError(400, 'config', parsed.issues.map((i) => `${i.field}: ${i.message}`).join('; '), { issues: parsed.issues })
      const config = await checked(userId, parsed.config)
      const id = (body as Record<string, unknown>).botId
      if (id === undefined || id === null || id === '') {
        const b = await bots.create({ userId, network: deps.network.id, config })
        await bots.event(b.id, 'config', 'Configured on NEARKITS web')
        return { bot: await summaryOf(bots, b, deps.now()) }
      }
      const b = await botOf(userId, body)
      const updated = await bots.update(b.id, userId, config)
      if (!updated) throw new HttpError(409, 'live', 'Stop the bot before changing its configuration.')
      await bots.event(b.id, 'config', 'Configuration changed on NEARKITS web')
      return { bot: await summaryOf(bots, updated, deps.now()) }
    },

    '/api/web/bots/detail': async (body) => {
      const userId = await userOf(body)
      const b = await botOf(userId, body)
      const run = await bots.currentRun(b.id)
      const trades = await bots.trades(b.id, 100)
      const runTrades = run ? await bots.tradesOfRun(run.id) : []
      const records = runTrades.flatMap((t) => tradeRecord(t, b.config.tokenDecimals) ?? [])
      const st: RunState | null = run?.state ?? null
      const price = st?.prevMarket?.midNear ?? null
      const wallets = await Promise.all(
        b.config.walletIds.map(async (id) => {
          const w = await custody.store.ownedWallet(userId, id)
          const last = st?.expected.find((e) => e.walletId === id) ?? null
          const book = st?.books[id] ?? null
          const own = records.filter((r) => r.walletId === id && r.status === 'confirmed')
          return {
            walletId: id,
            name: w ? walletName(w) : 'Closed wallet',
            accountId: w?.accountId ?? null,
            frozen: w?.frozenAt != null,
            near: last?.near ?? null,
            tokens: last?.tokens ?? null,
            exposurePct: last && price !== null && last.near + last.tokens * price > 0 ? ((last.tokens * price) / (last.near + last.tokens * price)) * 100 : null,
            pnlNear: book && price !== null ? pnlNear(book, price) : null,
            trades: own.length,
            volumeNear: own.reduce((s, r) => s + r.near, 0),
          }
        }),
      )
      const detail: BotDetail = {
        bot: await summaryOf(bots, b, deps.now()),
        config: b.config,
        metrics: summarize(records, deps.now()),
        market: st?.prevMarket ?? null,
        fair: st?.fair ?? null,
        progress: st?.progress ?? null,
        health: st?.health ?? null,
        wallets,
        trades: trades.map((t) => ({
          id: t.id,
          at: t.createdAt,
          walletId: t.walletId,
          side: t.side,
          status: t.status,
          near: human(t.nearRaw, NEAR_DECIMALS),
          tokens: human(t.tokenRaw, b.config.tokenDecimals),
          priceNear: t.priceNear,
          impactBps: t.impactBps,
          feeNear: t.feeNear,
          gasNear: t.gasNear,
          txHash: t.txHash,
          message: t.message,
        })),
        events: (await bots.events(b.id, 50)).map(({ id, kind, code, message, at }) => ({ id, kind, code, message, at })),
        series: await bots.metrics(b.id, deps.now() - 7 * 86_400_000),
      }
      return detail
    },

    '/api/web/bots/start': async (body) => {
      const userId = await userOf(body)
      const b = await botOf(userId, body)
      await notPaused()
      await checked(userId, b.config)
      const r = await bots.start(b.id, freshRunState(deps.now()))
      if (!r.ok)
        throw new HttpError(
          409,
          r.reason,
          r.reason === 'busy-token'
            ? `Another of your Volume Bots is live on ${b.config.tokenSymbol}: one bot per token, so two never trade it against each other. Stop that one first.`
            : r.reason === 'too-many'
              ? `You have ${MAX_LIVE_BOTS_PER_USER} live Volume Bots, the most at once. Stop one before starting another.`
              : 'This bot is already running.',
        )
      await bots.event(b.id, 'started', 'Started on NEARKITS web')
      // A security notice, like a new wallet's: a stolen web session can't start trading unseen.
      await deps
        .notify(
          userId,
          [
            `🤖 ${bold('Volume Bot started on NEARKITS web')}`,
            `${esc(b.config.tokenSymbol)} · ${esc(b.strategy)} · ${b.config.walletIds.length} wallet${b.config.walletIds.length === 1 ? '' : 's'}`,
            'If this wasn’t you: /volume stop, then sign out of NEARKITS web everywhere.',
          ].join('\n'),
        )
        .catch(() => undefined)
      return { bot: await summaryOf(bots, (await bots.get(b.id)) as VolumeBot, deps.now()) }
    },

    '/api/web/bots/pause': async (body) => {
      const userId = await userOf(body)
      const b = await botOf(userId, body)
      if (!(await bots.pause(b.id, 'owner', 'Paused by its owner'))) throw new HttpError(409, 'not-running', 'Only a running bot can be paused.')
      await bots.event(b.id, 'paused', 'Paused by its owner', 'owner')
      return { bot: await summaryOf(bots, (await bots.get(b.id)) as VolumeBot, deps.now()) }
    },

    '/api/web/bots/resume': async (body) => {
      const userId = await userOf(body)
      const b = await botOf(userId, body)
      await notPaused()
      await checked(userId, b.config)
      if (!(await bots.resume(b.id))) throw new HttpError(409, 'not-paused', 'Only a paused bot can be resumed.')
      await bots.event(b.id, 'resumed', 'Resumed by its owner')
      return { bot: await summaryOf(bots, (await bots.get(b.id)) as VolumeBot, deps.now()) }
    },

    /** Stop (or emergency stop): nothing new is sent at once; trades already sent are settled, then it ends stopped. */
    '/api/web/bots/stop': async (body) => {
      const userId = await userOf(body)
      const b = await botOf(userId, body)
      const emergency = (body as Record<string, unknown>).emergency === true
      const reason = emergency ? 'Emergency stop by its owner' : 'Stopped by its owner'
      if (!(await bots.stop(b.id, reason))) throw new HttpError(409, 'not-live', 'This bot isn’t running or paused.')
      await bots.event(b.id, emergency ? 'emergency-stop' : 'stopping', reason)
      return { bot: await summaryOf(bots, (await bots.get(b.id)) as VolumeBot, deps.now()) }
    },

    '/api/web/bots/delete': async (body) => {
      const userId = await userOf(body)
      const b = await botOf(userId, body)
      if (!(await bots.remove(b.id, userId))) throw new HttpError(409, 'live', 'Stop the bot before deleting it.')
      return { deleted: true }
    },
  }
}
