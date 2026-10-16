import {
  ArrowDownToLine,
  ArrowLeftRight,
  BookOpen,
  Bot,
  ChartLine,
  ChevronsRight,
  Coins,
  Copy,
  Crosshair,
  Grid2x2,
  House,
  KeyRound,
  Layers,
  ListOrdered,
  Merge,
  MessageSquare,
  Radar,
  Repeat,
  Route,
  ScanSearch,
  SendHorizontal,
  Settings,
  Split,
  Trophy,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import { ENV } from '@/config/env'
import { TOP_WALLETS_PAUSED } from '@/config/paused'
import { TELEGRAM_BOT_LIVE } from '@/config/release'

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  /** What it does, in one plain line: the All Tools directory, the search box and the sidebar's tooltip print it. */
  description: string
  /** Words the command search also matches. */
  keywords?: string[]
  soon?: boolean
  end?: boolean
}

/** An entry that opens something in place instead of a page. */
export interface NavAction {
  action: 'quick-trade'
  label: string
  icon: LucideIcon
  description: string
  keywords?: string[]
}

export const isNavAction = (entry: NavItem | NavAction): entry is NavAction => 'action' in entry

export interface NavGroup {
  label: string
  items: (NavItem | NavAction)[]
}

export const NAV_HOME: NavItem = {
  to: '/',
  label: 'Dashboard',
  icon: House,
  end: true,
  description: 'Your portfolio, strategies and recent activity at a glance.',
  keywords: ['home', 'overview', 'terminal'],
}

/** The directory of every tool, by group, with search (the sidebar's last entry). */
export const NAV_ALL_TOOLS: NavItem = {
  to: '/tools',
  label: 'All Tools',
  icon: Grid2x2,
  description: 'Every NEARKITS tool by group, with what each one does.',
  keywords: ['tools', 'directory', 'features', 'catalog', 'everything'],
}

/**
 * MAIN: the sidebar draws the Dashboard and $KITS at its top itself; these follow them. In the All
 * Tools directory, Main lists these alone (the Dashboard and $KITS are pages, not tools).
 */
export const NAV_MAIN: NavGroup = {
  label: 'Main',
  items: [
    // SOL, ETH or BNB → NEAR (NEAR Intents), to fund NEARKITS wallets; nothing is bought. NEAR mainnet with NEARKITS' server; the demo previews it.
    {
      to: '/bridge-near',
      label: 'Bridge',
      icon: ArrowDownToLine,
      description: 'Move assets from other chains into NEAR.',
      soon: ENV.services === 'near' && (ENV.network !== 'mainnet' || !ENV.apiUrl),
      keywords: ['bridge', 'deposit', 'fund', 'top up', 'gas', 'solana', 'sol', 'ethereum', 'eth', 'bnb', 'cross-chain', 'near intents'],
    },
    // SOL, ETH or BNB → NEAR (NEAR Intents) → $KITS. NEAR mainnet with NEARKITS' server; the demo previews it.
    {
      to: '/bridge',
      label: 'Bridge & Buy',
      icon: Route,
      description: 'Bridge your assets and automatically buy $KITS.',
      soon: ENV.services === 'near' && (ENV.network !== 'mainnet' || !ENV.apiUrl),
      keywords: ['bridge', 'buy kits', 'solana', 'sol', 'ethereum', 'eth', 'bnb', 'cross-chain', 'near intents', 'deposit'],
    },
  ],
}

/**
 * The sidebar's groups, in order, MAIN first. An entry this build doesn't run yet stays in its
 * group with a SOON tag. The All Tools directory lists the same groups, so a tool is found in one
 * place under one name.
 */
