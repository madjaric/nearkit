import type { CSSProperties, ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Figures } from '@/components/ui/Figures'
import { ComingSoon, Skeleton } from '@/components/ui/Indicators'
import { Panel } from '@/components/ui/Panel'
import { cn } from '@/lib/cn'
import { usePageTitle } from '@/lib/hooks'
import { useComingSoonPage } from '@/lib/modeCopy'
import { WEB_SIGN_IN_URL } from '@/lib/telegramLinks'
import { useServices } from '@/services/context'
import { useCapabilities, useNearKitSession, useSession } from '@/services/queries'
import { ComingSoonContext, useConnectPrompt } from '@/state/contexts'

interface PageHeaderProps {
  title: string
  description?: ReactNode
  actions?: ReactNode
  /** Short status printed beside the title (e.g. execution state). */
  status?: ReactNode
}

/**
 * Title set wide like a panel name, one line of purpose, actions on the right.
 * On a page the public beta marks COMING SOON, the status says so and a notice follows.
 */
export function PageHeader({ title, description, actions, status }: PageHeaderProps) {
  usePageTitle(title)
  const soon = useComingSoonPage()
  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-lg font-[650] leading-7 text-fg" style={{ fontStretch: '110%' }}>
              {title}
            </h1>
            {soon ? <ComingSoon /> : status}
          </div>
          {description && (
            <p className="mt-0.5 max-w-[70ch] text-sm text-fg-3">
              <Figures>{description}</Figures>
            </p>
          )}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {soon && (
        <p className="rounded-md border border-dashed border-line-strong px-4 py-3 text-sm text-fg-2">
          {title} is not part of the public beta yet. You can look around, but nothing on this page can be signed, sent or saved.
        </p>
      )}
    </>
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

/**
 * Gate for wallet-bound tools. Disconnected users get a clear way back in. On a
 * COMING SOON page the tool renders read-only: every field and key is disabled.
 */
/**
 * The page needs a wallet: one connected in this browser, or (`nearkit`) a NearKit web session,
 * whose NearKit wallets trade and send through Telegram.
 */
export function RequireWallet({ feature, children, nearkit = false }: { feature: string; children: ReactNode; nearkit?: boolean }) {
  const caps = useCapabilities()
  const soon = useComingSoonPage()
  const { data: session, isPending } = useSession()
  const { promptConnect } = useConnectPrompt()
  const services = useServices()
  const nearkitSession = useNearKitSession()
  const telegram = nearkit && services.nearkit.available
  if (telegram && nearkitSession && !soon) return <>{children}</>
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
          title={soon ? `${feature} is coming soon` : telegram ? `Connect a wallet or sign in with Telegram to use ${feature}` : `Connect a wallet to use ${feature}`}
          action={
            <span className="flex flex-wrap items-center justify-center gap-2">
              <Button variant={soon ? 'secondary' : 'primary'} onClick={promptConnect}>
                Connect wallet
              </Button>
              {telegram && !soon && WEB_SIGN_IN_URL && (
                <a href={WEB_SIGN_IN_URL} target="_blank" rel="noreferrer noopener" className="inline-flex">
                  <Button variant="secondary" tabIndex={-1}>
                    Sign in with Telegram
                  </Button>
                </a>
              )}
            </span>
          }
        >
          {soon
            ? 'Connect a wallet to preview the page. Nothing on it can be signed, sent or saved during the beta.'
            : caps.mode === 'demo'
              ? `${feature} works across your NearKit wallets. The demo runs on a sample account.`
              : telegram
                ? `${feature} works across the accounts you connect, which sign in your wallet, and your NearKit wallets, which NearKit executes: the NearKit bot’s /web sends a one-time sign-in link.`
                : `${feature} works across the accounts you connect. You sign in your wallet; NearKit never sees your keys.`}
        </EmptyState>
      </Panel>
    )
  if (soon)
    return (
      <ComingSoonContext.Provider value={true}>
        <fieldset disabled aria-label={`${feature}, coming soon: read-only`} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
          {children}
        </fieldset>
      </ComingSoonContext.Provider>
    )
  return <>{children}</>
}
