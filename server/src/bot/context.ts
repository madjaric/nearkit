import { commandDoc } from '@/config/botCommands'
import type { ServerConfig } from '../config'
import type { Store } from '../db/store'
import type { LinkService } from '../link/service'
import type { Handoffs } from '../trade/handoff'
import type { Logger } from '../log'
import type { ServerNear } from '../near'
import type { TelegramApi } from '../telegram/api'
import type { BuybotStore } from '../buybot/store'
import type { CustodyDeps } from '../custody/wallets'
import type { BuyMarket } from '../buybot/market'
import type { Follower, TxIndex } from '../buybot/follower'
import type { ForceReply, InlineButton, InlineKeyboard, TgChat, TgChatMemberUpdated, TgMessage, TgUser } from '../telegram/types'

/** Everything a bot handler may use. Handlers never see the bot token. */
export interface BotDeps {
  tg: TelegramApi
  store: Store
  config: ServerConfig
  near: ServerNear
  link: LinkService
  /** Trades prepared here and signed in the web app. */
  handoffs: Handoffs
  log: Logger
  now: () => number
  me: { id: number; username: string }
  /** Names of the commands this bot has, filled in by the router: menus only offer what exists. */
  features: Set<string>
  /** Buy alerts; null when the buybot is off. */
  buybot: BuybotDeps | null
  /** NearKit trading wallets; null when they are off here (mainnet, or no key-encryption key). */
  custody: CustodyDeps | null
}

export interface BuybotDeps {
  store: BuybotStore
  /** NearKit services on the network the buybot follows (may differ from trading's). */
  near: ServerNear
  market: BuyMarket
  follower: Follower
  index: TxIndex
}

export interface BotCtx {
  deps: BotDeps
  chat: TgChat
  user: TgUser
  isPrivate: boolean
  /** The message a pressed button sits on; null for commands and text. */
  message: TgMessage | null
  /** Sends a new message in this chat. */
  reply(html: string, markup?: InlineKeyboard | ForceReply): Promise<TgMessage>
  /** Replaces the pressed button's message, or sends a new one for commands. */
  show(html: string, markup?: InlineKeyboard): Promise<void>
  /** Acknowledges a pressed button (a toast when `text` is given). No-op otherwise. */
  answer(text?: string, alert?: boolean): Promise<void>
}

export type CommandScope = 'private' | 'group' | 'any'

export type CommandSection = 'Account' | 'Trading' | 'Portfolio' | 'Groups' | 'General'

export interface Command {
  scope: CommandScope
  /** Listed in /help and Telegram's command menu when set. */
  description?: string
  section?: CommandSection
  /** Arguments, for /help, e.g. "[token] [NEAR amount]". */
  usage?: string
  run(ctx: BotCtx, args: string): Promise<void>
}

/** A pressed button: `data` is `namespace:action[:arg]`, at most 64 bytes. */
export type CallbackHandler = (ctx: BotCtx, action: string, arg: string) => Promise<void>

/** Free text (or a photo, GIF or video, with its caption as text) while a conversation step waits for input. */
export type FlowHandler = (ctx: BotCtx, text: string, data: Record<string, unknown>, message?: TgMessage) => Promise<void>

export interface BotModule {
  commands?: Record<string, Command>
  callbacks?: Record<string, CallbackHandler>
  flows?: Record<string, FlowHandler>
  /** The bot was added to or removed from a chat. */
  onMembership?: (deps: BotDeps, update: TgChatMemberUpdated) => Promise<void>
  /** A group became a supergroup with a new ID. */
  onChatMigrated?: (deps: BotDeps, from: number, to: number) => Promise<void>
}

// ─── keyboard helpers ───────────────────────────────────────────────────────

export const btn = (text: string, data: string): InlineButton => {
  if (new TextEncoder().encode(data).length > 64) throw new Error(`callback_data over 64 bytes: ${data}`)
  return { text, callback_data: data }
}
export const urlBtn = (text: string, url: string): InlineButton => ({ text, url })
export const keyboard = (...rows: (InlineButton | null)[][]): InlineKeyboard => ({
  inline_keyboard: rows.map((r) => r.filter((b): b is InlineButton => b !== null)).filter((r) => r.length),
})

/** Conversation steps time out so a stale prompt never swallows a later message. */
export const FLOW_TTL_MS = 10 * 60_000

/** Scope, description and section of a command, from the list the web app shows too. */
export function documented(name: string): Pick<Command, 'scope' | 'description' | 'section' | 'usage'> {
  const d = commandDoc(name)
  return { scope: d.scope, description: d.description, section: d.section, ...(d.usage ? { usage: d.usage } : {}) }
}
