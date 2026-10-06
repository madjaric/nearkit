import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { WalletReturned } from '@/components/domain/WalletReturned'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Dialog'
import { Figures } from '@/components/ui/Figures'
import { Led, Skeleton, Tag } from '@/components/ui/Indicators'
import { useToast } from '@/components/ui/toast-context'
import { cn } from '@/lib/cn'
import { isImageSource } from '@/lib/imageSource'
import { ownerControlProblem, type OwnerControl, type OwnerRefusal } from '@/lib/ownerAccount'
import { describeError, type ErrorView } from '@/services/errors'
import { useCapabilities, useConnect, useReconnectAs, useWalletOptions } from '@/services/queries'
import type { WalletOption } from '@/services/types'
import type { Session, WalletAccountDetail } from '@/types/domain'
import { ConnectContext } from './contexts'

function DemoBody() {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-fg-2">Continue with the demo account to explore NEARKITS with sample balances. Nothing you do is signed or sent.</p>
      <ul className="flex flex-col divide-y divide-line-soft rounded-sm border border-line">
        <li className="flex items-center gap-3 px-3 py-2.5">
          <Led tone="on" />
          <span className="flex-1">
            <span className="block text-sm text-fg">Demo account</span>
            <span className="block text-xs text-fg-3">Sample balances across 12 wallets</span>
          </span>
          <span className="text-xs text-fg-3">Available</span>
        </li>
      </ul>
    </div>
  )
}

/**
 * The provider's own icon from the pinned wallet manifest (or its extension), on a tile that keeps
 * every icon the same size on the dark UI; its first letter when there is none or it fails to load.
 */
function WalletIcon({ option }: { option: WalletOption }) {
  const [failed, setFailed] = useState(false)
  const src = !failed && isImageSource(option.icon) ? option.icon : null
  return (
    <span
      aria-hidden="true"
      className="grid size-7 shrink-0 place-items-center overflow-hidden rounded-[3px] border border-line bg-raised font-mono text-xs font-semibold text-fg-2"
    >
      {src ? (
        <img
          src={src}
          alt=""
          width={28}
          height={28}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setFailed(true)}
          className="size-full object-contain"
        />
      ) : (
        option.name.slice(0, 1)
      )}
    </span>
  )
}

function WalletRow({ option, pending, disabled, onPick }: { option: WalletOption; pending: boolean; disabled: boolean; onPick: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        disabled={disabled}
        aria-busy={pending || undefined}
        className={cn(
          'flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors',
          'hover:bg-raised focus-visible:bg-raised disabled:cursor-not-allowed',
          disabled && !pending && 'opacity-45',
        )}
      >
        <WalletIcon option={option} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm text-fg">{option.name}</span>
            {option.injected && <Tag tone="neutral">Extension</Tag>}
          </span>
          {option.description && <span className="block truncate text-xs text-fg-3">{option.description}</span>}
        </span>
        <span className="shrink-0 text-xs text-fg-3">{pending ? 'Waiting for wallet…' : 'Connect'}</span>
      </button>
    </li>
  )
}

function NearBody({
  open,
  pendingId,
  error,
  mismatch,
  onPick,
}: {
  open: boolean
  pendingId: string | null
  error: ErrorView | null
  /** "Connect <owner>": the wallet can't sign for the owner (and why), with what it returned. */
  mismatch: { check: OwnerRefusal; owner: string; nearkitWallet: string | undefined; details: WalletAccountDetail[] | undefined } | null
  onPick: (id: string) => void
}) {
  const caps = useCapabilities()
  const options = useWalletOptions(open)
  const list = options.data ?? []

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-fg-3">Network</span>
        <Tag tone="neutral">{caps.networkLabel}</Tag>
      </div>
      {caps.network === 'mainnet' && !caps.execution.enabled && (
        <p className="rounded-sm border border-line px-3 py-2 text-xs text-fg-2">
          <Figures>{caps.execution.reason ?? 'Mainnet execution is disabled in this build.'}</Figures>
        </p>
      )}

      {options.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading wallets">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : options.isError ? (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-sm border border-neg/40 bg-neg/10 px-3 py-2">
          <span className="text-sm text-neg">{describeError(options.error).message}</span>
          <Button size="xs" variant="secondary" onClick={() => void options.refetch()}>
            Retry
          </Button>
        </div>
      ) : list.length === 0 ? (
        <p className="rounded-sm border border-line px-3 py-3 text-sm text-fg-2">No wallet supports {caps.networkLabel.toLowerCase()} right now. Try again later.</p>
      ) : (
        <ul className="flex max-h-72 flex-col divide-y divide-line-soft overflow-y-auto rounded-sm border border-line" aria-label="Wallets">
          {list.map((o) => (
            <WalletRow key={o.id} option={o} pending={pendingId === o.id} disabled={pendingId !== null} onPick={() => onPick(o.id)} />
          ))}
        </ul>
      )}

      {mismatch && (
        <div role="alert" className="rounded-sm border border-neg/40 bg-neg/10 px-3 py-2">
          <p className="break-words text-sm text-neg">{ownerControlProblem(mismatch.check, mismatch.owner, mismatch.nearkitWallet)}</p>
          <WalletReturned details={mismatch.details} />
        </div>
      )}

      {error && (
        <div role="alert" className="rounded-sm border border-neg/40 bg-neg/10 px-3 py-2">
          <p className="text-sm text-neg">
            <Figures>{error.code === 'USER_REJECTED' ? 'You closed or rejected the request in the wallet. Pick a wallet to try again.' : error.message}</Figures>
          </p>
          {error.detail && error.code !== 'USER_REJECTED' && (
            <details className="mt-1">
              <summary className="cursor-pointer text-[11px] text-fg-3 hover:text-fg-2">Technical details</summary>
              <pre className="num mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-xs bg-well px-2 py-1.5 text-[11px] leading-4 text-fg-3">{error.detail}</pre>
            </details>
          )}
        </div>
      )}

      <p className="text-xs text-fg-3">You sign in your wallet. NEARKITS never asks for a seed phrase or private key and never holds your funds.</p>
    </div>
  )
}

