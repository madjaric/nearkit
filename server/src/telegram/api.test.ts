import { describe, expect, it } from 'vitest'
import { createTelegramApi, TelegramError } from './api'
import { createFakeTelegram } from './fake'

function setup() {
  const fake = createFakeTelegram()
  const slept: number[] = []
  let clock = 0
  const api = createTelegramApi({
    token: fake.token,
    fetch: fake.fetch,
    sleep: async (ms) => {
      slept.push(ms)
      clock += ms
    },
    now: () => clock,
  })
  return { fake, api, slept }
}

describe('Telegram API client', () => {
  it('calls methods with JSON and returns their result', async () => {
    const { api, fake } = setup()
    expect((await api.getMe()).username).toBe('NearKitBot')
    const msg = await api.sendMessage(42, '<b>hi</b>', { reply_markup: { inline_keyboard: [[{ text: 'Go', callback_data: 'go' }]] } })
    expect(msg.message_id).toBeGreaterThan(0)
    expect(fake.calls.at(-1)).toMatchObject({ method: 'sendMessage', params: { chat_id: 42, text: '<b>hi</b>', parse_mode: 'HTML' } })
  })

  it('waits out a 429 with its retry_after and tries again', async () => {
    const { api, fake, slept } = setup()
    fake.failNext('sendMessage', { code: 429, description: 'Too Many Requests: retry after 3', retryAfter: 3 })
    await api.sendMessage(7, 'x')
    expect(slept.some((ms) => ms >= 3000)).toBe(true)
    expect(fake.calls.filter((c) => c.method === 'sendMessage')).toHaveLength(2)
  })

  it('gives up on a long 429 and reports when to come back', async () => {
    const { api, fake } = setup()
    fake.failNext('sendMessage', { code: 429, description: 'Too Many Requests', retryAfter: 600 })
    const error = await api.sendMessage(7, 'x').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TelegramError)
    expect((error as TelegramError).retryAfter).toBe(600)
  })

  it('reports a blocked bot as such, with no token in the message', async () => {
    const { api, fake } = setup()
    fake.failNext('sendMessage', { code: 403, description: 'Forbidden: bot was blocked by the user' })
    const error = (await api.sendMessage(7, 'x').catch((e: unknown) => e)) as TelegramError
    expect(error.blocked).toBe(true)
    expect(error.message).not.toContain(fake.token)
    expect(error.message).toContain('sendMessage')
  })

  it('treats "message is not modified" as harmless for edits', async () => {
    const { api, fake } = setup()
    fake.failNext('editMessageText', { code: 400, description: 'Bad Request: message is not modified' })
    await expect(api.editMessageText(7, 1, 'same')).resolves.toBeNull()
  })

  it('spaces messages to one group chat (Telegram allows about 20 a minute)', async () => {
    const { api, slept } = setup()
    await api.sendMessage(-100123, 'a')
    await api.sendMessage(-100123, 'b')
    expect(slept.reduce((s, ms) => s + ms, 0)).toBeGreaterThanOrEqual(3000)
  })

  describe('spacing, with sends running side by side', () => {
    /** A clock the test moves: sleeps end only when it passes their time. Each call to Telegram is stamped with it. */
    function timed() {
      const fake = createFakeTelegram()
      let clock = 0
      const timers: { at: number; wake: () => void }[] = []
      const sentAt: { chatId: number; text: string; at: number }[] = []
      const api = createTelegramApi({
        token: fake.token,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const res = await fake.fetch(input, init)
          const last = fake.calls.at(-1)
          if (last?.method === 'sendMessage' && !last.failed) sentAt.push({ chatId: Number(last.params.chat_id), text: String(last.params.text), at: clock })
          return res
        }) as typeof fetch,
        sleep: (ms) => new Promise<void>((wake) => timers.push({ at: clock + ms, wake })),
        now: () => clock,
      })
      const settle = async () => {
        for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))
      }
      /** Moves the clock to `t`, waking every sleep due by then (in time order). */
      const advanceTo = async (t: number) => {
        await settle()
        for (;;) {
          const next = timers.filter((x) => x.at <= t).sort((a, b) => a.at - b.at)[0]
          if (!next) break
          timers.splice(timers.indexOf(next), 1)
          clock = Math.max(clock, next.at)
          next.wake()
          await settle()
        }
        clock = t
        await settle()
      }
      return { fake, api, sentAt, advanceTo, settle }
    }

    const GROUP = -100123
    const PRIVATE = 42

    it('a group’s spacing does not delay a send to a private chat', async () => {
      const { api, sentAt, advanceTo, settle } = timed()
      const sends = [api.sendMessage(GROUP, 'g1'), api.sendMessage(GROUP, 'g2')]
      await settle()
      // g2 waits its 3.1 s turn in the group; the private chat goes now, after the global ~35 ms at most.
      sends.push(api.sendMessage(PRIVATE, 'p1'))
      await advanceTo(100)
      expect(sentAt.map((s) => s.text)).toEqual(['g1', 'p1'])
      await advanceTo(5_000)
      await Promise.all(sends)
      expect(sentAt.map((s) => s.text)).toEqual(['g1', 'p1', 'g2'])
      // Same-chat spacing still holds.
      expect(sentAt[2]?.at).toBeGreaterThanOrEqual(3_100)
    })

    it('a 429 pause on one chat delays only that chat’s sends', async () => {
      const { api, fake, sentAt, advanceTo, settle } = timed()
      fake.failNext('sendMessage', { code: 429, description: 'Too Many Requests: retry after 5', retryAfter: 5 })
      const first = api.sendMessage(PRIVATE + 1, 'x1')
      await settle()
      // x1 was refused: its chat is paused for 5 s, and x1 is retried after it.
      const second = api.sendMessage(PRIVATE + 1, 'x2')
      const other = api.sendMessage(PRIVATE, 'y1')
      await advanceTo(100)
      expect(sentAt.map((s) => s.text)).toEqual(['y1'])
      await advanceTo(6_000)
      await Promise.all([first, second, other])
      expect(sentAt.map((s) => s.text)).toEqual(['y1', 'x1', 'x2'])
      // Both of the paused chat's sends waited out retry_after, and kept their own spacing.
      expect(sentAt.find((s) => s.text === 'x2')?.at).toBeGreaterThanOrEqual(5_000)
      expect(sentAt.find((s) => s.text === 'x1')?.at).toBeGreaterThanOrEqual(5_000)
    })

    it('two sends to one private chat keep their spacing, and all sends keep the global one', async () => {
      const { api, sentAt, advanceTo } = timed()
      const sends = [api.sendMessage(PRIVATE, 'a'), api.sendMessage(PRIVATE, 'b'), api.sendMessage(7, 'c'), api.sendMessage(8, 'd')]
      await advanceTo(1_000)
      await Promise.all(sends)
      const at = Object.fromEntries(sentAt.map((s) => [s.text, s.at]))
      expect(at.b).toBeGreaterThanOrEqual(250)
      const times = sentAt.map((s) => s.at).sort((x, y) => x - y)
      for (let i = 1; i < times.length; i++) expect((times[i] as number) - (times[i - 1] as number)).toBeGreaterThanOrEqual(35)
    })
  })

  it('never puts the token in errors from the network layer', async () => {
    const token = '2222222222:NETWORK-token-for-tests-0000000000000'
    const api = createTelegramApi({
      token,
      fetch: (async () => {
        throw new TypeError(`fetch failed for https://api.telegram.org/bot${token}/getMe`)
      }) as typeof fetch,
      sleep: async () => {},
    })
    const error = (await api.getMe().catch((e: unknown) => e)) as Error
    expect(error.message).not.toContain(token)
  })
})
