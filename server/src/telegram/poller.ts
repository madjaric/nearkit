import type { Store } from '../db/store'
import type { Logger } from '../log'
import { TelegramError, type TelegramApi } from './api'
import type { TgUpdate } from './types'

/**
 * Long polling (getUpdates). The offset is saved after each batch, so a restart
 * resumes where it stopped; an update seen twice (the last unfinished batch after
 * a restart) is handled once, by its ID (see Leases.firstDelivery). Updates from
 * one chat run in order; different chats run side by side, so one slow quote
 * doesn't hold everyone up.
 *
 * With several server instances, Telegram serves updates to one reader only: the
 * instance holding the poller lease reads; the others wait and take over if it
 * stops renewing (then they resume from the saved offset).
 */

export const ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member']
const OFFSET_KEY = 'telegram_offset'

export function startPolling(opts: {
  tg: TelegramApi
  store: Store
  handle: (update: TgUpdate) => Promise<void>
  log: Logger
  timeoutSec?: number
  sleep?: (ms: number) => Promise<void>
  /** Leadership among instances: `hold` takes or renews it (true while this instance leads). */
  lease?: { hold(): Promise<boolean>; release(): Promise<void> }
}) {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const controller = new AbortController()
  let stopped = false
  let offset = 0

  const chatOf = (u: TgUpdate) => u.message?.chat.id ?? u.callback_query?.message?.chat.id ?? u.my_chat_member?.chat.id ?? 0

  async function runBatch(updates: TgUpdate[]) {
    const byChat = new Map<number, TgUpdate[]>()
    for (const u of updates) byChat.set(chatOf(u), [...(byChat.get(chatOf(u)) ?? []), u])
    await Promise.all(
      [...byChat.values()].map(async (list) => {
        for (const u of list) {
          try {
            await opts.handle(u)
          } catch (e) {
            opts.log.error('update failed', { updateId: u.update_id, error: e })
          }
        }
      }),
    )
  }

  const done = (async () => {
    let leading = !opts.lease
    if (leading) offset = Number((await opts.store.getMeta(OFFSET_KEY).catch(() => null)) ?? '0')
    let backoff = 1000
    while (!stopped) {
      if (opts.lease) {
        const held = await opts.lease.hold().catch(() => false)
        if (!held) {
          if (leading) opts.log.warn('another instance now reads Telegram updates; this one waits')
          leading = false
          await sleep(5_000)
          continue
        }
        if (!leading) {
          // Just became the reader: continue from where the previous one stopped.
          offset = Number((await opts.store.getMeta(OFFSET_KEY).catch(() => null)) ?? '0')
          opts.log.info('reading Telegram updates (this instance holds the poller lease)', { offset })
          leading = true
        }
      }
      let updates: TgUpdate[]
      try {
        updates = await opts.tg.getUpdates(offset, opts.timeoutSec ?? 25, ALLOWED_UPDATES, controller.signal)
        backoff = 1000
      } catch (e) {
        if (stopped) break
        if (e instanceof TelegramError && e.code === 401) {
          opts.log.error('Telegram rejected the bot token; the bot stops. Check TELEGRAM_BOT_TOKEN.')
          break
        }
        if (e instanceof TelegramError && e.code === 409) {
          opts.log.warn('Another process is reading this bot’s updates (or a webhook is set); retrying in 10 s')
          await sleep(10_000)
          continue
        }
        const wait = e instanceof TelegramError && e.retryAfter ? e.retryAfter * 1000 : backoff
        opts.log.warn('getUpdates failed; retrying', { error: e, waitMs: wait })
        await sleep(wait)
        backoff = Math.min(backoff * 2, 30_000)
        continue
      }
      if (!updates.length) continue
      await runBatch(updates)
      offset = Math.max(...updates.map((u) => u.update_id)) + 1
      await opts.store.setMeta(OFFSET_KEY, String(offset))
    }
  })()

  return {
    done,
    async stop() {
      stopped = true
      controller.abort()
      await done
      await opts.lease?.release().catch(() => undefined)
    },
  }
}
