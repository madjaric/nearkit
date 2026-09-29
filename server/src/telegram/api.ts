import { redact } from '../log'
import type { InlineKeyboard, SendOptions, TgChat, TgChatMember, TgMessage, TgUpdate, TgUser } from './types'

/**
 * Telegram Bot API client over fetch. The token lives only in the request URL
 * built here; errors are rebuilt from the method name and Telegram's own
 * description so neither the URL nor the token can reach a log.
 *
 * Rate limits (https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this):
 * about 30 messages a second overall, 1 a second in a chat, 20 a minute in a
 * group. Sends are spaced per chat, and a 429's `retry_after` is honoured.
 */

export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
    readonly retryAfter: number | null = null,
    readonly migrateTo: number | null = null,
  ) {
    super(`Telegram ${method} failed: ${code} ${description}`)
    this.name = 'TelegramError'
  }
  /** The user blocked the bot, or the bot was removed from the chat. */
  get blocked(): boolean {
    return this.code === 403
  }
}

export interface TelegramApiOptions {
  token: string
  fetch?: typeof fetch
  baseUrl?: string
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Longest 429 wait handled inside a call; longer ones are thrown to the caller. */
  maxInlineWaitMs?: number
}

const PRIVATE_SPACING_MS = 250
const GROUP_SPACING_MS = 3_100
const GLOBAL_SPACING_MS = 35

const isGroupChat = (chatId: number | string) => typeof chatId === 'string' || chatId < 0

