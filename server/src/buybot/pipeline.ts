import type { NetworkConfig } from '@/config/networks'
import { formatUnits } from '@/lib/amounts'
import { explorerAccountUrl, explorerTxUrl } from '@/services/near/explorer'
import { detectTrades, fromFastnear, isComplete } from '@/services/near/flows'
import type { Logger } from '../log'
import { TelegramError, type TelegramApi } from '../telegram/api'
import type { InlineKeyboard } from '../telegram/types'
import type { TxIndex } from './follower'
import { CAPTION_LIMIT, emojiCount, renderBuy, type BuyView } from './format'
import type { BuyMarket } from './market'
import type { BuyEvent, BuybotConfig, BuybotStore } from './store'

/**
 * From a candidate transaction to a message in each chat:
 * 1. `processCandidates` reads each transaction in full from the index once its
 *    block is final and every receipt it created is in the record, then finds buys
 *    (and sells, for chats that want them) with the shared analyzer (flows.ts);
 *    each trade is recorded once.
 * 2. `deliver` posts pending deliveries, spacing messages per chat, honouring
 *    Telegram's retry_after, and pausing chats the bot was removed from.
 * A crash between "Telegram accepted it" and "marked sent" can repeat one post;
 * nothing else can.
 */

const MAX_CANDIDATE_ATTEMPTS = 15
const MAX_DELIVERY_ATTEMPTS = 5
/** A transaction is read only this many blocks after its block became final. */
export const FINAL_MARGIN = 5
/** A buy older than this is not posted: late alerts mislead more than they help. */
export const STALE_MS = 15 * 60_000
/** The same limit in blocks (about 0.56 s each on mainnet), for buys found while catching up. */
export const STALE_BLOCKS = 1600

/**
 * A trade is posted when it reaches the chat's minimum, in the chat's unit. A trade
 * whose value in that unit is unknown passes only a minimum of 0: never a guess.
 */
export function passesMinimum(cfg: Pick<BuybotConfig, 'unit' | 'minNear' | 'minUsd'>, valueNear: bigint | null, valueUsd: number | null): boolean {
  if (cfg.unit === 'USD') return cfg.minUsd <= 0 || (valueUsd !== null && valueUsd >= cfg.minUsd)
  return cfg.minNear === 0n || (valueNear !== null && valueNear >= cfg.minNear)
}

export function createProcessor(deps: { network: NetworkConfig; index: TxIndex; finalHeight: () => Promise<number>; store: BuybotStore; market: BuyMarket; log: Logger }) {
  return async function processCandidates(limit = 20): Promise<number> {
    const due = await deps.store.dueCandidates(deps.network.id, limit)
    if (!due.length) return 0
    const head = await deps.finalHeight()
    const ready = due.filter((c) => head - c.blockHeight >= FINAL_MARGIN)
    for (const c of due) if (!ready.includes(c)) await deps.store.retryCandidate(c.txHash, 2_000)
    const raw = ready.length ? await deps.index.transactions(ready.map((c) => c.txHash)) : new Map<string, unknown>()
    for (const c of ready) {
      const entry = raw.get(c.txHash) as { execution_outcome?: { outcome?: { receipt_ids?: string[] } } } | undefined
      const tx = entry ? fromFastnear({ ...entry, block_height: c.blockHeight }) : null
      if (!tx || !isComplete(tx, entry?.execution_outcome?.outcome?.receipt_ids ?? [])) {
        // Not indexed yet, or receipts still executing: look again shortly, then give up.
        const attempts = await deps.store.retryCandidate(c.txHash, Math.min(30_000, 2_000 * 2 ** c.attempts))
        if (attempts >= MAX_CANDIDATE_ATTEMPTS) {
          await deps.store.finishCandidate(c.txHash)
          deps.log.warn('buybot gave up on a transaction it could not read in full', { tx: c.txHash })
        }
        continue
      }
      // Found while catching up after downtime: recorded, but too old to post.
      const stale = head - c.blockHeight > STALE_BLOCKS
      for (const token of c.tokens) {
        const configs = await deps.store.activeConfigsFor(deps.network.id, token)
        if (!configs.length) continue
        for (const trade of detectTrades(tx, token, { wrapContract: deps.network.wrapContract })) {
          const wants = configs.filter((cfg) => trade.side === 'buy' || cfg.sells)
          if (!wants.length) continue
          // The other side of the trade: what a buyer paid, or what a seller received.
          const other = trade.side === 'buy' ? trade.paid : trade.received
          const [valueNear, valueUsd] = await Promise.all([deps.market.valueInNear(other), deps.market.usdOf(other)])
          const eligible = stale ? [] : wants.filter((cfg) => passesMinimum(cfg, valueNear, valueUsd))
          const recorded = await deps.store.recordBuy(
            {
              eventKey: `${tx.hash}:${token}:${trade.account}`,
              network: deps.network.id,
              token,
              side: trade.side,
              txHash: tx.hash,
              buyer: trade.account,
              amount: trade.amount,
              paid: other,
              blockHeight: c.blockHeight,
            },
            eligible.map((cfg) => cfg.id),
          )
          if (recorded) deps.log.info(`${trade.side} detected`, { token, tx: tx.hash, account: trade.account, chats: eligible.length })
        }
      }
      await deps.store.finishCandidate(c.txHash)
    }
    return ready.length
  }
}

