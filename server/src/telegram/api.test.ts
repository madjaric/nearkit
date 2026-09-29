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
