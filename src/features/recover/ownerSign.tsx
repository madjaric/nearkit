import { WalletReturned } from '@/components/domain/WalletReturned'
import { Button } from '@/components/ui/Button'
import { ownerControlProblem, ownerKeyNote } from '@/lib/ownerAccount'
import { useOwnerControl, useSession } from '@/services/queries'
import { useConnectPrompt } from '@/state/contexts'

/**
 * Owner signatures for NearKit's signer-written requests (Recover's export and approvals, Send's
 * "Approve & continue"): the message is checked before the wallet signs it, the wallet must be able
 * to sign for the owner (the owner account itself, or a full-access key of it), and the key that
 * signed is checked again (walletService.signMessage). The signer decides.
 */

export function OwnerMessage({ text }: { text: string }) {
  return (
    <div>
      <p className="mb-1.5 text-2xs uppercase tracking-legend text-fg-3">Your wallet will sign</p>
      <pre className="num whitespace-pre-wrap break-words rounded-sm border border-line-soft bg-well px-3 py-2 text-xs leading-5 text-fg-2">{text}</pre>
    </div>
  )
}

/**
 * Connect the owner wallet, or sign with it once it can sign for the owner: the owner account
 * itself, or an account whose key is a full-access key of the owner on chain (said plainly; the key
 * that signs is checked again after). Connect signs the current wallet session out first, so the
 * wallet can show its account picker. `wallet`: the NearKit wallet this request is about.
 */
export function OwnerSignButton({ owner, wallet, label, pending, onSign }: { owner: string; wallet?: string; label: string; pending: boolean; onSign: () => void }) {
  const { data: session } = useSession()
  const { connectOwner } = useConnectPrompt()
  const control = useOwnerControl(owner, session ?? null)
  const connect = (
    <Button variant="primary" size="lg" block onClick={() => connectOwner(owner, wallet)}>
      Connect {owner}
    </Button>
  )
  if (!session) return connect
  if (control.isPending)
    return (
      <Button variant="primary" size="lg" block loading disabled>
        Checking your wallet
      </Button>
    )
  const c = control.data
  if (!c?.ok)
    return (
      <>
        {c && c.reason !== 'none' && (
          <div>
            <p className="break-words text-sm text-fg-2">{ownerControlProblem(c, owner, wallet)}</p>
            <WalletReturned details={session.walletDetails} />
          </div>
        )}
        {c?.reason === 'unchecked' && (
          <Button variant="secondary" size="lg" block onClick={() => void control.refetch()}>
            Check again
          </Button>
        )}
        {connect}
      </>
    )
  return (
    <>
      {c.via === 'key' && <p className="break-words text-sm text-fg-2">{ownerKeyNote(c, owner)}</p>}
      <Button variant="primary" size="lg" block loading={pending} disabled={pending} onClick={onSign}>
        {label}
      </Button>
    </>
  )
}
