import type { CSSProperties, ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Figures } from '@/components/ui/Figures'
import { ComingSoon, Skeleton } from '@/components/ui/Indicators'
import { Panel } from '@/components/ui/Panel'
import { cn } from '@/lib/cn'
import { usePageTitle } from '@/lib/hooks'
import { useComingSoonPage } from '@/lib/modeCopy'
import { BOT_NAME, WEB_SIGN_IN_URL } from '@/lib/telegramLinks'
import { useServices } from '@/services/context'
import { describeError } from '@/services/errors'
import { nearkitUserLabel } from '@/services/identity'
import type { NearKitEndedSession } from '@/services/nearkitWeb'
import { useCapabilities, useIdentity } from '@/services/queries'
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
            <h1 className="text-2xl font-bold leading-8 tracking-[-0.01em] text-fg" style={{ fontStretch: '104%' }}>
              {title}
            </h1>
            {soon ? <ComingSoon /> : status}
          </div>
          {description && (
            <p className="mt-1 max-w-[70ch] text-sm text-fg-3">
              <Figures>{description}</Figures>
            </p>
          )}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {soon && (
        <p className="rounded-lg border border-dashed border-line-strong px-4 py-3 text-sm text-fg-2">
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
  return <div className={cn('flex flex-col gap-5 px-4 pb-8 pt-5 lg:px-6', className)}>{children}</div>
}

/**
 * The NEARKITS web session this browser had ended (expired, or signed out from Telegram): said so,
 * with the way back in (/web to the bot), instead of "connect a wallet" or figures of $0.
 */
export function SessionEnded({ ended }: { ended: NearKitEndedSession }) {
  const { promptConnect } = useConnectPrompt()
  const { nearkit } = useServices()
  return (
    <EmptyState
      title="Your NEARKITS web session ended"
      action={
        <span className="flex flex-wrap items-center justify-center gap-2">
          {WEB_SIGN_IN_URL && (
            <a href={WEB_SIGN_IN_URL} target="_blank" rel="noreferrer noopener" className="inline-flex">
              <Button variant="primary" tabIndex={-1}>
                Sign in with Telegram
              </Button>
            </a>
          )}
          <Button variant="secondary" onClick={promptConnect}>
            Connect wallet
          </Button>
          <Button variant="ghost" onClick={() => nearkit.dismissEnded()}>
            Dismiss
          </Button>
        </span>
      }
    >
      {`The sign-in for ${nearkitUserLabel(ended)} expired or was signed out from Telegram. Your NEARKITS wallets and their funds are unchanged: send /web to ${BOT_NAME} for a new one-time sign-in link.`}
    </EmptyState>
  )
}

/** A read that failed: said so, with its reason and Try again, never shown as an empty or zero result. */
export function LoadFailed({ title, error, onRetry, className }: { title: string; error: unknown; onRetry: () => void; className?: string }) {
  return (
    <EmptyState
      title={title}
      graphic={false}
      className={className}
      action={
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      }
    >
      {describeError(error).message}
    </EmptyState>
  )
}

/**
 * Gate for wallet-bound tools: the page needs a wallet connected in this browser or, where it takes
 * NEARKITS wallets (`nearkit`), a NEARKITS web session (useIdentity). Disconnected users get a clear
 * way back in, and a NEARKITS session that ended says so. On a COMING SOON page the tool renders
 * read-only: every field and key is disabled.
 */
export function RequireWallet({ feature, children, nearkit = false }: { feature: string; children: ReactNode; nearkit?: boolean }) {
  const caps = useCapabilities()
  const soon = useComingSoonPage()
  const { promptConnect } = useConnectPrompt()
  const services = useServices()
  const telegram = nearkit && services.nearkit.available
  const who = useIdentity({ custodial: telegram })
  const session = who.kind === 'signed-in' ? who.wallet : null
  if (who.kind === 'signed-in' && !soon) return <>{children}</>
  if (who.kind === 'pending')
    return (
      <Panel className="p-5">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="mt-3 h-4 w-72" />
        <Skeleton className="mt-6 h-32 w-full" />
      </Panel>
    )
  if (who.kind === 'session-ended' && !soon)
    return (
      <Panel>
        <SessionEnded ended={who.ended} />
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
              ? `${feature} works across your NEARKITS wallets. The demo runs on a sample account.`
              : telegram
                ? `${feature} works across the accounts you connect, which sign in your wallet, and your NEARKITS wallets, which NEARKITS executes: the NEARKITS bot’s /web sends a one-time sign-in link.`
                : `${feature} works across the accounts you connect. You sign in your wallet; NEARKITS never sees your keys.`}
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
