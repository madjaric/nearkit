import type { Store } from '../db/store'
import type { Logger } from '../log'
import { TelegramError, type TelegramApi } from './api'
import type { TgUpdate } from './types'

/**
 * Long polling (getUpdates), with the handlers off the reading loop. Each chat has
 * its own queue: its updates run in order, one at a time, while other chats run
 * side by side (at most MAX_CONCURRENT_UPDATES handlers at once). Reading goes on
 * while handlers run, so a slow one (a Confirm waiting for the chain, a long /pnl)
 * holds up only its own chat.
 *
 * Offsets: Telegram forgets an update once getUpdates is asked for a later one, so
 * reading on means telling it that updates still waiting here were received. The
 * offset saved for a restart is therefore the oldest update not finished yet (or,
 * with none, the next to read): a restart re-reads from there, and each update runs
 * at most once by its ID (Leases.firstDelivery, in the bot), so what had started is
 * skipped and what Telegram still holds and never started runs. Only updates already
 * read ahead and still waiting here when the process dies outright are lost to it;
 * stop() lets them run first (for STOP_WAIT_MS at most).
 *
 * With several server instances, Telegram serves updates to one reader only: the
 * instance holding the poller lease reads, and renews it in the background while it
 * does; the others wait and take over if it stops renewing (then they resume from
 * the saved offset).
 */

export const ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member']
const OFFSET_KEY = 'telegram_offset'

/** Handlers running at once, across all chats (each chat runs one at a time). */
export const MAX_CONCURRENT_UPDATES = 8
/** A chat with this many updates waiting is flooding: more are dropped (its user's rate limit would refuse them anyway). */
export const MAX_WAITING_PER_CHAT = 100
/** Updates read and not finished: at this many, reading pauses until some finish (Telegram keeps the rest meanwhile). */
export const MAX_UNFINISHED = 1_000
/** How often the poller lease is renewed while this instance reads (app.ts gives it 60 s). */
export const LEASE_RENEW_MS = 15_000
/** stop() waits this long for the handlers under way (and those still waiting) to finish. */
export const STOP_WAIT_MS = 8_000

