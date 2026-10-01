import { executesViaNearKit, signsInBrowser } from '@/lib/wallets'
import { useSession, useWallets } from '@/services/queries'

/**
 * The wallets a trade ticket trades from, and how each one executes:
 * - a NearKit wallet: NearKit's server executes it with that wallet's own key (no wallet prompt,
 *   no browser wallet needed);
 * - an account of the connected wallet: signed in that wallet, as before.
 * Watch-only and frozen wallets are never offered. Defaults to the connected account, else the
 * first NearKit wallet.
 */
export function useTradeWallets(picked: string | null) {
  const { data: session } = useSession()
  const { data: wallets = [] } = useWallets()
  const nearkit = wallets.filter((w) => executesViaNearKit(w) && !w.frozen)
  const browser = wallets.filter(signsInBrowser)
  const options = [...nearkit, ...browser]
  const fallback = session && browser.some((w) => w.id === session.walletId) ? session.walletId : (nearkit[0]?.id ?? browser[0]?.id ?? '')
  const walletId = picked && options.some((w) => w.id === picked) ? picked : fallback
  const wallet = options.find((w) => w.id === walletId) ?? null
  const viaNearKit = wallet !== null && executesViaNearKit(wallet)
  return {
    walletId,
    wallet,
    /** NearKit's server executes trades from this wallet. */
    viaNearKit,
    /** The ticket can quote and trade: a NearKit wallet, or a connected one. */
    ready: viaNearKit || Boolean(session),
    nearkit,
    browser,
    options,
  }
}
