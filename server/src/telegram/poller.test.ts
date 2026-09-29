import { describe, expect, it } from 'vitest'
import { migrate } from '../db/schema'
import { SqliteDatabase } from '../db/sqlite'
import { Store } from '../db/store'
import { silentLogger } from '../log'
import { createTelegramApi } from './api'
import { createFakeTelegram } from './fake'
import { startPolling } from './poller'
import type { TgUpdate } from './types'

async function setup() {
  const fake = createFakeTelegram()
  const tg = createTelegramApi({ token: fake.token, fetch: fake.fetch, sleep: async () => {} })
  const db = await SqliteDatabase.open(null)
  await migrate(db)
  return { fake, tg, store: new Store(db) }
}

const message = (chatId: number, text: string) => ({
  message: { message_id: 1, date: 0, chat: { id: chatId, type: 'private' as const }, from: { id: chatId, is_bot: false, first_name: 'U' }, text },
})

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

  it('stops for good when Telegram rejects the token', async () => {
    const { fake, tg, store } = await setup()
    fake.failNext('getUpdates', { code: 401, description: 'Unauthorized' })
    const poller = startPolling({ tg, store, log: silentLogger, sleep: async () => {}, handle: async () => {} })
    await expect(poller.done).resolves.toBeUndefined()
  })
})
