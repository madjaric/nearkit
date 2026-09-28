import type { CSSProperties, ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Figures } from '@/components/ui/Figures'
import { Skeleton } from '@/components/ui/Indicators'
import { Panel } from '@/components/ui/Panel'
import { cn } from '@/lib/cn'
import { usePageTitle } from '@/lib/hooks'
import { useCapabilities, useSession } from '@/services/queries'
import { useConnectPrompt } from '@/state/contexts'

interface PageHeaderProps {
  title: string
  description?: ReactNode
  actions?: ReactNode
  /** Short status printed beside the title (e.g. execution state). */
  status?: ReactNode
}

/** Title set wide like a panel name, one line of purpose, actions on the right. */
export function PageHeader({ title, description, actions, status }: PageHeaderProps) {
  usePageTitle(title)
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="text-lg font-[650] leading-7 text-fg" style={{ fontStretch: '110%' }}>
            {title}
          </h1>
          {status}
        </div>
        {description && (
          <p className="mt-0.5 max-w-[70ch] text-sm text-fg-3">
            <Figures>{description}</Figures>
          </p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}

interface PageGridProps {
  children: ReactNode
  aside?: ReactNode
  asideWidth?: number
  /** On narrow screens the aside comes first (forms that drive the page). */
  asideFirst?: boolean
  stickyAside?: boolean
  className?: string
}

/** Main column plus an optional right context column from 1280px; stacked below that. */
export function PageGrid({ children, aside, asideWidth = 360, asideFirst = false, stickyAside = false, className }: PageGridProps) {
  return (
    <div
      className={cn('grid grid-cols-1 items-start gap-4', aside ? 'xl:grid-cols-[minmax(0,1fr)_var(--aside-w)]' : undefined, className)}
      style={{ '--aside-w': `${asideWidth}px` } as CSSProperties}
    >
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
      {aside && <aside className={cn('flex min-w-0 flex-col gap-4', asideFirst && 'order-first xl:order-none', stickyAside && 'xl:sticky xl:top-16')}>{aside}</aside>}
    </div>
  )
}

/** Page body wrapper: consistent gutters and vertical rhythm on every route. */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-col gap-4 px-4 pb-8 pt-4 lg:px-6', className)}>{children}</div>
}

/** Gate for wallet-bound tools. Disconnected users get a clear way back in. */
export function RequireWallet({ feature, children }: { feature: string; children: ReactNode }) {
  const caps = useCapabilities()
  const { data: session, isPending } = useSession()
  const { promptConnect } = useConnectPrompt()
  if (isPending)
    return (
      <Panel className="p-5">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="mt-3 h-4 w-72" />
        <Skeleton className="mt-6 h-32 w-full" />
      </Panel>
    )
  if (!session)
    return (
      <Panel>
        <EmptyState
          title={`Connect a wallet to use ${feature}`}
          action={
            <Button variant="primary" onClick={promptConnect}>
              Connect wallet
            </Button>
          }
        >
          {caps.mode === 'demo'
            ? `${feature} works across your NearKit wallets. The demo runs on a sample account.`
            : `${feature} works across the accounts you connect. You sign in your wallet; NearKit never sees your keys.`}
        </EmptyState>
      </Panel>
    )
  return <>{children}</>
}
