import { useState } from 'react'
import { tradeWalletPool } from '@/lib/wallets'
import { useSession, useWallets } from '@/services/queries'

/**
 * Source-wallet selection shared by the transfer tools (Split, Batch Send): every wallet a send can
 * start from. NearKit wallets (not frozen) send through NearKit's server, line by line, under the
 * custody rule (NearKitSendsModal); the connected wallet's accounts sign here. Watch-only accounts
 * can receive but never send, so they are never offered. Defaults to the connected account.
 */
export function useSourceWallet(initial: string | null = null) {
  const { data: session } = useSession()
  const { data: wallets = [] } = useWallets()
  const signers = tradeWalletPool(wallets).options
  // A preselected source (a token screen's Send) counts only if it can sign here.
  const [picked, setPicked] = useState<string | null>(initial)
  const fallback = session?.walletId && signers.some((w) => w.id === session.walletId) ? session.walletId : (signers[0]?.id ?? '')
  const sourceId = picked && signers.some((w) => w.id === picked) ? picked : fallback
  return { sourceId, setSourceId: setPicked, signers, wallets, source: wallets.find((w) => w.id === sourceId) }
}