/**
 * Wallet connection. Real mode lists the wallets NEAR Connect offers for this
 * network; the demo keeps its single simulated account. "Connect <owner>" (Recover)
 * must end on that exact NEAR account: it signs the wallet out first so the wallet can
 * show its account picker, and says which account came back when it isn't the owner.
 */
export function ConnectProvider({ children }: { children: ReactNode }) {
  const caps = useCapabilities()
  const [open, setOpen] = useState(false)
  /** The NEAR account this connect must end on, or null for any account. */
  const [owner, setOwner] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [error, setError] = useState<ErrorView | null>(null)
  /** The NearKit wallet a "Connect <owner>" is about, if any (Recover's export or approval). */
  const [nearkitWallet, setNearkitWallet] = useState<string | undefined>(undefined)
  const [mismatch, setMismatch] = useState<{ check: OwnerRefusal; details: WalletAccountDetail[] | undefined } | null>(null)
  const connect = useConnect()
  const reconnect = useReconnectAs()
  const toast = useToast()
  const show = useCallback((account: string | null) => {
    setOwner(account)
    setError(null)
    setMismatch(null)
    setOpen(true)
  }, [])
  const promptConnect = useCallback(() => show(null), [show])
  const connectOwner = useCallback(
    (account: string, wallet?: string) => {
      setNearkitWallet(wallet)
      show(account)
    },
    [show],
  )
  const api = useMemo(() => ({ promptConnect, connectOwner }), [promptConnect, connectOwner])
  const demo = caps.mode === 'demo'
  const pending = connect.isPending || reconnect.isPending

  /** `byKey`: a "Connect <owner>" that ended on an account signing with a full-access key of the owner (it stays that account). */
  const announce = (session: Session, byKey?: { owner: string; control: Extract<OwnerControl, { via: 'key' }> }) => {
    if (session.issue === 'network-mismatch') {
      toast.push({
        tone: 'neg',
        title: 'Wrong network',
        detail: `${session.accountId} belongs to the other network. Nothing can be signed until you connect a ${caps.networkLabel.toLowerCase()} account.`,
      })
    } else if (session.issue === 'account-missing') {
      toast.push({ tone: 'neg', title: 'Account not found', detail: `${session.accountId} does not exist on ${caps.networkLabel.toLowerCase()} yet. Fund it before trading.` })
    } else if (session.mode === 'demo') {
      toast.push({ tone: 'accent', title: 'Demo account connected', detail: `${session.accountId} with sample balances across 12 wallets.` })
    } else if (byKey) {
      toast.push({
        tone: 'accent',
        title: 'Wallet connected',
        detail: `${session.accountId} via ${session.walletName ?? 'your wallet'} on ${caps.networkLabel.toLowerCase()}. It signs with a full-access key of ${byKey.owner}, so it can sign ${byKey.owner}’s requests.`,
      })
    } else {
      toast.push({ tone: 'accent', title: 'Wallet connected', detail: `${session.accountId} via ${session.walletName ?? 'your wallet'} on ${caps.networkLabel.toLowerCase()}.` })
    }
  }

  const pick = (walletId?: string) => {
    setError(null)
    setMismatch(null)
    setPendingId(walletId ?? 'demo')
    if (owner && walletId && !demo) {
      reconnect.mutate(
        { walletId, owner },
        {
          onSuccess: (r) => {
            // Not the owner: no "Wallet connected", the window stays open and says what came back.
            if (!r.ok) return setMismatch({ check: r.mismatch, details: r.session?.walletDetails })
            setOpen(false)
            announce(r.session, r.control.via === 'key' ? { owner, control: r.control } : undefined)
          },
          onError: (e) => setError(describeError(e)),
          onSettled: () => setPendingId(null),
        },
      )
      return
    }
    connect.mutate(walletId, {
      onSuccess: (session) => {
        setOpen(false)
        announce(session)
      },
      onError: (e) => setError(describeError(e)),
      onSettled: () => setPendingId(null),
    })
  }

  return (
    <ConnectContext.Provider value={api}>
      {children}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        dismissible={!pending}
        size="sm"
        title={owner && !demo ? `Connect ${owner}` : 'Connect a wallet'}
        description={
          demo
            ? 'The demo runs on sample data.'
            : owner
              ? `NEARKITS signs your wallet out first, so it can show its account picker: choose ${owner} there.`
              : `Choose a wallet for NEAR ${caps.networkLabel.toLowerCase()}.`
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={connect.isPending && demo}>
              {pending && !demo ? 'Close' : 'Cancel'}
            </Button>
            {demo && (
              <Button variant="primary" loading={connect.isPending} onClick={() => pick()}>
                Use demo account
              </Button>
            )}
          </>
        }
      >
        {demo ? (
          <DemoBody />
        ) : (
          <NearBody open={open} pendingId={pendingId} error={error} mismatch={mismatch && owner ? { ...mismatch, owner, nearkitWallet } : null} onPick={(id) => pick(id)} />
        )}
      </Modal>
    </ConnectContext.Provider>
  )
}
