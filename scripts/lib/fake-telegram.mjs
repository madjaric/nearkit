// Fake Telegram Bot API over HTTP, for end-to-end runs of the real bot server
// (TELEGRAM_API_URL points here). It answers the methods NearKit uses, queues
// updates the test "sends", and records every message the bot sends back.
import { createServer } from 'node:http'

export async function startFakeTelegram({ token, username = 'NearKitTestBot' }) {
  const queue = []
  const sent = []
  const waiters = new Set()
  let updateId = 1
  let messageId = 1

  const wake = () => {
    for (const w of waiters) w()
    waiters.clear()
  }

  const server = createServer((req, res) => {
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '')
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (!match) return reply(404, { ok: false, error_code: 404, description: 'Not Found' })
    if (match[1] !== token) return reply(401, { ok: false, error_code: 401, description: 'Unauthorized' })
    const method = match[2]
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', async () => {
      const params = raw ? JSON.parse(raw) : {}
      const ok = (result) => reply(200, { ok: true, result })
      switch (method) {
        case 'getMe':
          return ok({ id: 424242, is_bot: true, first_name: 'NEARKITS Test', username })
        case 'getWebhookInfo':
          return ok({ url: '', pending_update_count: 0 })
        case 'getUpdates': {
          const offset = Number(params.offset ?? 0)
          while (queue.length && queue[0].update_id < offset) queue.shift()
          if (!queue.length) await new Promise((r) => (waiters.add(r), setTimeout(r, Math.min(Number(params.timeout ?? 0), 2) * 1000)))
          while (queue.length && queue[0].update_id < offset) queue.shift()
          return ok(queue.slice(0, 100))
        }
        case 'sendMessage':
        case 'editMessageText': {
          const id = method === 'sendMessage' ? messageId++ : params.message_id
          sent.push({ method, chatId: params.chat_id, messageId: id, text: params.text, buttons: (params.reply_markup?.inline_keyboard ?? []).flat() })
          return ok({ message_id: id, date: 0, chat: { id: params.chat_id, type: params.chat_id < 0 ? 'supergroup' : 'private' }, text: params.text })
        }
        case 'getChatMember':
          return ok({ status: 'administrator', user: { id: params.user_id, is_bot: false, first_name: 'Admin' } })
        default:
          return ok(true)
      }
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`

  return {
    url,
    sent,
    /** A user action; returns the update as queued. */
    push(update) {
      const full = { update_id: updateId++, ...update }
      queue.push(full)
      wake()
      return full
    },
    /** Waits for the bot to send a message matching `test` (to `chatId`) after index `from`. */
    async waitFor(chatId, test, { from = 0, timeoutMs = 10_000 } = {}) {
      const started = Date.now()
      for (;;) {
        const hit = sent.slice(from).find((m) => m.chatId === chatId && test(m))
        if (hit) return hit
        if (Date.now() - started > timeoutMs)
          throw new Error(`The bot sent nothing matching to ${chatId} within ${timeoutMs} ms. Last: ${JSON.stringify(sent.at(-1)?.text ?? null)}`)
        await new Promise((r) => setTimeout(r, 50))
      }
    },
    close: () => new Promise((r) => server.close(r)),
  }
}