export async function buyView(
  event: Pick<BuyEvent, 'side' | 'amount' | 'paid' | 'buyer' | 'txHash'>,
  cfg: BuybotConfig,
  market: BuyMarket,
  network: NetworkConfig,
): Promise<BuyView> {
  const [paidUsd, value, supply, metas] = await Promise.all([
    market.usdOf(event.paid),
    market.valueInNear(event.paid),
    market.totalSupply(cfg.token),
    Promise.all(event.paid.map((p) => market.meta(p.asset))),
  ])
  const tokens = Number(event.amount) / 10 ** cfg.decimals
  const priceUsd = paidUsd !== null && tokens > 0 ? paidUsd / tokens : null
  const fdvUsd = priceUsd !== null && supply !== null ? (Number(supply) / 10 ** cfg.decimals) * priceUsd : null
  return {
    side: event.side,
    symbol: cfg.symbol,
    name: cfg.name,
    decimals: cfg.decimals,
    amount: event.amount,
    paid: event.paid.map((p, i) => {
      const m = metas[i]
      return { text: m ? `${formatUnits(p.amount, m.decimals, { maxFraction: 4, group: true })} ${m.symbol}` : `${p.amount} (raw) ${p.asset}` }
    }),
    paidUsd,
    buyer: event.buyer,
    buyerUrl: explorerAccountUrl(network, event.buyer),
    txUrl: explorerTxUrl(network, event.txHash),
    priceUsd,
    fdvUsd,
    emoji: cfg.emoji,
    emojiCount:
      cfg.unit === 'USD' ? emojiCount(paidUsd, cfg.stepUsd, cfg.maxEmoji) : emojiCount(value === null ? null : Number(value) / 1e24, Number(cfg.stepNear) / 1e24, cfg.maxEmoji),
    networkLabel: network.label,
  }
}

export function tradeKeyboard(cfg: BuybotConfig, webUrl: string, webNetwork: string): InlineKeyboard | undefined {
  // A trade link only when the web app runs on the buybot's network.
  if (cfg.network !== webNetwork) return undefined
  return { inline_keyboard: [[{ text: `Trade ${cfg.symbol} on NearKit`, url: `${webUrl}/swap?to=${encodeURIComponent(cfg.token)}` }]] }
}

