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
  KeyRound,
  LayoutGrid,
  Layers,
  ListOrdered,
  Merge,
  MessageSquare,
  Repeat,
  Route,
  ScanSearch,
  SendHorizontal,
  Settings,
  Split,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import { ENV } from '@/config/env'
import { TELEGRAM_BOT_LIVE } from '@/config/release'

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  /** Words the command search also matches. */
  keywords?: string[]
  /** A line under the label (sidebar and search) where two entries need telling apart. */
  hint?: string
  soon?: boolean
  end?: boolean
}

/** An entry that opens something in place instead of a page. */
export interface NavAction {
  action: 'quick-trade'
  label: string
  icon: LucideIcon
}

export const isNavAction = (entry: NavItem | NavAction): entry is NavAction => 'action' in entry

export interface NavGroup {
  label: string
  items: (NavItem | NavAction)[]
}

export const NAV_HOME: NavItem = { to: '/', label: 'Dashboard', icon: LayoutGrid, end: true, keywords: ['home', 'overview', 'terminal'] }

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Trade',
    items: [
      { to: '/swap', label: 'Swap', icon: ArrowLeftRight, keywords: ['buy', 'sell', 'trade', 'exchange'] },
      // The Quick Trade ticket, opened over the current page (the trade drawer).
      { action: 'quick-trade', label: 'Quick Trade', icon: ChevronsRight },
      // SOL, ETH or BNB → NEAR (NEAR Intents), to fund NEARKITS wallets; nothing is bought. NEAR mainnet with NEARKITS' server; the demo previews it.
      {
        to: '/bridge-near',
        label: 'Bridge',
        icon: ArrowDownToLine,
        hint: 'Move assets from other chains into NEAR.',
        soon: ENV.services === 'near' && (ENV.network !== 'mainnet' || !ENV.apiUrl),
        keywords: ['bridge', 'deposit', 'fund', 'top up', 'gas', 'solana', 'sol', 'ethereum', 'eth', 'bnb', 'cross-chain', 'near intents'],
      },
      // SOL, ETH or BNB → NEAR (NEAR Intents) → $KITS. NEAR mainnet with NEARKITS' server; the demo previews it.
      {
        to: '/bridge',
        label: 'Bridge & Buy',
        icon: Route,
        hint: 'Bridge your assets and automatically buy $KITS.',
        soon: ENV.services === 'near' && (ENV.network !== 'mainnet' || !ENV.apiUrl),
        keywords: ['bridge', 'buy kits', 'solana', 'sol', 'ethereum', 'eth', 'bnb', 'cross-chain', 'near intents', 'deposit'],
      },
      { to: '/multi-trade', label: 'Multi Trade', icon: Layers, keywords: ['multi buy', 'multi sell', 'bundle', 'wallets'] },
      { to: '/limit-orders', label: 'Limit Orders', icon: ListOrdered, keywords: ['orders', 'take profit', 'stop loss', 'tp', 'sl'] },
    ],
  },
  {
    label: 'Tools',
    items: [
      { to: '/split', label: 'Split', icon: Split, keywords: ['distribute'] },
      { to: '/consolidate', label: 'Consolidate', icon: Merge, keywords: ['gather', 'sweep', 'collect'] },
      { to: '/batch-send', label: 'Batch Send', icon: SendHorizontal, keywords: ['airdrop', 'transfer', 'payroll', 'multisend'] },
      { to: '/wallets', label: 'Wallets & Presets', icon: Wallet, keywords: ['groups', 'presets', 'accounts'] },
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
        soon: ENV.services === 'near' && !ENV.apiUrl,
        keywords: ['trading bot', 'market maker', 'market making', 'twap', 'accumulate', 'distribute', 'automation'],
      },
      { to: '/dca', label: 'DCA', icon: Repeat, keywords: ['recurring', 'schedule', 'dollar cost'] },
      { to: '/copy-trade', label: 'Copy Trade', icon: Copy, keywords: ['mirror', 'follow'] },
      { to: '/sniper', label: 'Sniper', icon: Crosshair, keywords: ['launch', 'snipe'] },
    ],
  },
  {
    label: 'Portfolio',
    items: [
      { to: '/positions', label: 'Positions', icon: Coins, keywords: ['holdings', 'balances'] },
      { to: '/pnl', label: 'PnL', icon: ChartLine, keywords: ['profit', 'loss', 'performance', 'analytics'] },
    ],
  },
  {
    label: 'Intelligence',
    items: [{ to: '/scanner', label: 'Scanner', icon: ScanSearch, keywords: ['scan', 'contract', 'security', 'risk'] }],
  },
]

export const NAV_FOOTER: NavItem[] = [
  { to: '/settings', label: 'Settings', icon: Settings, keywords: ['preferences', 'slippage'] },
  { to: '/docs', label: 'Documentation', icon: BookOpen, keywords: ['docs', 'help', 'glossary', 'fees'] },
  { to: '/telegram', label: 'Telegram', icon: MessageSquare, soon: !TELEGRAM_BOT_LIVE, keywords: ['bot', 'link', 'buybot'] },
  // NearKit wallets, recovered with the owner wallet's signature: needs a NearKit server.
  ...(ENV.services === 'near' && ENV.apiUrl
    ? [{ to: '/recover', label: 'Recover', icon: KeyRound, keywords: ['export', 'private key', 'backup', 'nearkit wallet', 'destination', 'approve'] }]
    : []),
]

/** Every page the navigation links to (in-place actions such as Quick Trade are not pages). */
export const ALL_NAV: NavItem[] = [NAV_HOME, ...NAV_GROUPS.flatMap((g) => g.items.filter((i): i is NavItem => !isNavAction(i))), ...NAV_FOOTER]

/** Pages the search box finds that the navigation lists elsewhere ($KITS has its own sidebar entry). */
export const SEARCH_ONLY_NAV: NavItem[] = [{ to: '/kit', label: '$KITS', icon: Coins, keywords: ['kits', '$kits', 'near kits', 'nearkits token', 'tokenomics', 'buyback', 'burn'] }]

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
]
