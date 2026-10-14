import { useState, type ReactNode } from 'react'
import { Page, PageGrid, PageHeader, SessionEnded } from '@/components/page/Page'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton, Tag } from '@/components/ui/Indicators'
import { Panel } from '@/components/ui/Panel'
import type { StrategyKind } from '@/lib/automation/config'
import { BOT_NAME, WEB_SIGN_IN_URL } from '@/lib/telegramLinks'
import { useIdentity } from '@/services/queries'
import { AutomationNotice, PauseAllButton, StrategiesPanel, StrategyDetailPanel } from './parts'
import type { AutomationAccess } from './queries'

/**
 * A server-backed automation page's body: NEARKITS' switch and limits, the form that creates one,
 * the user's list of that kind with its controls, and the detail of the one picked.
 */
export function LiveAutomation({ kind, title, form }: { kind: StrategyKind; title: string; form: (onCreated: (id: string) => void) => ReactNode }) {
  const [selected, setSelected] = useState<string | null>(null)
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-72">
          <AutomationNotice />
        </div>
        <PauseAllButton />
      </div>
      <PageGrid aside={form(setSelected)} asideWidth={400} asideFirst>
        <StrategiesPanel kind={kind} title={title} selected={selected} onSelect={setSelected} />
        {selected && <StrategyDetailPanel key={selected} id={selected} onClose={() => setSelected(null)} />}
      </PageGrid>
    </>
  )
}

/**
 * NEARKITS' server runs it, but this browser has no NEARKITS web session: automations trade only from
 * NEARKITS wallets, so the way in is the bot's one-time sign-in link (a browser wallet can't run them).
 */
function SignInToAutomate({ feature }: { feature: string }) {
  const who = useIdentity()
  if (who.kind === 'session-ended')
    return (
      <Panel>
        <SessionEnded ended={who.ended} />
      </Panel>
    )
  return (
    <Panel>
      <EmptyState
        title={`Sign in with Telegram to use ${feature}`}
        action={
          WEB_SIGN_IN_URL ? (
            <a href={WEB_SIGN_IN_URL} target="_blank" rel="noreferrer noopener" className="inline-flex">
              <Button variant="primary" tabIndex={-1}>
                Sign in with Telegram
              </Button>
            </a>
          ) : undefined
        }
      >
        {`Automations trade from your NEARKITS wallets, run by NEARKITS’ server within its limits. Send /web to ${BOT_NAME} for a one-time sign-in link; a browser wallet can’t run them.`}
      </EmptyState>
    </Panel>
  )
}

/**
 * An automation page wherever NEARKITS' server runs its kind (`access` other than 'held'): the live
 * page with a NEARKITS session, the same page asking to sign in without one, and a quiet placeholder
 * while the answer that decides is on its way (so neither drafts nor "coming soon" flash up).
 */
export function LiveAutomationPage({
  access,
  kind,
  feature,
  description,
  listTitle,
  form,
}: {
  access: Exclude<AutomationAccess, 'held'>
  kind: StrategyKind
  feature: string
  description: string
  listTitle: string
  form: (onCreated: (id: string) => void) => ReactNode
}) {
  if (access === 'checking')
    return (
      <Page>
        <div aria-busy="true" aria-label={`Loading ${feature}`} className="flex flex-col gap-3">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-full max-w-md" />
          <Skeleton className="mt-2 h-64 w-full" />
        </div>
      </Page>
    )
  return (
    <Page>
      <PageHeader title={feature} status={<Tag tone="accent">Live · NEARKITS wallets</Tag>} description={description} />
      {access === 'live' ? <LiveAutomation kind={kind} title={listTitle} form={form} /> : <SignInToAutomate feature={feature} />}
    </Page>
  )
}