export function createDeliverer(deps: {
  tg: TelegramApi
  store: BuybotStore
  market: BuyMarket
  network: NetworkConfig
  webUrl: string
  webNetwork: string
  log: Logger
  now?: () => number
}) {
  const now = deps.now ?? Date.now
  return async function deliver(limit = 20): Promise<number> {
    const due = await deps.store.dueDeliveries(limit)
    for (const d of due) {
      const cfg = await deps.store.config(d.configId)
      const event = await deps.store.event(d.eventKey)
      if (!cfg || !event) {
        await deps.store.markDone(d.eventKey, d.configId, 'skipped', 'configuration or buy no longer exists')
        continue
      }
      if (!cfg.enabled || cfg.pausedReason) {
        await deps.store.markDone(d.eventKey, d.configId, 'skipped', 'alerts are off for this chat')
        continue
      }
      if (now() - event.detectedAt > STALE_MS) {
        await deps.store.markDone(d.eventKey, d.configId, 'skipped', 'too old to post')
        continue
      }
      const html = renderBuy(await buyView(event, cfg, deps.market, deps.network))
      try {
        const markup = tradeKeyboard(cfg, deps.webUrl, deps.webNetwork)
        const opts = { ...(markup ? { reply_markup: markup } : {}), disable_notification: cfg.silent }
        let msg
        if (cfg.media && html.length <= CAPTION_LIMIT) {
          try {
            msg = await deps.tg.sendMedia(cfg.chatId, cfg.media.kind, cfg.media.fileId, html, opts)
          } catch (e) {
            // A media file Telegram no longer knows must not silence the alerts: post text, drop the media.
            if (!(e instanceof TelegramError) || e.code !== 400 || !/file|photo|animation|video|media/i.test(e.description)) throw e
            await deps.store.updateConfig(cfg.id, { media: null })
            deps.log.warn('buybot media refused; alerts continue as text', { chat: cfg.chatId, reason: e.description })
            msg = await deps.tg.sendMessage(cfg.chatId, html, { ...opts, disable_link_preview: true })
          }
        } else {
          msg = await deps.tg.sendMessage(cfg.chatId, html, { ...opts, disable_link_preview: true })
        }
        await deps.store.markSent(d.eventKey, d.configId, msg.message_id)
      } catch (e) {
        if (!(e instanceof TelegramError)) {
          await deps.store.markRetry(d.eventKey, d.configId, 5_000 * 2 ** d.attempts, e instanceof Error ? e.message : 'send failed')
          continue
        }
        if (e.migrateTo !== null) {
          await deps.store.migrateChat(cfg.chatId, e.migrateTo)
          await deps.store.markRetry(d.eventKey, d.configId, 0, 'group moved to a supergroup')
        } else if (e.code === 429) {
          await deps.store.markRetry(d.eventKey, d.configId, (e.retryAfter ?? 5) * 1000, e.description)
        } else if (e.code === 403 || (e.code === 400 && /chat not found|not enough rights|have no rights|CHAT_WRITE_FORBIDDEN|kicked|not a member/i.test(e.description))) {
          await deps.store.pauseChat(cfg.chatId, e.description)
          await deps.store.markDone(d.eventKey, d.configId, 'failed', e.description)
          deps.log.warn('buybot paused a chat it can’t post to', { chat: cfg.chatId, reason: e.description })
        } else if (d.attempts + 1 >= MAX_DELIVERY_ATTEMPTS) {
          await deps.store.markDone(d.eventKey, d.configId, 'failed', e.description)
        } else {
          await deps.store.markRetry(d.eventKey, d.configId, 5_000 * 2 ** d.attempts, e.description)
        }
      }
    }
    return due.length
  }
}

/** Runs the follower and the pipeline until stopped; errors are logged and retried with backoff. */
export function startBuybot(deps: {
  follow: () => Promise<'idle' | 'caught-up'>
  process: () => Promise<number>
  deliver: () => Promise<number>
  log: Logger
  sleep?: (ms: number) => Promise<void>
}) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let running = true
  const loop = async (name: string, body: () => Promise<number>) => {
    let backoff = 1000
    while (running) {
      try {
        const wait = await body()
        backoff = 1000
        await sleep(wait)
      } catch (e) {
        deps.log.warn(`buybot ${name} failed; retrying`, { error: e, waitMs: backoff })
        await sleep(backoff)
        backoff = Math.min(backoff * 2, 60_000)
      }
    }
  }
  const follow = loop('follower', async () => {
    const r = await deps.follow()
    // A pass reads every followed token's latest history: alerts arrive within seconds.
    return r === 'caught-up' ? 2_500 : 5_000
  })
  const pipeline = loop('pipeline', async () => {
    const n = (await deps.process()) + (await deps.deliver())
    return n ? 100 : 1_000
  })
  return {
    async stop() {
      running = false
      await Promise.all([follow, pipeline])
    },
  }
}
