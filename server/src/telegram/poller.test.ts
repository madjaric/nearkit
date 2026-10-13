import { describe, expect, it } from 'vitest'
import { Leases } from '../db/leases'
import { migrate } from '../db/schema'
import { SqliteDatabase } from '../db/sqlite'
import { Store } from '../db/store'
import { silentLogger } from '../log'
import { createTelegramApi, TelegramError, type TelegramApi } from './api'
import { createFakeTelegram } from './fake'
import { startPolling } from './poller'
import type { TgUpdate } from './types'

async function setup() {
  const fake = createFakeTelegram()
  const tg = createTelegramApi({ token: fake.token, fetch: fake.fetch, sleep: async () => {} })
  const db = await SqliteDatabase.open(null)
  await migrate(db)
  return { fake, tg, store: new Store(db), db }
}

const message = (chatId: number, text: string) => ({
  message: { message_id: 1, date: 0, chat: { id: chatId, type: 'private' as const }, from: { id: chatId, is_bot: false, first_name: 'U' }, text },
})

const said = (u: TgUpdate) => `${u.message?.chat.id}:${u.message?.text}`

function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

/** Waits (in real time) until `check` holds; fails after `ms`. */
async function until(check: () => boolean | Promise<boolean>, ms = 2_000) {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 2))
  }
}

/**
 * getUpdates as Telegram long-polls it: with nothing new it waits for an update (or the abort),
 * instead of the fake's instant empty answer, so a reading loop never spins.
 */
function longPoll(tg: TelegramApi): TelegramApi {
  return {
    ...tg,
    async getUpdates(offset, timeoutSec, allowed, signal) {
      for (;;) {
        const updates = await tg.getUpdates(offset, timeoutSec, allowed, signal)
        if (updates.length || signal?.aborted) return updates
        await new Promise((r) => setTimeout(r, 2))
      }
    },
  }
}

describe('polling', () => {
  it('handles updates in order per chat and saves the offset for a restart', async () => {
    const { fake, tg, store } = await setup()
    fake.push(message(1, 'a'))
    fake.push(message(2, 'x'))
    fake.push(message(1, 'b'))
    const seen: string[] = []
    let poller: ReturnType<typeof startPolling> | null = null
    poller = startPolling({
      tg,
      store,
      log: silentLogger,
      sleep: async () => {},
      handle: async (u: TgUpdate) => {
        seen.push(`${u.message?.chat.id}:${u.message?.text}`)
        if (seen.length === 3) void poller?.stop()
      },
    })
    await poller.done
    expect(seen.filter((s) => s.startsWith('1:'))).toEqual(['1:a', '1:b'])
    expect(seen).toContain('2:x')
    expect(Number(await store.getMeta('telegram_offset'))).toBe(1003)
  })

  it('keeps going when one update’s handler throws', async () => {
    const { fake, tg, store } = await setup()
    fake.push(message(1, 'bad'))
    fake.push(message(1, 'good'))
    const seen: string[] = []
    const poller = startPolling({
      tg,
      store,
      log: silentLogger,
      sleep: async () => {},
      handle: async (u) => {
        if (u.message?.text === 'bad') throw new Error('boom')
        seen.push(u.message?.text ?? '')
        void poller.stop()
      },
    })
    await poller.done
    expect(seen).toEqual(['good'])
  })

  it('with several instances only the lease holder reads; the next one resumes from the saved offset', async () => {
    const { fake, tg, store, db } = await setup()
    let now = 1_000
    const leases = new Leases(db, () => now)
    // Instance "a" leads: it reads the first update, then stops (a crash: its lease is left to expire).
    fake.push(message(1, 'first'))
    const seenA: string[] = []
    const a = startPolling({
      tg,
      store,
      log: silentLogger,
      sleep: async () => {},
      handle: async (u) => {
        seenA.push(u.message?.text ?? '')
        void a.stop()
      },
      lease: { hold: () => leases.acquire('telegram-poller', 'a', 60_000), release: async () => {} },
    })
    await a.done
    expect(seenA).toEqual(['first'])
    // "b" waits while a's lease lasts, then takes over and reads from the saved offset.
    fake.push(message(1, 'second'))
    const seenB: string[] = []
    let waits = 0
    let stopping: Promise<void> | undefined
    const b = startPolling({
      tg,
      store,
      log: silentLogger,
      sleep: async () => {
        waits += 1
        now += 30_000
      },
      handle: async (u) => {
        seenB.push(u.message?.text ?? '')
        stopping = b.stop()
      },
      lease: { hold: () => leases.acquire('telegram-poller', 'b', 60_000), release: () => leases.release('telegram-poller', 'b') },
    })
    await b.done
    await stopping
    expect(waits).toBeGreaterThan(0)
    expect(seenB).toEqual(['second'])
    expect(await leases.holder('telegram-poller')).toBeNull()
  })

  it('stops for good when Telegram rejects the token', async () => {
    const { fake, tg, store } = await setup()
    fake.failNext('getUpdates', { code: 401, description: 'Unauthorized' })
    const poller = startPolling({ tg, store, log: silentLogger, sleep: async () => {}, handle: async () => {} })
    await expect(poller.done).resolves.toBeUndefined()
  })
})

