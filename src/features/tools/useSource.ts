import { useState } from 'react'
import { signsInBrowser } from '@/lib/wallets'
import { useSession, useWallets } from '@/services/queries'

/**
 * Source-wallet selection shared by the transfer tools. Only accounts that can
 * sign in the current wallet session are offered as sources: a NearKit wallet
 * sends through Telegram (its own Send), and watch-only accounts can receive
 * but never send. Defaults to the connected account.
 */
export function useSourceWallet(initial: string | null = null) {
  const { data: session } = useSession()
  const { data: wallets = [] } = useWallets()
  const signers = wallets.filter(signsInBrowser)
  // A preselected source (a token screen's Send) counts only if it can sign here.
  const [picked, setPicked] = useState<string | null>(initial)
  const fallback = session?.walletId && signers.some((w) => w.id === session.walletId) ? session.walletId : (signers[0]?.id ?? '')
  const sourceId = picked && signers.some((w) => w.id === picked) ? picked : fallback
  return { sourceId, setSourceId: setPicked, signers, wallets, source: wallets.find((w) => w.id === sourceId) }
}
