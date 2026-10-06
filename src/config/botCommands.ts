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
  { name: 'wallet', description: 'your NEARKITS wallet: balance, deposit, withdraw, recovery', section: 'Account', scope: 'private' },
  { name: 'deposit', description: 'the address to fund your NEARKITS wallet', section: 'Account', scope: 'private' },
  { name: 'withdraw', description: 'send NEAR or tokens from your NEARKITS wallet to any address', section: 'Account', scope: 'private' },
  { name: 'link', description: 'link a NEAR account (you sign a free message in your wallet)', section: 'Account', scope: 'private' },
  { name: 'accounts', description: 'linked accounts and the default one', section: 'Account', scope: 'private' },
  { name: 'unlink', description: 'remove a linked account', section: 'Account', scope: 'private' },
  { name: 'settings', description: 'slippage, buy and sell buttons, trade alerts', section: 'Account', scope: 'private' },
  { name: 'referral', description: 'your invite link, what it earned, and payouts', section: 'Account', scope: 'private' },
  { name: 'web', description: 'open your NEARKITS wallets on NEARKITS web (a one-time sign-in link)', section: 'Account', scope: 'private' },
  { name: 'buy', usage: '[token] [NEAR amount]', description: 'buy a token with NEAR, right here from your NEARKITS wallet', section: 'Trading', scope: 'private' },
  { name: 'sell', usage: '[token] [amount or %]', description: 'sell a token for NEAR, right here from your NEARKITS wallet', section: 'Trading', scope: 'private' },
  { name: 'quote', usage: '[token] [NEAR amount]', description: 'price a buy through Rhea without signing anything', section: 'Trading', scope: 'private' },
  { name: 'token', usage: '<symbol or contract>', description: 'token details read from chain', section: 'Trading', scope: 'private' },
  { name: 'balance', description: 'balances of your NEARKITS wallet (or your linked account)', section: 'Trading', scope: 'private' },
  {
    name: 'volume',
    usage: '[start|pause|resume|stop]',
    description: 'your Volume Bot: status, volume, PnL; start, pause, resume or stop it',
    section: 'Trading',
    scope: 'private',
  },
  { name: 'positions', description: 'holdings with cost basis and PnL from on-chain history', section: 'Portfolio', scope: 'private' },
  { name: 'pnl', usage: '[7d|30d|90d]', description: 'realized and unrealized PnL', section: 'Portfolio', scope: 'private' },
  { name: 'buybot', description: 'buy alerts for a token in your group (group admins)', section: 'Groups', scope: 'any' },
  { name: 'add', usage: '[contract]', description: 'follow a token’s buys in this group', section: 'Groups', scope: 'group' },
  { name: 'list', description: 'tokens this group follows and their settings', section: 'Groups', scope: 'group' },
  { name: 'remove', description: 'stop following a token here', section: 'Groups', scope: 'group' },
  { name: 'pause', description: 'pause every buy alert in this group', section: 'Groups', scope: 'group' },
  { name: 'resume', description: 'resume buy alerts in this group', section: 'Groups', scope: 'group' },
  { name: 'help', description: 'what the bot can do', section: 'General', scope: 'any' },
  { name: 'cancel', description: 'stop what the bot is waiting for', section: 'General', scope: 'any' },
])

export function commandDoc(name: string): BotCommandDoc {
  const doc = BOT_COMMANDS.find((c) => c.name === name)
  if (!doc) throw new Error(`No documentation for /${name}: add it to BOT_COMMANDS`)
  return doc
}
