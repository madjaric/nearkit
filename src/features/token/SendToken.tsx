import { Send } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Button, type ButtonSize, type ButtonVariant } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Dialog'
import { formatAmount } from '@/lib/format'
import { canExecute, executesViaNearKit } from '@/lib/wallets'
import { useHoldings, useWallets } from '@/services/queries'
import type { Token, Wallet } from '@/types/domain'
import { NearKitSendModal } from '../wallets/nearkit'

/**
 * Send a token through the flow its wallet already has: a NearKit wallet's send (reviewed
 * here, checked and sent by NearKit's server), or Batch Send for an account of the connected
 * wallet. Only wallets that can send and hold the token are offered: never a
 * watch-only one. With several, the user picks which.
 */
export function SendTokenButton({
  token,
  label,
  size = 'md',
  variant = 'secondary',
  icon = true,
}: {
  token: Pick<Token, 'id' | 'symbol'>
  label: string
  size?: ButtonSize
  variant?: ButtonVariant
  icon?: boolean
}) {
  const navigate = useNavigate()
  const { data: wallets = [] } = useWallets()
  const { data: holdings = [] } = useHoldings()
  const [choosing, setChoosing] = useState(false)
  const [sendFrom, setSendFrom] = useState<Wallet | null>(null)
  const byId = new Map(wallets.map((w) => [w.id, w]))
  const senders = holdings.flatMap((h) => {
    const wallet = h.tokenId === token.id && h.amount > 0 ? byId.get(h.walletId) : undefined
    return wallet && canExecute(wallet) && !wallet.frozen ? [{ wallet, amount: h.amount }] : []
  })

  const sendFromWallet = (w: Wallet) => {
    setChoosing(false)
    if (executesViaNearKit(w)) setSendFrom(w)
    else navigate(`/batch-send?token=${encodeURIComponent(token.id)}&from=${encodeURIComponent(w.id)}`)
  }

  return (
    <>
      <Button
        size={size}
        variant={variant}
        icon={icon ? <Send size={size === 'xs' ? 12 : 14} /> : undefined}
        disabled={senders.length === 0}
        title={senders.length === 0 ? `None of your wallets that can send holds ${token.symbol}` : undefined}
        aria-label={`Send ${token.symbol}`}
        onClick={() => (senders.length === 1 && senders[0] ? sendFromWallet(senders[0].wallet) : setChoosing(true))}
      >
        {label}
      </Button>
      <Modal open={choosing} onClose={() => setChoosing(false)} size="sm" title={`Send ${token.symbol} from…`} description="Each wallet sends through its own flow.">
        <ul className="divide-y divide-line-soft rounded-sm border border-line">
          {senders.map(({ wallet, amount }) => (
            <li key={wallet.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="flex min-w-0 flex-col">
                <span className="text-sm text-fg">{wallet.label}</span>
                <span className="num text-xs text-fg-3">
                  {formatAmount(amount, 2)} {token.symbol} · {executesViaNearKit(wallet) ? 'sent by NearKit' : 'signed in your wallet'}
                </span>
              </span>
              <Button size="sm" variant="secondary" onClick={() => sendFromWallet(wallet)}>
                Send
              </Button>
            </li>
          ))}
        </ul>
      </Modal>
      <NearKitSendModal wallet={sendFrom} tokenId={token.id} onClose={() => setSendFrom(null)} />
    </>
  )
}
