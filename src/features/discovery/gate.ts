import { TOP_WALLETS_PAUSED } from '@/config/paused'

/**
 * What the router opens for Top Wallets (paused.ts): while it is paused, both its list and a wallet's
 * page open the Coming Soon screen, and the ranking pages' code is never loaded.
 */
export const loadTopWallets = () => (TOP_WALLETS_PAUSED ? import('@/pages/TopWalletsSoonPage') : import('@/pages/TopWalletsPage'))
export const loadWalletDetail = () => (TOP_WALLETS_PAUSED ? import('@/pages/TopWalletsSoonPage') : import('@/pages/WalletDetailPage'))
