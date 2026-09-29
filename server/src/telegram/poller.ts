import type { Store } from '../db/store'
import type { Logger } from '../log'
import { TelegramError, type TelegramApi } from './api'
import type { TgUpdate } from './types'

/**
 * Long polling (getUpdates). The offset is saved after each batch, so a restart
 * resumes where it stopped; at worst the last unfinished batch is seen twice,
 * which the handlers tolerate (commands are re-answered, not re-executed on
 * chain: nothing here signs). Updates from one chat run in order; different
 * chats run side by side, so one slow quote doesn't hold everyone up.
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
    offset = Number((await opts.store.getMeta(OFFSET_KEY).catch(() => null)) ?? '0')
    let backoff = 1000
    while (!stopped) {
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
    },
  }
}