export const NAV_GROUPS: NavGroup[] = [
  NAV_MAIN,
  {
    label: 'Trade',
    items: [
      { to: '/swap', label: 'Swap', icon: ArrowLeftRight, description: 'Buy and sell tokens on NEAR DEXs.', keywords: ['buy', 'sell', 'trade', 'exchange'] },
      // The Quick Trade ticket, opened over the current page (the trade drawer).
      {
        action: 'quick-trade',
        label: 'Quick Trade',
        icon: ChevronsRight,
        description: 'Buy or sell in one ticket, without leaving the page you are on.',
        keywords: ['ticket', 'fast', 'instant', 'buy', 'sell'],
      },
      {
        to: '/multi-trade',
        label: 'Multi Trade',
        icon: Layers,
        description: 'One buy or sell across many wallets, each leg reviewed before it runs.',
        keywords: ['multi buy', 'multi sell', 'bundle', 'wallets'],
      },
      {
        to: '/limit-orders',
        label: 'Limit Orders',
        icon: ListOrdered,
        description: 'Limit entries, take profit and stop loss.',
        keywords: ['orders', 'take profit', 'stop loss', 'tp', 'sl'],
      },
    ],
  },
  {
    label: 'Tools',
    items: [
      { to: '/split', label: 'Split', icon: Split, description: 'Send tokens from one wallet out to many, equally or by percentage.', keywords: ['distribute'] },
      { to: '/consolidate', label: 'Consolidate', icon: Merge, description: 'Gather a token from many wallets back into one.', keywords: ['gather', 'sweep', 'collect'] },
      {
        to: '/batch-send',
        label: 'Batch Send',
        icon: SendHorizontal,
        description: 'Send one token to many recipients from a single list.',
        keywords: ['send', 'airdrop', 'transfer', 'payroll', 'multisend'],
      },
      {
        to: '/wallets',
        label: 'Wallets & Presets',
        icon: Wallet,
        description: 'Your wallets, and the saved groups you trade them in.',
        keywords: ['groups', 'presets', 'accounts'],
      },
    ],
  },
  {
    label: 'Automation',
    items: [
      // Runs on NEARKITS's server: a real build without one can't offer it (the demo's console explains it).
      {
        to: '/volume-bot/console',
        label: 'Volume Bot',
        icon: Bot,
        description: 'Automated trading from NEARKITS wallets: market making, or TWAP accumulate and distribute.',
        soon: ENV.services === 'near' && !ENV.apiUrl,
        keywords: ['trading bot', 'market maker', 'market making', 'twap', 'accumulate', 'distribute', 'automation'],
      },
      { to: '/dca', label: 'DCA', icon: Repeat, description: 'Schedule recurring purchases.', keywords: ['recurring', 'schedule', 'dollar cost'] },
      { to: '/copy-trade', label: 'Copy Trade', icon: Copy, description: 'Copy another NEAR account’s swaps, within your own limits.', keywords: ['mirror', 'follow'] },
      { to: '/sniper', label: 'Sniper', icon: Crosshair, description: 'Discover and monitor new liquidity pools.', keywords: ['launch', 'snipe', 'new pools'] },
    ],
  },
  {
    label: 'Portfolio',
    items: [
      { to: '/positions', label: 'Positions', icon: Coins, description: 'Every token you hold, across all of your wallets.', keywords: ['holdings', 'balances', 'assets'] },
      {
        to: '/pnl',
        label: 'PnL',
        icon: ChartLine,
        description: 'Realized and unrealized profit and loss, for the period you pick.',
        keywords: ['profit', 'loss', 'performance', 'analytics'],
      },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      {
        to: '/scanner',
        label: 'Scanner',
        icon: ScanSearch,
        description: 'Contract facts and risk indicators for any NEAR token, never verdicts.',
        keywords: ['scan', 'contract', 'security', 'risk'],
      },
      {
        to: '/launch-radar',
        label: 'Launch Radar',
        icon: Radar,
        description: TOP_WALLETS_PAUSED
          ? 'New NEAR tokens as they launch: source, market, holders and risk evidence.'
          : 'New NEAR tokens as they launch: source, market, holders, risk evidence and tracked wallets.',
        keywords: ['launch', 'new tokens', 'launchpad', 'memecoin', 'new pools', 'discovery'],
      },
      {
        to: '/top-wallets',
        label: 'Top Wallets',
        icon: Trophy,
        description: 'NEAR wallets ranked by verifiable trading performance; follow them and see what they buy.',
        keywords: ['smart money', 'traders', 'wallet ranking', 'pnl', 'leaderboard', 'follow'],
      },
    ],
  },
  {
    label: 'Other',
    items: [
      { to: '/settings', label: 'Settings', icon: Settings, description: 'Slippage, confirmations and other preferences.', keywords: ['preferences', 'slippage'] },
      {
        to: '/docs',
        label: 'Documentation',
        icon: BookOpen,
        description: 'How NEARKITS works, its fees, and the terms used across the app.',
        keywords: ['docs', 'help', 'glossary', 'fees'],
      },
      {
        to: '/telegram',
        label: 'Telegram',
        icon: MessageSquare,
        description: 'Trade from Telegram with the NEARKITS bot, and buy alerts for groups.',
        soon: !TELEGRAM_BOT_LIVE,
        keywords: ['bot', 'link', 'buybot'],
      },
      // NearKit wallets, recovered with the owner wallet's signature: needs a NearKit server.
      ...(ENV.services === 'near' && ENV.apiUrl
        ? [
            {
              to: '/recover',
              label: 'Recover',
              icon: KeyRound,
              description: 'Export a NEARKITS wallet key or approve a withdrawal destination with your own wallet.',
              keywords: ['export', 'private key', 'backup', 'nearkit wallet', 'destination', 'approve'],
            },
          ]
        : []),
    ],
  },
]

