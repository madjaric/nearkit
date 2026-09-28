import {
  ArrowLeftRight,
  BookOpen,
  ChartLine,
  ChevronsRight,
  Coins,
  Copy,
  Crosshair,
  LayoutGrid,
  Layers,
  ListOrdered,
  Merge,
  MessageSquare,
  Repeat,
  ScanSearch,
  SendHorizontal,
  Settings,
  Split,
  Wallet,
  type LucideIcon,
} from 'lucide-react'

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
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
  { to: '/telegram', label: 'Telegram', icon: MessageSquare, soon: true, keywords: ['bot'] },
]

/** Every page the navigation links to (in-place actions such as Quick Trade are not pages). */
export const ALL_NAV: NavItem[] = [NAV_HOME, ...NAV_GROUPS.flatMap((g) => g.items.filter((i): i is NavItem => !isNavAction(i))), ...NAV_FOOTER]

/** Telegram-style commands the search box understands. */
export const COMMANDS: { command: string; to: string; label: string }[] = [
  { command: '/buy', to: '/swap', label: 'Buy a token' },
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
]
