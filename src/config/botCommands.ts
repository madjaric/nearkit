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
  { name: 'buy', usage: '[token] [NEAR amount]', description: 'buy a token with NEAR; you sign in the NearKit web app', section: 'Trading', scope: 'private' },
  { name: 'sell', usage: '[token] [amount or %]', description: 'sell a token for NEAR; you sign in the NearKit web app', section: 'Trading', scope: 'private' },
  { name: 'quote', usage: '[token] [NEAR amount]', description: 'price a buy through Rhea without signing anything', section: 'Trading', scope: 'private' },
  { name: 'token', usage: '<symbol or contract>', description: 'token details read from chain', section: 'Trading', scope: 'private' },
  { name: 'balance', description: 'balances of your default linked account', section: 'Trading', scope: 'private' },
  { name: 'buybot', description: 'buy alerts for a token in your group (group admins)', section: 'Groups', scope: 'any' },
  { name: 'help', description: 'what the bot can do', section: 'General', scope: 'any' },
  { name: 'cancel', description: 'stop what the bot is waiting for', section: 'General', scope: 'any' },
])

export function commandDoc(name: string): BotCommandDoc {
  const doc = BOT_COMMANDS.find((c) => c.name === name)
  if (!doc) throw new Error(`No documentation for /${name}: add it to BOT_COMMANDS`)
  return doc
}