export function startPolling(opts: {
  tg: TelegramApi
  store: Store
  handle: (update: TgUpdate) => Promise<void>
  log: Logger
  timeoutSec?: number
  sleep?: (ms: number) => Promise<void>
  /** Leadership among instances: `hold` takes or renews it (true while this instance leads). */
  lease?: { hold(): Promise<boolean>; release(): Promise<void> }
  /** Handlers running at once (MAX_CONCURRENT_UPDATES). */
  concurrency?: number
  /** Lease renewal interval while reading (LEASE_RENEW_MS). */
  renewMs?: number
  /** How long stop() waits for handlers (STOP_WAIT_MS). */
  stopWaitMs?: number
}) {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const limit = Math.max(1, opts.concurrency ?? MAX_CONCURRENT_UPDATES)
  let stopped = false
  /** The read in progress: aborted by stop(), or when the lease turns out lost. */
  let poll: AbortController | null = null
  /** The next update ID to ask Telegram for. */
  let offset = 0
  let saved: number | null = null
  let leading = !opts.lease

  const chatOf = (u: TgUpdate) => u.message?.chat.id ?? u.callback_query?.message?.chat.id ?? u.my_chat_member?.chat.id ?? 0

  // ─── dispatch: a queue per chat ─────────────────────────────────────────────

  const chats = new Map<number, { waiting: TgUpdate[]; running: boolean }>()
  /** Chats with updates waiting and none running, in the order they became ready. */
  const ready: number[] = []
  /** Update IDs read and not finished (waiting or running). */
  const unfinished = new Set<number>()
  let active = 0
  /** False once stop() gave up waiting: nothing more starts. */
  let starting = true
  const wakers: (() => void)[] = []
  const changed = () => new Promise<void>((r) => wakers.push(r))
  const wake = () => {
    for (const w of wakers.splice(0)) w()
  }

  function enqueue(u: TgUpdate) {
    if (unfinished.has(u.update_id)) return
    const key = chatOf(u)
    const chat = chats.get(key) ?? { waiting: [], running: false }
    chats.set(key, chat)
    if (chat.waiting.length >= MAX_WAITING_PER_CHAT) {
      opts.log.warn('a chat is flooding the bot; update dropped', { chat: key, updateId: u.update_id })
      return
    }
    unfinished.add(u.update_id)
    chat.waiting.push(u)
    if (!chat.running && chat.waiting.length === 1) ready.push(key)
    pump()
  }

  function pump() {
    while (starting && active < limit && ready.length) {
      const key = ready.shift() as number
      const chat = chats.get(key)
      const u = chat?.waiting.shift()
      if (!chat || !u) continue
      chat.running = true
      active += 1
      void run(u).then(() => {
        active -= 1
        chat.running = false
        unfinished.delete(u.update_id)
        // Back of the line: a chat with a backlog takes turns with the others.
        if (chat.waiting.length) ready.push(key)
        else chats.delete(key)
        pump()
        wake()
      })
    }
  }

  async function run(u: TgUpdate) {
    try {
      await opts.handle(u)
    } catch (e) {
      opts.log.error('update failed', { updateId: u.update_id, error: e })
    }
  }

  // ─── offset and lease ───────────────────────────────────────────────────────

  async function loadOffset(): Promise<number> {
    const n = Number((await opts.store.getMeta(OFFSET_KEY).catch(() => null)) ?? '0')
    saved = n
    return n
  }

  /** The oldest update not finished, else the next to read: never past one that hasn't run. */
  async function saveOffset() {
    const at = unfinished.size ? Math.min(...unfinished) : offset
    if (at === saved) return
    try {
      await opts.store.setMeta(OFFSET_KEY, String(at))
      saved = at
    } catch (e) {
      opts.log.warn('saving the Telegram offset failed; a restart re-reads more (each update still runs once)', { error: e })
    }
  }

  let renewal: ReturnType<typeof setInterval> | null = null
  function renewWhileLeading() {
    const lease = opts.lease
    if (!lease || renewal) return
    let renewing = false
    renewal = setInterval(() => {
      if (renewing || stopped || !leading) return
      renewing = true
      void lease
        .hold()
        .then((held) => {
          if (held || !leading) return
          opts.log.warn('another instance now reads Telegram updates; this one stops reading')
          leading = false
          stopRenewing()
          poll?.abort()
        })
        // Unknown (the database didn't answer): the reading loop asks again before its next read.
        .catch(() => undefined)
        .finally(() => {
          renewing = false
        })
    }, opts.renewMs ?? LEASE_RENEW_MS)
    renewal.unref()
  }
  function stopRenewing() {
    if (renewal) clearInterval(renewal)
    renewal = null
  }

  // ─── reading ────────────────────────────────────────────────────────────────

  const reading = (async () => {
    if (leading) offset = await loadOffset()
    let backoff = 1000
    while (!stopped) {
      if (opts.lease) {
        const held = await opts.lease.hold().catch(() => false)
        if (!held) {
          if (leading) opts.log.warn('another instance now reads Telegram updates; this one waits')
          leading = false
          stopRenewing()
          await sleep(5_000)
          continue
        }
        if (!leading) {
          // Just became the reader: continue from where the previous one stopped.
          offset = await loadOffset()
          opts.log.info('reading Telegram updates (this instance holds the poller lease)', { offset })
          leading = true
        }
        renewWhileLeading()
      }
      // Too much read and not finished: wait for room (Telegram keeps what isn't read yet).
      while (!stopped && unfinished.size >= MAX_UNFINISHED) await changed()
      if (stopped) break
      // Before the read that tells Telegram the updates so far were received.
      await saveOffset()
      if (stopped) break
      poll = new AbortController()
      let updates: TgUpdate[]
      try {
        updates = await opts.tg.getUpdates(offset, opts.timeoutSec ?? 25, ALLOWED_UPDATES, poll.signal)
        backoff = 1000
      } catch (e) {
        if (stopped) break
        // The lease passed on mid-read (the renewal aborted it): the check above waits.
        if (!leading) continue
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
      } finally {
        poll = null
      }
      for (const u of updates) {
        enqueue(u)
        offset = Math.max(offset, u.update_id + 1)
      }
    }
    stopRenewing()
  })()

  /** Reading has stopped; the handlers under way (and waiting) get STOP_WAIT_MS to finish. */
  async function settle() {
    let late = false
    const timer = setTimeout(() => {
      late = true
      wake()
    }, opts.stopWaitMs ?? STOP_WAIT_MS)
    timer.unref()
    while (unfinished.size && !late) await changed()
    clearTimeout(timer)
    if (unfinished.size) {
      starting = false
      opts.log.warn('stopped with Telegram updates not finished', { running: active, waiting: unfinished.size - active })
    }
    if (leading) await saveOffset()
  }

  const done = reading.then(settle)

  return {
    /** Resolves once reading stopped and the handlers finished (or stop() stopped waiting for them). */
    done,
    async stop() {
      stopped = true
      poll?.abort()
      wake()
      await done
      await opts.lease?.release().catch(() => undefined)
    },
  }
}
