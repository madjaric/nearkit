import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Dialog'
import { Figures } from '@/components/ui/Figures'
import { Led, Skeleton, Tag } from '@/components/ui/Indicators'
import { useToast } from '@/components/ui/toast-context'
import { cn } from '@/lib/cn'
import { describeError, type ErrorView } from '@/services/errors'
import { useCapabilities, useConnect, useWalletOptions } from '@/services/queries'
import type { WalletOption } from '@/services/types'
import type { Session } from '@/types/domain'
import { ConnectContext } from './contexts'

function DemoBody() {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-fg-2">Continue with the demo account to explore NearKit with sample balances. Nothing you do is signed or sent.</p>
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
        <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-[3px] border border-line bg-raised font-mono text-xs font-semibold text-fg-2">
          {option.name.slice(0, 1)}
        </span>
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

function NearBody({ open, pendingId, error, onPick }: { open: boolean; pendingId: string | null; error: ErrorView | null; onPick: (id: string) => void }) {
  const caps = useCapabilities()
  const options = useWalletOptions(open)
  const list = options.data ?? []

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-fg-3">Network</span>
        <Tag tone={caps.network === 'mainnet' ? 'warn' : 'neutral'}>{caps.networkLabel}</Tag>
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

      <p className="text-xs text-fg-3">You sign in your wallet. NearKit never asks for a seed phrase or private key and never holds your funds.</p>
    </div>
  )
}

/**
 * Wallet connection. Real mode lists the wallets NEAR Connect offers for this
 * network; the demo keeps its single simulated account.
 */
export function ConnectProvider({ children }: { children: ReactNode }) {
  const caps = useCapabilities()
  const [open, setOpen] = useState(false)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [error, setError] = useState<ErrorView | null>(null)
  const connect = useConnect()
  const toast = useToast()
  const promptConnect = useCallback(() => {
    setError(null)
    setOpen(true)
  }, [])
  const api = useMemo(() => ({ promptConnect }), [promptConnect])
  const demo = caps.mode === 'demo'

  const announce = (session: Session) => {
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
    } else {
      toast.push({ tone: 'accent', title: 'Wallet connected', detail: `${session.accountId} via ${session.walletName ?? 'your wallet'} on ${caps.networkLabel.toLowerCase()}.` })
    }
  }

  const pick = (walletId?: string) => {
    setError(null)
    setPendingId(walletId ?? 'demo')
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
        dismissible={!connect.isPending}
        size="sm"
        title="Connect a wallet"
        description={demo ? 'The demo runs on sample data.' : `Choose a wallet for NEAR ${caps.networkLabel.toLowerCase()}.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={connect.isPending && demo}>
              {connect.isPending && !demo ? 'Close' : 'Cancel'}
            </Button>
            {demo && (
              <Button variant="primary" loading={connect.isPending} onClick={() => pick()}>
                Use demo account
              </Button>
            )}
          </>
        }
      >
        {demo ? <DemoBody /> : <NearBody open={open} pendingId={pendingId} error={error} onPick={(id) => pick(id)} />}
      </Modal>
    </ConnectContext.Provider>
  )
}
