import { MAX_BOT_WALLETS, MAX_TWAP_SEC, MIN_EDGE_BPS, MIN_INTERVAL_SEC, MIN_TWAP_SEC } from '@/lib/volumeBot/config'
import { NEARKIT_FEE_LABEL, RHEA_APP_FEE_SHARE_LABEL } from '@/lib/fees'
import { MAX_ACTIVE_WALLETS_PER_USER } from '@/lib/walletLimits'

/** A bot trades from the user's own NEARKITS wallets: never more than a user can have. */
const BOT_WALLETS = Math.min(MAX_BOT_WALLETS, MAX_ACTIVE_WALLETS_PER_USER)

/**
 * The public Volume Bot page's words, kept apart so the page and its structured data (FAQPage)
 * say exactly the same thing. Every figure here is read from the bot's own configuration bounds.
 */

export const VOLUME_BOT_PATH = '/volume-bot'
export const VOLUME_BOT_CONSOLE_PATH = '/volume-bot/console'

export const VOLUME_BOT_TITLE = 'NEARKITS Volume Bot — Automated Trading on NEAR'
/** When this page's content last changed (shown on it, and its structured data's dateModified). */
export const VOLUME_BOT_UPDATED = '2026-10-06'

/** Outside references the page cites. */
export const LINKS = {
  rhea: 'https://rhea.finance/',
  near: 'https://www.near.org/',
  nep141: 'https://github.com/near/NEPs/blob/master/neps/nep-0141.md',
}
export const VOLUME_BOT_DESCRIPTION =
  'Automated trading on NEAR from your NEARKITS wallets: a market maker that trades only with an edge over fair value, TWAP orders, risk limits and a guardian.'

const days = (sec: number) => Math.round(sec / 86_400)
const minutes = (sec: number) => Math.round(sec / 60)

export const SPECS: { label: string; value: string; note: string }[] = [
  { label: 'Strategies', value: '3', note: 'Market maker · accumulate · distribute' },
  { label: 'Wallets per bot', value: `Up to ${BOT_WALLETS}`, note: 'Your own NEARKITS wallets only' },
  { label: 'Minimum edge', value: `${(MIN_EDGE_BPS / 100).toFixed(2)}%`, note: 'Over fair value, after every fee' },
  { label: 'Fastest check', value: `${MIN_INTERVAL_SEC} s`, note: 'Between evaluations' },
]

export const PIPELINE: { name: string; text: string }[] = [
  { name: 'Market data', text: 'A small buy and sell quoted through Rhea’s route, plus pool liquidity' },
  { name: 'Fair value', text: 'A time-weighted average of the price over your window' },
  { name: 'Guardian', text: 'Stale data, abnormal moves, thin liquidity: pause with the reason' },
  { name: 'Strategy', text: 'Trade or wait, and why, from price, inventory and schedule' },
  { name: 'Quote', text: 'The exact trade, accepted only if fresh and within your limits' },
  { name: 'Execution', text: 'The same custody path, checks and fee as a manual trade' },
  { name: 'Confirmation', text: 'Read from chain; a trade is never sent twice' },
  { name: 'Books', text: 'Fills, average cost, PnL and exposure per wallet' },
]

export interface FaqEntry {
  q: string
  a: string
}

export const FAQ: FaqEntry[] = [
  {
    q: 'Is the Volume Bot a wash-trading bot?',
    a: 'No. It never trades with itself and never moves tokens between your wallets to show activity. Every trade is a real swap against Rhea’s pools at the market price, made only when its strategy has a reason: the price is away from fair value by your edge, or a TWAP slice is due. Volume is what its trades add up to, not what it aims for.',
  },
  {
    q: 'Can the bot lose money?',
    a: 'Yes. Prices move, a pool can lose liquidity, and fees and gas apply to every trade. The bot only trades with an edge over its own estimate of fair value, and its limits and guardian cap the damage, but nothing guarantees a profit. Start small and set the daily loss and drawdown limits you can accept.',
  },
  {
    q: 'What does it cost?',
    a: `Each trade pays the same ${NEARKIT_FEE_LABEL} NEARKITS fee as a manual trade, taken inside Rhea’s route (Rhea’s aggregator keeps ${RHEA_APP_FEE_SHARE_LABEL} of it), plus Rhea’s own fees and NEAR gas. There is no separate fee for running a bot.`,
  },
  {
    q: 'Which wallets can it trade from?',
    a: `Only your own NEARKITS wallets, up to ${BOT_WALLETS} per bot (all a user can have). Watch-only accounts, wallets you connect in the browser and wallets NEARKITS has frozen are never used. Each trade comes from one wallet and settles there.`,
  },
  {
    q: 'How do I stop it?',
    a: 'Pause, Stop or Emergency stop in the console, or /volume pause and /volume stop in Telegram. Nothing new is sent from that moment; a trade already on chain settles and is recorded. NEARKITS can also pause every bot at once if a market or the network misbehaves.',
  },
  {
    q: 'Does it keep running when I close the page?',
    a: 'Yes. It runs on NEARKITS’s server, step by step under a lease so it is never run twice, and picks up where it was after a restart. NEARKITS tells you in Telegram when a bot starts and when the guardian pauses it.',
  },
  {
    q: 'Will it make my token trend, or add liquidity to its pool?',
    a: 'No. It swaps against the pools Rhea routes through and adds no liquidity to them. It has no volume target, and NEARKITS promises no trending spot, volume, liquidity, makers or profit: the volume the console shows is only what its own trades add up to.',
  },
  {
    q: 'Do I need exchange API keys or a server of my own?',
    a: 'No. It runs on NEARKITS’s server and trades from your NEARKITS wallets, whose keys NEARKITS holds for you (they are custodial). You set it up and watch it in the console on NEARKITS web; Telegram can pause, resume and stop it with /volume.',
  },
  {
    q: 'What does it do when market data is missing?',
    a: 'It doesn’t guess. With no fresh liquidity figure while you set a liquidity floor it pauses and says why; with no sell route, or a price impact it can’t measure, it waits instead of trading.',
  },
  {
    q: 'Which tokens can it trade?',
    a: 'NEP-141 tokens that Rhea routes against NEAR. The bot reads the token from chain when you save it, and pauses when its pool’s liquidity falls under your floor.',
  },
]

export const TWAP_RANGE = `${minutes(MIN_TWAP_SEC)} minutes to ${days(MAX_TWAP_SEC)} days`
