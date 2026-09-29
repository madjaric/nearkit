import type { TgChatMember, TgUpdate } from './types'

/**
 * An in-process stand-in for api.telegram.org, for tests. It answers the
 * methods NearKit uses, records every call, and can be told to fail the next
 * call of a method (e.g. with 429 Too Many Requests). No network, no token.
 */

export interface FakeCall {
  method: string
  params: Record<string, unknown>
  /** Telegram refused it (failNext): nothing reached the chat. */
  failed?: boolean
}

export interface FakeTelegram {
  fetch: typeof fetch
  calls: FakeCall[]
  /** Delivered sendMessage / editMessageText calls, flattened to what a user would see. */
  messages(): { chatId: number; text: string; buttons: { text: string; data?: string; url?: string; copy?: string }[]; method: string; messageId: number }[]
  push(update: Omit<TgUpdate, 'update_id'>): TgUpdate
  failNext(method: string, error: { code: number; description: string; retryAfter?: number }): void
  members: Map<string, TgChatMember>
  token: string
}

export function createFakeTelegram(options: { token?: string; username?: string } = {}): FakeTelegram {
  const token = options.token ?? '1111111111:FAKE-token-for-tests-only-0000000000'
  const calls: FakeCall[] = []
  const queue: TgUpdate[] = []
  const failures = new Map<string, { code: number; description: string; retryAfter?: number }[]>()
  const members = new Map<string, TgChatMember>()
  let updateId = 1000
  let messageId = 1

  const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } })
  const fail = (code: number, description: string, retryAfter?: number) =>
    new Response(JSON.stringify({ ok: false, error_code: code, description, ...(retryAfter ? { parameters: { retry_after: retryAfter } } : {}) }), {
      status: code,
      headers: { 'content-type': 'application/json' },
    })

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname)
    if (!match) return new Response('not found', { status: 404 })
    const [, tok, method] = match as unknown as [string, string, string]
    if (tok !== token) return fail(401, 'Unauthorized')
    const params = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    calls.push({ method, params })
    const pending = failures.get(method)
    const failure = pending?.shift()
    if (failure) {
      ;(calls[calls.length - 1] as FakeCall).failed = true
      return fail(failure.code, failure.description, failure.retryAfter)
    }
    switch (method) {
      case 'getMe':
        return ok({ id: 1111111111, is_bot: true, first_name: 'NearKit', username: options.username ?? 'NearKitBot' })
      case 'getUpdates': {
        const offset = Number(params.offset ?? 0)
        while (queue.length && (queue[0] as TgUpdate).update_id < offset) queue.shift()
        return ok(queue.slice(0, Number(params.limit ?? 100)))
      }
      case 'sendMessage':
      case 'sendPhoto':
      case 'sendAnimation':
      case 'sendVideo': {
        const id = messageId++
        return ok({ message_id: id, date: 0, chat: { id: params.chat_id, type: 'private' }, text: params.text ?? params.caption })
      }
      case 'editMessageText':
        return ok({ message_id: params.message_id, date: 0, chat: { id: params.chat_id, type: 'private' }, text: params.text })
      case 'getChatMember': {
        const m = members.get(`${String(params.chat_id)}:${String(params.user_id)}`)
        return m ? ok(m) : fail(400, 'Bad Request: user not found')
      }
      case 'getChat':
        return ok({ id: params.chat_id, type: String(params.chat_id).startsWith('-') ? 'supergroup' : 'private', title: 'Test group' })
      default:
        return ok(true)
    }
  }) as typeof fetch

  return {
    fetch: fetchImpl,
    calls,
    token,
    members,
    messages() {
      return calls
        .filter((c) => !c.failed && ['sendMessage', 'editMessageText', 'sendPhoto', 'sendAnimation', 'sendVideo'].includes(c.method))
        .map((c) => {
          const markup = c.params.reply_markup as { inline_keyboard?: { text: string; callback_data?: string; url?: string; copy_text?: { text: string } }[][] } | undefined
          return {
            method: c.method,
            chatId: Number(c.params.chat_id),
            messageId: Number(c.params.message_id ?? 0),
            text: String(c.params.text ?? c.params.caption ?? ''),
            buttons: (markup?.inline_keyboard ?? []).flat().map((b) => ({
              text: b.text,
              ...(b.callback_data ? { data: b.callback_data } : {}),
              ...(b.url ? { url: b.url } : {}),
              ...(b.copy_text ? { copy: b.copy_text.text } : {}),
            })),
          }
        })
    },
    push(update) {
      const full = { update_id: updateId++, ...update } as TgUpdate
      queue.push(full)
      return full
    },
    failNext(method, error) {
      failures.set(method, [...(failures.get(method) ?? []), error])
    },
  }
}
