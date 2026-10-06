import { Plus } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ExecutionTag } from '@/components/domain/Status'
import { Page, PageHeader } from '@/components/page/Page'
import { Button } from '@/components/ui/Button'
import { buttonClass } from '@/components/ui/buttonClass'
import { EmptyState } from '@/components/ui/EmptyState'
import { Figures } from '@/components/ui/Figures'
import { Led, Skeleton } from '@/components/ui/Indicators'
import { Panel } from '@/components/ui/Panel'
import { BotConsole } from '@/features/volumeBot/BotConsole'
import { BotSetup } from '@/features/volumeBot/BotSetup'
import { VOLUME_BOT_PATH } from '@/features/volumeBot/content'
import { statusLamp, STRATEGY } from '@/features/volumeBot/model'
import { isLive, useVolumeBots } from '@/features/volumeBot/queries'
import { cn } from '@/lib/cn'
import { formatNumber } from '@/lib/format'
import { WEB_SIGN_IN_URL } from '@/lib/telegramLinks'
import type { BotDetail } from '@/lib/volumeBot/api'
import { useServices } from '@/services/context'
import { useCapabilities, useNearKitSession } from '@/services/queries'

/**
 * The Volume Bot console: the user's bots, one at a time, and the form that configures them.
 * A bot trades only from NEARKITS wallets, so the console needs a NEARKITS web session.
 */

type Mode = { kind: 'view' } | { kind: 'new' } | { kind: 'edit'; detail: BotDetail }

function Gate({ children }: { children: ReactNode }) {
  const services = useServices()
  const caps = useCapabilities()
  const session = useNearKitSession()
  if (!services.nearkit.available)
    return (
      <Panel>
        <EmptyState
          title={caps.mode === 'demo' ? 'The Volume Bot doesn’t run in the demo' : 'This build has no NEARKITS server'}
          action={
            <Link to={VOLUME_BOT_PATH} className={buttonClass({ variant: 'secondary' })}>
              How the Volume Bot works
            </Link>
          }
        >
          It trades from NEARKITS wallets on NEARKITS’s server, and figures here are only ever from its executed trades, so there is nothing to show without them.
        </EmptyState>
      </Panel>
    )
  if (!session)
    return (
      <Panel>
        <EmptyState
          title="Sign in with Telegram to use the Volume Bot"
          action={
            <span className="flex flex-wrap items-center justify-center gap-2">
              {WEB_SIGN_IN_URL && (
                <a href={WEB_SIGN_IN_URL} target="_blank" rel="noreferrer noopener" className={buttonClass({ variant: 'primary' })}>
                  Sign in with Telegram
                </a>
              )}
              <Link to={VOLUME_BOT_PATH} className={buttonClass({ variant: 'ghost' })}>
                How it works
              </Link>
            </span>
          }
        >
          A bot trades from your NEARKITS wallets, which NEARKITS executes. The NEARKITS bot’s /web sends a one-time sign-in link.
        </EmptyState>
      </Panel>
    )
  return <>{children}</>
}

function BotPicker({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const { data: bots = [] } = useVolumeBots()
  if (bots.length < 2) return null
  return (
    <div role="tablist" aria-label="Your Volume Bots" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:px-0">
      {bots.map((b) => {
        const lamp = statusLamp(b)
        const active = b.id === selected
        return (
          <button
            key={b.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(b.id)}
            className={cn(
              'flex shrink-0 items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors',
              active ? 'border-line-strong bg-raised text-fg' : 'border-line text-fg-2 hover:text-fg',
            )}
          >
            <Led tone={lamp.tone} label={lamp.label} />
            <span className="font-medium">{b.symbol}</span>
            <span className="text-fg-3">{STRATEGY[b.strategy].label.replace(' (TWAP)', '')}</span>
            <span className="num text-xs text-fg-3">
              <Figures>{`${formatNumber(b.volumeNear, 0, 2)} NEAR`}</Figures>
            </span>
          </button>
        )
      })}
    </div>
  )
}

function Console() {
  const bots = useVolumeBots()
  const [params, setParams] = useSearchParams()
  const [mode, setMode] = useState<Mode>({ kind: 'view' })
  const list = bots.data ?? []
  const asked = params.get('bot')
  const selected = list.find((b) => b.id === asked)?.id ?? list.find((b) => isLive(b.status) || b.status === 'paused')?.id ?? list[0]?.id ?? null
  const select = (id: string | null) => {
    setMode({ kind: 'view' })
    setParams(id ? { bot: id } : {}, { replace: true })
  }

  if (bots.isPending)
    return (
      <Panel className="p-5">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="mt-6 h-40 w-full" />
      </Panel>
    )
  if (bots.isError)
    return (
      <Panel>
        <EmptyState title="Your bots couldn’t be read">
          <Figures>{bots.error instanceof Error ? bots.error.message : 'Try again in a moment.'}</Figures>
        </EmptyState>
      </Panel>
    )
  if (mode.kind === 'new' || list.length === 0) return <BotSetup onSaved={(b) => select(b.id)} onCancel={list.length > 0 ? () => setMode({ kind: 'view' }) : undefined} />
  if (mode.kind === 'edit')
    return <BotSetup editing={{ bot: mode.detail.bot, config: mode.detail.config }} onSaved={(b) => select(b.id)} onCancel={() => setMode({ kind: 'view' })} />
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <BotPicker selected={selected} onSelect={select} />
        <Button variant="secondary" size="sm" className="ml-auto" onClick={() => setMode({ kind: 'new' })}>
          <Plus size={14} /> New bot
        </Button>
      </div>
      {selected && <BotConsole key={selected} botId={selected} onEdit={(detail) => setMode({ kind: 'edit', detail })} onDeleted={() => select(null)} />}
    </>
  )
}

export default function VolumeBotConsolePage() {
  return (
    <Page>
      <PageHeader
        title="Volume Bot"
        status={<ExecutionTag trading />}
        description="Automated trading from your NEARKITS wallets: a market maker with an edge over fair value, or TWAP accumulate and distribute. Every figure is from executed trades."
        actions={
          <Link to={VOLUME_BOT_PATH} className={buttonClass({ variant: 'ghost', size: 'sm' })}>
            How it works
          </Link>
        }
      />
      <Gate>
        <Console />
      </Gate>
    </Page>
  )
}
