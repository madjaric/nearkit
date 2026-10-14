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
  { name: 'bridge', description: 'bring SOL, ETH or BNB to NEAR in your NEARKITS wallet, through NEAR Intents', section: 'Account', scope: 'private' },
  {
    name: 'withdraw',
    description: 'send NEAR or tokens from your NEARKITS wallet to your owner wallet, your other NEARKITS wallets, or an address you approved',
    section: 'Account',
    scope: 'private',
  },
  { name: 'link', description: 'link a NEAR account (you sign a free message in your wallet)', section: 'Account', scope: 'private' },
  { name: 'accounts', description: 'linked accounts and the default one', section: 'Account', scope: 'private' },
  { name: 'unlink', description: 'remove a linked account', section: 'Account', scope: 'private' },
  { name: 'settings', description: 'slippage, buy and sell buttons, trade alerts', section: 'Account', scope: 'private' },
  { name: 'referral', description: 'your invite link, what it earned, and payouts', section: 'Account', scope: 'private' },
  { name: 'web', description: 'open your NEARKITS wallets on NEARKITS web (a one-time sign-in link)', section: 'Account', scope: 'private' },
  { name: 'buy', usage: '[token] [NEAR amount]', description: 'buy a token with NEAR, right here from your NEARKITS wallet', section: 'Trading', scope: 'private' },
  { name: 'sell', usage: '[token] [amount or %]', description: 'sell a token for NEAR, right here from your NEARKITS wallet', section: 'Trading', scope: 'private' },
  {
    name: 'quote',
    usage: '[token] [NEAR amount]',
    description: 'see a buy’s price first, the same flow as /buy: nothing trades unless you then confirm it',
    section: 'Trading',
    scope: 'private',
  },
  { name: 'token', usage: '<symbol or contract>', description: 'token details read from chain', section: 'Trading', scope: 'private' },
  { name: 'balance', description: 'balances of your selected NEARKITS wallet', section: 'Trading', scope: 'private' },
  {
    name: 'volume',
    usage: '[start|pause|resume|stop]',
    description: 'your Volume Bot: status, volume, PnL; start, pause, resume or stop it',
    section: 'Trading',
    scope: 'private',
  },
  {
    name: 'orders',
    description: 'limit orders, take profit and stop loss from your NEARKITS wallet: list, new, pause, cancel',
    section: 'Trading',
    scope: 'private',
  },
  { name: 'copy', description: 'Copy Trade: follow a NEAR account’s swaps within your limits', section: 'Trading', scope: 'private' },
  {
    name: 'snipe',
    description: 'Sniper: be told (or buy) the moment a token starts trading, or when new pools appear (Nearly launches, meme.cooking graduations)',
    section: 'Trading',
    scope: 'private',
  },
  { name: 'dca', description: 'DCA: buy a token with NEAR on a schedule', section: 'Trading', scope: 'private' },
  { name: 'auto', description: 'all your automations: status, pause, resume, stop, Pause all', section: 'Trading', scope: 'private' },
  { name: 'positions', description: 'holdings with cost basis and PnL from on-chain history', section: 'Portfolio', scope: 'private' },
  { name: 'pnl', usage: '[7d|30d|90d]', description: 'realized and unrealized PnL', section: 'Portfolio', scope: 'private' },
  { name: 'buybot', description: 'buy alerts for a token in your group (group admins)', section: 'Groups', scope: 'any' },
  { name: 'add', usage: '[contract]', description: 'follow a token’s buys in this group', section: 'Groups', scope: 'group' },
  { name: 'list', description: 'tokens this group follows and their settings', section: 'Groups', scope: 'group' },
  { name: 'remove', description: 'stop following a token here', section: 'Groups', scope: 'group' },
  { name: 'pause', description: 'pause every buy alert in this group', section: 'Groups', scope: 'group' },
  { name: 'resume', description: 'resume buy alerts in this group', section: 'Groups', scope: 'group' },
  { name: 'start', description: 'open the main menu: your wallet, trading, the Bridge and $KITS', section: 'General', scope: 'any' },
  { name: 'kits', description: '$KITS, the NEARKITS token: contract, live market, burns and holder rewards', section: 'General', scope: 'private' },
  { name: 'community', description: 'the NEARKITS community on Telegram, and NEARKITS on X', section: 'General', scope: 'private' },
  { name: 'help', description: 'what the bot can do', section: 'General', scope: 'any' },
  { name: 'cancel', description: 'stop what the bot is waiting for', section: 'General', scope: 'any' },
])

/**
 * What Telegram's command menu leads with, in this order, for new and returning users: /start, then
 * bringing funds in and $KITS, then help and the account basics, then /cancel. Every other command
 * follows in the order the bot registers it; this changes the order only, never which commands exist.
 */
export const MENU_FIRST: readonly string[] = Object.freeze(['start', 'bridge', 'kits', 'community', 'help', 'accounts', 'link', 'unlink', 'cancel'])

export function commandDoc(name: string): BotCommandDoc {
  const doc = BOT_COMMANDS.find((c) => c.name === name)
  if (!doc) throw new Error(`No documentation for /${name}: add it to BOT_COMMANDS`)
  return doc
}