export function createTelegramApi(options: TelegramApiOptions) {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  const base = (options.baseUrl ?? 'https://api.telegram.org').replace(/\/$/, '')
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = options.now ?? Date.now
  const maxInlineWait = options.maxInlineWaitMs ?? 30_000
  const secrets = [options.token]

  // Per-chat and global spacing for message sends.
  const nextSlot = new Map<string, number>()
  let nextGlobal = 0
  let chain: Promise<void> = Promise.resolve()

  function reserve(chatId: number | string): Promise<void> {
    // Serialized so two concurrent sends to one chat can't take the same slot.
    const run = chain.then(async () => {
      const key = String(chatId)
      const t = now()
      const start = Math.max(t, nextSlot.get(key) ?? 0, nextGlobal)
      nextSlot.set(key, start + (isGroupChat(chatId) ? GROUP_SPACING_MS : PRIVATE_SPACING_MS))
      nextGlobal = start + GLOBAL_SPACING_MS
      if (start > t) await sleep(start - t)
    })
    chain = run.catch(() => undefined)
    return run
  }

  function pauseChat(chatId: number | string, ms: number) {
    const key = String(chatId)
    nextSlot.set(key, Math.max(nextSlot.get(key) ?? 0, now() + ms))
  }

  async function once<T>(method: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    // The caller's signal lives long (the poller's): detach from it when this call ends.
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    let res: Response
    try {
      res = await fetchImpl(`${base}/bot${options.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      })
    } catch (e) {
      const reason = e instanceof Error && e.name === 'AbortError' ? 'timed out' : 'network error'
      const detail = e instanceof Error ? redact(String((e.cause as { code?: string } | undefined)?.code ?? ''), secrets) : ''
      throw new TelegramError(method, 0, `${reason}${detail ? ` (${detail})` : ''}`)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    let body: { ok?: boolean; result?: unknown; error_code?: number; description?: string; parameters?: { retry_after?: number; migrate_to_chat_id?: number } }
    try {
      body = (await res.json()) as typeof body
    } catch {
      throw new TelegramError(method, res.status, `HTTP ${res.status} without a JSON body`)
    }
    if (body.ok) return body.result as T
    throw new TelegramError(
      method,
      body.error_code ?? res.status,
      redact(body.description ?? 'unknown error', secrets),
      body.parameters?.retry_after ?? null,
      body.parameters?.migrate_to_chat_id ?? null,
    )
  }

  async function call<T>(method: string, params: Record<string, unknown> = {}, opts: { timeoutMs?: number; retries?: number; signal?: AbortSignal } = {}): Promise<T> {
    const retries = opts.retries ?? 2
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await once<T>(method, params, opts.timeoutMs ?? 15_000, opts.signal)
      } catch (e) {
        if (!(e instanceof TelegramError) || attempt >= retries) throw e
        if (e.code === 429 && e.retryAfter !== null) {
          const wait = e.retryAfter * 1000
          if (params.chat_id !== undefined) pauseChat(params.chat_id as number, wait)
          if (wait > maxInlineWait) throw e
          await sleep(wait + 250)
          continue
        }
        if (e.code === 0 || e.code >= 500) {
          await sleep(500 * 3 ** attempt)
          continue
        }
        throw e
      }
    }
  }

  async function send<T>(method: string, chatId: number | string, params: Record<string, unknown>): Promise<T> {
    await reserve(chatId)
    return call<T>(method, { chat_id: chatId, ...params })
  }

  const extras = (opts: SendOptions = {}) => ({
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: opts.disable_link_preview ?? true },
    ...(opts.reply_markup ? { reply_markup: opts.reply_markup } : {}),
    ...(opts.reply_to_message_id ? { reply_parameters: { message_id: opts.reply_to_message_id, allow_sending_without_reply: true } } : {}),
    ...(opts.disable_notification ? { disable_notification: true } : {}),
  })

  return {
    call,
    getMe: () => call<TgUser & { can_join_groups?: boolean; can_read_all_group_messages?: boolean }>('getMe'),
    getUpdates: (offset: number, timeoutSec: number, allowed: string[], signal?: AbortSignal) =>
      call<TgUpdate[]>('getUpdates', { offset, timeout: timeoutSec, allowed_updates: allowed }, { timeoutMs: (timeoutSec + 15) * 1000, retries: 0, signal }),
    getWebhookInfo: () => call<{ url: string; pending_update_count: number }>('getWebhookInfo'),
    sendMessage: (chatId: number | string, html: string, opts?: SendOptions) => send<TgMessage>('sendMessage', chatId, { text: html, ...extras(opts) }),
    /** A photo, GIF or video (by Telegram file_id) with the HTML text as its caption (at most 1024 characters). */
    sendMedia: (chatId: number | string, kind: 'photo' | 'animation' | 'video', fileId: string, captionHtml: string, opts?: SendOptions) => {
      const { link_preview_options: _preview, ...rest } = extras(opts)
      const method = kind === 'photo' ? 'sendPhoto' : kind === 'animation' ? 'sendAnimation' : 'sendVideo'
      return send<TgMessage>(method, chatId, { [kind]: fileId, caption: captionHtml, ...rest })
    },
    /** Null when Telegram says the message is unchanged (a harmless double tap). */
    async editMessageText(chatId: number, messageId: number, html: string, opts?: { reply_markup?: InlineKeyboard; disable_link_preview?: boolean }): Promise<TgMessage | null> {
      try {
        return await send<TgMessage>('editMessageText', chatId, { message_id: messageId, text: html, ...extras(opts) })
      } catch (e) {
        if (e instanceof TelegramError && e.code === 400 && /message is not modified/i.test(e.description)) return null
        throw e
      }
    },
    answerCallbackQuery: (id: string, text?: string, alert = false) =>
      call<boolean>('answerCallbackQuery', { callback_query_id: id, ...(text ? { text, show_alert: alert } : {}) }),
    deleteMessage: (chatId: number, messageId: number) => call<boolean>('deleteMessage', { chat_id: chatId, message_id: messageId }),
    getChatMember: (chatId: number | string, userId: number) => call<TgChatMember>('getChatMember', { chat_id: chatId, user_id: userId }),
    getChat: (chatId: number | string) => call<TgChat>('getChat', { chat_id: chatId }),
    setMyCommands: (commands: { command: string; description: string }[], scope?: { type: string }) => call<boolean>('setMyCommands', { commands, ...(scope ? { scope } : {}) }),
    deleteWebhook: () => call<boolean>('deleteWebhook', { drop_pending_updates: false }),
  }
}

export type TelegramApi = ReturnType<typeof createTelegramApi>