describe('polling while handlers run', () => {
  it('a slow handler in one chat does not hold up another chat', async () => {
    const { fake, tg, store } = await setup()
    const gate = deferred()
    const seen: string[] = []
    fake.push(message(1, 'slow'))
    const poller = startPolling({
      tg: longPoll(tg),
      store,
      log: silentLogger,
      sleep: async () => {},
      handle: async (u) => {
        seen.push(said(u))
        if (u.message?.text === 'slow') await gate.promise
      },
    })
    try {
      await until(() => seen.includes('1:slow'))
      // Sent while chat 1's handler is still running (a Confirm waiting for the chain, a long /pnl).
      fake.push(message(2, 'quick'))
      await until(() => seen.includes('2:quick'))
      expect(seen).toEqual(['1:slow', '2:quick'])
    } finally {
      gate.resolve()
      await poller.stop()
    }
  })

  it('updates in one chat still run in order, one at a time', async () => {
    const { fake, tg, store } = await setup()
    const gate = deferred()
    const events: string[] = []
    fake.push(message(1, 'a'))
    const poller = startPolling({
      tg: longPoll(tg),
      store,
      log: silentLogger,
      sleep: async () => {},
      handle: async (u) => {
        events.push(`start ${said(u)}`)
        if (u.message?.text === 'a') await gate.promise
        events.push(`end ${said(u)}`)
      },
    })
    try {
      await until(() => events.includes('start 1:a'))
      fake.push(message(1, 'b'))
      fake.push(message(2, 'c'))
      // The other chat runs meanwhile; chat 1's next update waits for its first.
      await until(() => events.includes('end 2:c'))
      expect(events).not.toContain('start 1:b')
      gate.resolve()
      await until(() => events.includes('end 1:b'))
      expect(events.filter((e) => e.includes(' 1:'))).toEqual(['start 1:a', 'end 1:a', 'start 1:b', 'end 1:b'])
    } finally {
      gate.resolve()
      await poller.stop()
    }
  })

  it('runs at most `concurrency` handlers at once, the rest as slots free up', async () => {
    const { fake, tg, store } = await setup()
    const gates = new Map<number, ReturnType<typeof deferred>>()
    for (let chat = 1; chat <= 6; chat++) {
      gates.set(chat, deferred())
      fake.push(message(chat, 'x'))
    }
    let running = 0
    let most = 0
    const finished: number[] = []
    const poller = startPolling({
      tg: longPoll(tg),
      store,
      log: silentLogger,
      sleep: async () => {},
      concurrency: 3,
      handle: async (u) => {
        running += 1
        most = Math.max(most, running)
        await gates.get(u.message?.chat.id ?? 0)?.promise
        running -= 1
        finished.push(u.message?.chat.id ?? 0)
      },
    })
    try {
      await until(() => running === 3)
      await new Promise((r) => setTimeout(r, 30))
      expect(running).toBe(3)
      expect(finished).toEqual([])
      gates.get(2)?.resolve()
      await until(() => finished.length === 1)
      // A slot freed: the next chat in line started, still three at once.
      await until(() => running === 3)
      for (const g of gates.values()) g.resolve()
      await until(() => finished.length === 6)
      expect(most).toBe(3)
    } finally {
      for (const g of gates.values()) g.resolve()
      await poller.stop()
    }
  })

  it('saves the offset of the oldest unfinished update while later ones are read; once all are done, past the last', async () => {
    const { fake, tg, store } = await setup()
    const gate = deferred()
    const seen: string[] = []
    fake.push(message(1, 'slow')) // 1000
    const poller = startPolling({
      tg: longPoll(tg),
      store,
      log: silentLogger,
      sleep: async () => {},
      handle: async (u) => {
        seen.push(said(u))
        if (u.message?.text === 'slow') await gate.promise
      },
    })
    try {
      await until(() => seen.includes('1:slow'))
      fake.push(message(2, 'quick')) // 1001
      await until(() => seen.includes('2:quick'))
      // Telegram was asked for what follows both (which confirms them on its side), but the saved
      // offset stays at the update still running: a restart now would re-read it (and skip it by its ID).
      await until(() => fake.calls.some((c) => c.method === 'getUpdates' && c.params.offset === 1002))
      expect(await store.getMeta('telegram_offset')).toBe('1000')
      gate.resolve()
      await poller.stop()
      expect(await store.getMeta('telegram_offset')).toBe('1002')
    } finally {
      gate.resolve()
      await poller.stop()
    }
  })

  it('after a crash, a restart handles what was read but never started, and runs nothing twice', async () => {
    const { fake, tg, store, db } = await setup()
    const leases = new Leases(db)
    const handled: string[] = []
    const gate = deferred()
    // Like createBotApp: an update ID runs once (Leases.firstDelivery), whichever instance reads it.
    const app = (name: string) => async (u: TgUpdate) => {
      if (!(await leases.firstDelivery(u.update_id))) return
      handled.push(`${name} ${said(u)}`)
      if (u.message?.text === 'slow') await gate.promise
    }
    // Reads one batch, then freezes before its next read: Telegram never hears that the batch was read.
    let reads = 0
    const freezing: TelegramApi = {
      ...tg,
      getUpdates: (offset, timeoutSec, allowed, signal) =>
        ++reads === 1
          ? tg.getUpdates(offset, timeoutSec, allowed, signal)
          : new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new TelegramError('getUpdates', 0, 'timed out')), { once: true })),
    }
    fake.push(message(1, 'slow')) // 1000: starts, never finishes
    fake.push(message(2, 'waiting')) // 1001: read, waits for a free slot, never starts
    const a = startPolling({ tg: freezing, store, log: silentLogger, sleep: async () => {}, handle: app('a'), concurrency: 1, stopWaitMs: 20 })
    try {
      await until(() => handled.includes('a 1:slow'))
      await until(async () => (await store.getMeta('telegram_offset')) === '1000')
      expect(handled).toEqual(['a 1:slow'])
      await a.stop()
      // The restart reads from the saved offset: the update that ran is skipped, the one that never started runs.
      const b = startPolling({ tg: longPoll(tg), store, log: silentLogger, sleep: async () => {}, handle: app('b') })
      await until(() => handled.includes('b 2:waiting'))
      await b.stop()
      expect(handled).toEqual(['a 1:slow', 'b 2:waiting'])
    } finally {
      gate.resolve()
      await a.stop()
    }
  })

  it('renews the poller lease while a long handler runs', async () => {
    const { fake, tg, store } = await setup()
    const gate = deferred()
    let started = false
    let holds = 0
    fake.push(message(1, 'slow'))
    const poller = startPolling({
      tg: longPoll(tg),
      store,
      log: silentLogger,
      sleep: async () => {},
      renewMs: 5,
      handle: async () => {
        started = true
        await gate.promise
      },
      lease: {
        hold: async () => {
          holds += 1
          return true
        },
        release: async () => {},
      },
    })
    try {
      await until(() => started)
      const before = holds
      // Nothing new arrives, so the reading loop sits in getUpdates: these renewals run beside it.
      await until(() => holds >= before + 3)
    } finally {
      gate.resolve()
      await poller.stop()
    }
  })

  it('stop() waits for handlers under way, but not forever', async () => {
    const { fake, tg, store } = await setup()
    fake.push(message(1, 'soon'))
    let started = false
    let finished = false
    const p = startPolling({
      tg: longPoll(tg),
      store,
      log: silentLogger,
      sleep: async () => {},
      handle: async () => {
        started = true
        await new Promise((r) => setTimeout(r, 30))
        finished = true
      },
    })
    await until(() => started)
    await p.stop()
    expect(finished).toBe(true)

    fake.push(message(1, 'never'))
    const stuck = deferred()
    let begun = false
    const q = startPolling({
      tg: longPoll(tg),
      store,
      log: silentLogger,
      sleep: async () => {},
      stopWaitMs: 50,
      handle: async () => {
        begun = true
        await stuck.promise
      },
    })
    try {
      await until(() => begun)
      const t = Date.now()
      await q.stop()
      expect(Date.now() - t).toBeLessThan(1_000)
    } finally {
      stuck.resolve()
    }
  })
})
