import type { ComponentType } from 'react'
import { createBrowserRouter } from 'react-router'
import { AppShell } from '@/layouts/AppShell'
import NotFoundPage, { BootScreen, RouteError } from '@/pages/system'

/** Each screen is its own chunk; the shell stays mounted while the next one loads. */
const page = (load: () => Promise<{ default: ComponentType }>) => async () => ({ Component: (await load()).default })

export const router = createBrowserRouter([
  {
    element: <AppShell />,
    hydrateFallbackElement: <BootScreen />,
    children: [
      {
        errorElement: <RouteError />,
        children: [
          { index: true, lazy: page(() => import('@/pages/DashboardPage')) },
          { path: 'swap', lazy: page(() => import('@/pages/SwapPage')) },
          { path: 'multi-trade', lazy: page(() => import('@/pages/MultiTradePage')) },
          { path: 'limit-orders', lazy: page(() => import('@/pages/LimitOrdersPage')) },
          { path: 'split', lazy: page(() => import('@/pages/SplitPage')) },
          { path: 'consolidate', lazy: page(() => import('@/pages/ConsolidatePage')) },
          { path: 'batch-send', lazy: page(() => import('@/pages/BatchSendPage')) },
          { path: 'wallets', lazy: page(() => import('@/pages/WalletsPage')) },
          { path: 'dca', lazy: page(() => import('@/pages/DcaPage')) },
          { path: 'copy-trade', lazy: page(() => import('@/pages/CopyTradePage')) },
          { path: 'sniper', lazy: page(() => import('@/pages/SniperPage')) },
          { path: 'positions', lazy: page(() => import('@/pages/PositionsPage')) },
          { path: 'pnl', lazy: page(() => import('@/pages/PnlPage')) },
          { path: 'scanner', lazy: page(() => import('@/pages/ScannerPage')) },
          { path: 'kit', lazy: page(() => import('@/pages/KitPage')) },
          { path: 'telegram', lazy: page(() => import('@/pages/TelegramPage')) },
          { path: 'recover', lazy: page(() => import('@/pages/RecoverPage')) },
          { path: 'settings', lazy: page(() => import('@/pages/SettingsPage')) },
          { path: 'docs', lazy: page(() => import('@/pages/DocsPage')) },
          // Already in the main chunk for the boot and error screens.
          { path: '*', Component: NotFoundPage },
        ],
      },
    ],
  },
])
