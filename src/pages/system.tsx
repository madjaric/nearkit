import { isRouteErrorResponse, Link, useRouteError } from 'react-router'
import { LogoMark } from '@/components/brand/Brand'
import { Page, PageHeader } from '@/components/page/Page'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Panel } from '@/components/ui/Panel'

/** First paint while the initial route module loads. */
export function BootScreen() {
  return (
    <div className="grid min-h-dvh place-items-center bg-canvas">
      <div className="flex items-center gap-3 text-sm text-fg-3">
        <LogoMark size={22} />
        <span className="animate-ghost">Starting NearKit</span>
      </div>
    </div>
  )
}

/** Route-level failure rendered inside the shell, so navigation keeps working. */
export function RouteError() {
  const error = useRouteError()
  const message = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : error instanceof Error ? error.message : 'Unknown error'
  return (
    <Page>
      <PageHeader title="Something broke on this screen" />
      <Panel>
        <EmptyState
          title="This panel failed to render"
          action={
            <>
              <Button variant="secondary" onClick={() => window.location.reload()}>
                Reload
              </Button>
              <Link to="/" className="keycap inline-flex h-8 items-center rounded-sm px-3 text-xs text-fg-2 hover:bg-raised hover:text-fg">
                Go to dashboard
              </Link>
            </>
          }
        >
          <span className="num text-xs text-fg-3">{message}</span>
        </EmptyState>
      </Panel>
    </Page>
  )
}

export default function NotFoundPage() {
  return (
    <Page>
      <PageHeader title="No panel at this address" />
      <Panel>
        <EmptyState
          title="This route doesn't exist"
          action={
            <Link to="/" className="keycap inline-flex h-8 items-center rounded-sm bg-accent px-3 text-xs text-accent-ink hover:bg-accent-hi">
              Go to dashboard
            </Link>
          }
        >
          Use the sidebar, or press <span className="num text-fg-2">/</span> and type a tool name.
        </EmptyState>
      </Panel>
    </Page>
  )
}
