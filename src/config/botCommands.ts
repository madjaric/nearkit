/**
 * The NearKit Telegram bot's commands: one list for the bot (its /help and
 * Telegram's command menu) and the web app's Telegram page. A command is listed
 * here only once the bot really implements it.
 */

export type BotSection = 'Account' | 'Trading' | 'Portfolio' | 'Groups' | 'General'

export interface BotCommandDoc {
  name: string
  /** Arguments, e.g. "[token] [NEAR amount]". */
  usage?: string
  description: string
  section: BotSection
  /** Where it works: private chats, groups, or both. */
  scope: 'private' | 'group' | 'any'
}

export const BOT_COMMANDS: readonly BotCommandDoc[] = Object.freeze([
  { name: 'link', description: 'link a NEAR account (you sign a free message in your wallet)', section: 'Account', scope: 'private' },
  { name: 'accounts', description: 'linked accounts and the default one', section: 'Account', scope: 'private' },
  { name: 'unlink', description: 'remove a linked account', section: 'Account', scope: 'private' },
  { name: 'settings', description: 'slippage, buy amounts, notifications', section: 'Account', scope: 'private' },
  { name: 'help', description: 'what the bot can do', section: 'General', scope: 'any' },
  { name: 'cancel', description: 'stop what the bot is waiting for', section: 'General', scope: 'any' },
])

export function commandDoc(name: string): BotCommandDoc {
  const doc = BOT_COMMANDS.find((c) => c.name === name)
  if (!doc) throw new Error(`No documentation for /${name}: add it to BOT_COMMANDS`)
  return doc
}