/** Every page the navigation links to (in-place actions such as Quick Trade are not pages). */
export const ALL_NAV: NavItem[] = [NAV_HOME, ...NAV_GROUPS.flatMap((g) => g.items.filter((i): i is NavItem => !isNavAction(i))), NAV_ALL_TOOLS]

/** Pages the search box finds that the navigation lists elsewhere ($KITS has its own sidebar entry). */
export const SEARCH_ONLY_NAV: NavItem[] = [
  {
    to: '/kit',
    label: '$KITS',
    icon: Coins,
    description: 'The NEARKITS token: market, buyback and burn, and holder rewards.',
    keywords: ['kits', '$kits', 'near kits', 'nearkits token', 'tokenomics', 'buyback', 'burn'],
  },
]

/** Telegram-style commands the search box understands. */
export const COMMANDS: { command: string; to: string; label: string }[] = [
  { command: '/buy', to: '/swap', label: 'Buy a token' },
  { command: '/bridge', to: '/bridge', label: 'Bridge & Buy $KITS from SOL, ETH or BNB' },
  { command: '/sell', to: '/swap?side=sell', label: 'Sell a token' },
  { command: '/multi', to: '/multi-trade', label: 'Multi-wallet buy or sell' },
  { command: '/orders', to: '/limit-orders', label: 'Limit orders' },
  { command: '/split', to: '/split', label: 'Split tokens across wallets' },
  { command: '/consolidate', to: '/consolidate', label: 'Consolidate into one wallet' },
  { command: '/batch', to: '/batch-send', label: 'Batch send' },
  { command: '/wallets', to: '/wallets', label: 'Wallets and presets' },
  { command: '/positions', to: '/positions', label: 'Open positions' },
  { command: '/pnl', to: '/pnl', label: 'Profit and loss' },
  { command: '/dca', to: '/dca', label: 'DCA plans' },
  { command: '/copy', to: '/copy-trade', label: 'Copy trading rules' },
  { command: '/snipe', to: '/sniper', label: 'Sniper setup' },
  { command: '/scan', to: '/scanner', label: 'Scan a contract' },
  { command: '/volume', to: '/volume-bot/console', label: 'Volume Bot' },
  { command: '/tools', to: '/tools', label: 'All tools' },
]
