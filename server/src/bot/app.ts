import { NearKitError } from '@/services/near/errors'
import { LinkApiError } from '../link/service'
import { TelegramError } from '../telegram/api'
import { esc } from '../telegram/html'
import type { InlineKeyboard, TgCallbackQuery, TgChat, TgMessage, TgUpdate, TgUser } from '../telegram/types'
import type { BotCtx, BotDeps, BotModule, Command } from './context'
import { Buckets } from './ratelimit'

/**
 * Routes Telegram updates to the modules' commands, buttons and conversation
 * steps. Everything a user sends passes through here first: users are recorded,
 * floods are dropped, and every handler runs inside one error boundary, so a
 * failing handler answers with a plain message and never stops the bot.
 */

export interface BotApp {
  handle(update: TgUpdate): Promise<void>
  commands(): { name: string; command: Command }[]
  /** Message a user outside any update (e.g. "your account is linked"). False when they can't be reached. */
  notify(userId: number, html: string, markup?: InlineKeyboard): Promise<boolean>
}

const EVENTS_PER_MINUTE = 30

export function userMessage(e: unknown): string | null {
  if (e instanceof NearKitError) return e.message
  if (e instanceof LinkApiError) return e.message
  return null
}

export function createBotApp(
  deps: BotDeps,
  modules: BotModule[],
  options: {
    /** True the first time an update ID is seen (shared by every instance); a repeat is ignored. */
    firstDelivery?: (updateId: number) => Promise<boolean>
  } = {},
): BotApp {
  const membership = modules.flatMap((m) => (m.onMembership ? [m.onMembership] : []))
  const migrations = modules.flatMap((m) => (m.onChatMigrated ? [m.onChatMigrated] : []))
  const commands = new Map<string, Command>()
  const callbacks = new Map<string, NonNullable<BotModule['callbacks']>[string]>()
  const flows = new Map<string, NonNullable<BotModule['flows']>[string]>()
  for (const m of modules) {
    for (const [name, c] of Object.entries(m.commands ?? {})) commands.set(name, c)
    for (const [ns, h] of Object.entries(m.callbacks ?? {})) callbacks.set(ns, h)
    for (const [flow, h] of Object.entries(m.flows ?? {})) flows.set(flow, h)
  }
  deps.features = new Set(commands.keys())
  const perUser = new Buckets(EVENTS_PER_MINUTE / 2, EVENTS_PER_MINUTE / 60, deps.now)
  const warned = new Map<number, number>()

  function makeCtx(chat: TgChat, user: TgUser, message: TgMessage | null, query: TgCallbackQuery | null): BotCtx {
    let answered = false
    const ctx: BotCtx = {
      deps,
      chat,
      user,
      isPrivate: chat.type === 'private',
      message,
      reply: (html, markup) => deps.tg.sendMessage(chat.id, html, markup ? { reply_markup: markup } : {}),
      async show(html, markup) {
        if (query && message) {
          await deps.tg.editMessageText(chat.id, message.message_id, html, markup ? { reply_markup: markup } : {})
        } else {
          await ctx.reply(html, markup)
        }
      },
      async answer(text, alert) {
        if (!query || answered) return
        answered = true
        await deps.tg.answerCallbackQuery(query.id, text, alert).catch(() => undefined)
      },
    }
    return ctx
  }

  async function recordUser(user: TgUser) {
    await deps.store.upsertUser({ userId: user.id, username: user.username ?? null, firstName: user.first_name || 'there', languageCode: user.language_code ?? null })
  }

  async function guarded(ctx: BotCtx, what: string, run: () => Promise<void>) {
    try {
      await run()
    } catch (e) {
      const known = userMessage(e)
      if (e instanceof TelegramError && e.blocked) {
        await deps.store.markBlocked(ctx.user.id)
        return
      }
      if (!known) deps.log.error('handler failed', { what, error: e })
      else deps.log.info('handler refused', { what, reason: known })
      await ctx.answer().catch(() => undefined)
      await ctx.reply(known ? `⚠️ ${esc(known)}` : '⚠️ Something went wrong on NearKit’s side. Nothing was sent or signed. Try again in a moment.').catch(() => undefined)
    } finally {
      await ctx.answer().catch(() => undefined)
    }
  }

  function allowed(user: TgUser): boolean {
    if (perUser.take(String(user.id))) return true
    return false
  }

  async function onFlood(ctx: BotCtx) {
    const t = deps.now()
    if ((warned.get(ctx.user.id) ?? 0) > t - 60_000) return
    warned.set(ctx.user.id, t)
    await ctx.answer('Slow down a little: too many requests.', false)
    if (ctx.isPrivate) await ctx.reply('⏳ Too many requests. Wait a few seconds and try again.').catch(() => undefined)
  }

  function parseCommand(text: string): { name: string; args: string; addressedElsewhere: boolean } | null {
    const m = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{3,64}))?(?:\s+([\s\S]*))?$/.exec(text.trim())
    if (!m) return null
    const [, name, target, args] = m as unknown as [string, string, string | undefined, string | undefined]
    return { name: name.toLowerCase(), args: (args ?? '').trim(), addressedElsewhere: target !== undefined && target.toLowerCase() !== deps.me.username.toLowerCase() }
  }

  async function onMessage(message: TgMessage) {
    if (message.migrate_to_chat_id) {
      for (const hook of migrations) await hook(deps, message.chat.id, message.migrate_to_chat_id).catch((e: unknown) => deps.log.warn('migration hook failed', { error: e }))
      return
    }
    const user = message.from
    // Text, or media a waiting step may want (e.g. a buybot's photo); nothing else.
    const hasMedia = Boolean(message.photo?.length || message.animation || message.video)
    if (!user || user.is_bot || (!message.text && !hasMedia)) return
    await recordUser(user)
    const ctx = makeCtx(message.chat, user, null, null)
    if (!allowed(user)) return onFlood(ctx)
    const cmd = message.text?.startsWith('/') ? parseCommand(message.text) : null
    if (cmd) {
      if (cmd.addressedElsewhere) return
      const command = commands.get(cmd.name)
      if (!command) {
        if (ctx.isPrivate) await ctx.reply(`I don’t know /${esc(cmd.name)}. Send /help for what I can do.`)
        return
      }
      if (command.scope === 'private' && !ctx.isPrivate) {
        await ctx.reply(`For your privacy, /${esc(cmd.name)} works in a private chat with me.`, {
          inline_keyboard: [[{ text: 'Open a private chat', url: `https://t.me/${deps.me.username}?start=${encodeURIComponent(cmd.name)}` }]],
        })
        return
      }
      if (command.scope === 'group' && ctx.isPrivate) {
        await ctx.reply(`/${esc(cmd.name)} works in a group. Add me to your group and send it there.`)
        return
      }
      // A new command abandons whatever step was waiting for text.
      await deps.store.clearSession(ctx.chat.id, user.id)
      await guarded(ctx, `/${cmd.name}`, () => command.run(ctx, cmd.args))
      return
    }
    const session = await deps.store.getSession(ctx.chat.id, user.id)
    const flow = session ? flows.get(session.flow) : undefined
    if (session && flow) {
      await guarded(ctx, `flow ${session.flow}`, () => flow(ctx, message.text ?? message.caption ?? '', session.data, message))
      return
    }
    if (ctx.isPrivate && message.text) await ctx.reply('Send /help to see what I can do, or /start for the menu.')
  }

  async function onCallback(query: TgCallbackQuery) {
    const user = query.from
    const message = query.message
    if (!message) return deps.tg.answerCallbackQuery(query.id).then(() => undefined)
    await recordUser(user)
    const ctx = makeCtx(message.chat, user, message, query)
    if (!allowed(user)) return onFlood(ctx)
    const data = query.data ?? ''
    const [ns = '', action = '', ...rest] = data.split(':')
    const handler = callbacks.get(ns)
    if (!handler) {
      await ctx.answer('This button no longer works. Send /start.', false)
      return
    }
    await guarded(ctx, `button ${ns}:${action}`, () => handler(ctx, action, rest.join(':')))
  }

  return {
    async handle(update) {
      // A retried or re-read update (restart, leader change) runs once.
      if (options.firstDelivery && !(await options.firstDelivery(update.update_id))) return
      if (update.message) return onMessage(update.message)
      if (update.callback_query) return onCallback(update.callback_query)
      if (update.my_chat_member) {
        for (const hook of membership) await hook(deps, update.my_chat_member).catch((e: unknown) => deps.log.warn('membership hook failed', { error: e }))
      }
    },
    commands: () => [...commands.entries()].map(([name, command]) => ({ name, command })),
    async notify(userId, html, markup) {
      const user = await deps.store.getUser(userId)
      if (!user || user.blockedAt !== null) return false
      try {
        await deps.tg.sendMessage(userId, html, markup ? { reply_markup: markup } : {})
        return true
      } catch (e) {
        if (e instanceof TelegramError && e.blocked) await deps.store.markBlocked(userId)
        else deps.log.warn('notify failed', { error: e })
        return false
      }
    },
  }
}
