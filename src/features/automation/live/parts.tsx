import { ExternalLink, Pause, Play, Square, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Button, IconButton } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Dialog'
import { EmptyState } from '@/components/ui/EmptyState'
import { Figures } from '@/components/ui/Figures'
import { Field, Select, Tabs } from '@/components/ui/Form'
import { Led, Skeleton, Tag, type LedTone } from '@/components/ui/Indicators'
import { Line, Lines, Panel, PanelHeader } from '@/components/ui/Panel'
import { tabPanelProps } from '@/components/ui/tabs'
import { useToast } from '@/components/ui/toast-context'
import { LoadFailed } from '@/components/page/Page'
import type { DetectionView, ExecutionView, StrategyPreview, StrategyView } from '@/lib/automation/api'
import { tokenOfStrategy, type StrategyKind, type TokenRef } from '@/lib/automation/config'
import { cn } from '@/lib/cn'
import { formatAccount, formatAgo, formatDateTime, formatNumber, formatUntil } from '@/lib/format'
import { useNow } from '@/lib/hooks'
import { explorerTxUrl } from '@/services/near/explorer'
import { useAutomationFeatures, useCapabilities, useNearKitWallets, useTokenLookup, useTokens } from '@/services/queries'
import {
  controlsFor,
  describeStrategy,
  detectionLamp,
  detectionSourceOf,
  detectionTitle,
  endedNote,
  endPrompt,
  endWord,
  EXECUTION_LAMP,
  executionAmounts,
  KIND_LABEL,
  NEAR_DECIMALS,
  pairSibling,
  refusalOf,
  shownRaw,
  sourcesText,
  STATUS_LAMP,
  tabOf,
  tokenRefOf,
  type ListTab,
} from './model'
import { useStrategies, useStrategy, useStrategyMutations } from './queries'

/**
 * The pieces every server-backed automation page shares: NEARKITS' switch and limits, the NEARKITS
 * wallet picker, the list with its controls, one strategy's detail (trades, what it saw, its audit
 * trail), the review before anything is created, and "pause all".
 */

export function Lamp({ tone, label, title }: { tone: LedTone; label: string; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.07em]',
        tone === 'on' ? 'text-fg' : tone === 'warn' ? 'text-warn' : tone === 'neg' ? 'text-neg' : 'text-fg-3',
      )}
    >
      <Led tone={tone} />
      {label}
    </span>
  )
}

export function StrategyLamp({ status }: { status: StrategyView['status'] }) {
  const s = STATUS_LAMP[status]
  return <Lamp tone={s.tone} label={s.label} title={s.hint} />
}

/** NEARKITS' kill switch and limits, as the server reports them. */
export function AutomationNotice() {
  const { data } = useAutomationFeatures()
  if (!data) return null
  return (
    <div className="flex flex-col gap-2">
      {data.paused && (
        <p role="status" className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/5 px-4 py-3 text-sm text-fg-2">
          <Led tone="warn" className="mt-[7px]" />
          <span>
            <Figures>{`${data.pausedReason ?? 'NEARKITS has paused automated trading'}. Nothing triggers or trades until it resumes; your automations keep their settings.`}</Figures>
          </span>
        </p>
      )}
      <p className="text-xs leading-5 text-fg-3">
        <Figures>{`Runs on NEARKITS’ server from your NEARKITS wallets only, never from a connected browser wallet. Limits: at most ${formatNumber(data.limits.maxTradeNear, 0, 2)} NEAR a trade, ${formatNumber(data.limits.maxDailyNearPerUser, 0, 2)} NEAR a day, slippage up to ${data.limits.maxSlippagePct}%.`}</Figures>
      </p>
    </div>
  )
}

/** The NEARKITS wallet an automation trades from. Browser-connected wallets are never listed: NEARKITS can’t sign for them. */
export function NearKitWalletField({ value, onChange, error }: { value: string; onChange: (id: string) => void; error?: string }) {
  const { data, isPending, isError } = useNearKitWallets()
  const wallets = (data?.wallets ?? []).filter((w) => !w.frozen)
  return (
    <Field
      label="NEARKITS wallet"
      error={error}
      hint={
        isError
          ? 'Your NEARKITS wallets couldn’t be read. Try again in a moment.'
          : !isPending && wallets.length === 0
            ? 'No NEARKITS wallet yet: create one on Wallets & Presets. Automations trade only from NEARKITS wallets.'
            : 'Automated trades run only from NEARKITS wallets, server-side.'
      }
    >
      {({ id, describedBy, invalid }) => (
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={wallets.length === 0} aria-describedby={describedBy} aria-invalid={invalid}>
          {wallets.length === 0 && <option value="">{isPending ? 'Loading…' : 'No NEARKITS wallet'}</option>}
          {wallets.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name} · {formatAccount(w.accountId, 18)}
            </option>
          ))}
        </Select>
      )}
    </Field>
  )
}

export function PauseAllButton() {
  const toast = useToast()
  const { pauseAll } = useStrategyMutations()
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <Pause size={14} /> Pause all my automations
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        size="sm"
        title="Pause all your automations?"
        description="Every active limit order, Copy Trade, Sniper and DCA of yours pauses now. A trade already under way is followed to the end."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Keep them running
            </Button>
            <Button
              variant="danger"
              loading={pauseAll.isPending}
              onClick={() =>
                pauseAll.mutate(undefined, {
                  onSuccess: (n) => {
                    setOpen(false)
                    toast.push({
                      tone: 'accent',
                      title: n === 0 ? 'Nothing was running' : `${n} automation${n === 1 ? '' : 's'} paused`,
                      detail: 'Resume each one when you’re ready.',
                    })
                  },
                  onError: (e) => toast.push({ tone: 'neg', title: 'Not paused', detail: refusalOf(e).message }),
                })
              }
            >
              Pause all
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-2">Resume each one from its list when you want it back.</p>
      </Modal>
    </>
  )
}

function Controls({ s, size = 'xs' }: { s: StrategyView; size?: 'xs' | 'sm' }) {
  const toast = useToast()
  const { pause, resume, cancel, listed } = useStrategyMutations()
  const [confirmEnd, setConfirmEnd] = useState(false)
  const c = controlsFor(s.status)
  const busy = (m: { isPending: boolean; variables?: unknown }) => m.isPending && m.variables === s.id
  const fail = (title: string) => (e: unknown) => toast.push({ tone: 'neg', title, detail: refusalOf(e).message })
  const word = endWord(s.kind)
  const prompt = endPrompt(s)
  // The other order of a pair, as the list last read it (it is cancelled with this one).
  const sibling = confirmEnd && s.kind === 'limit' ? pairSibling(s, listed('limit')) : null
  if (!c.pause && !c.resume && !c.cancel) return null
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {c.pause && (
        <Button size={size} variant="secondary" loading={busy(pause)} onClick={() => pause.mutate(s.id, { onError: fail('Not paused') })}>
          <Pause size={12} /> Pause
        </Button>
      )}
      {c.resume && (
        <Button size={size} variant="secondary" loading={busy(resume)} onClick={() => resume.mutate(s.id, { onError: fail('Not resumed') })}>
          <Play size={12} /> Resume
        </Button>
      )}
      {c.cancel && (
        <Button size={size} variant="danger" onClick={() => setConfirmEnd(true)}>
          <Square size={12} /> {word}
        </Button>
      )}
      <Modal
        open={confirmEnd}
        onClose={() => setConfirmEnd(false)}
        size="sm"
        title={prompt.title}
        description={prompt.description}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmEnd(false)}>
              Keep {s.kind === 'limit' && s.ocoGroup ? 'them' : 'it'}
            </Button>
            <Button
              variant="danger"
              loading={busy(cancel)}
              onClick={() =>
                cancel.mutate(s.id, {
                  // The lists were read again before this runs: a pair's other order shows its own state.
                  onSuccess: (after) => {
                    setConfirmEnd(false)
                    toast.push(endedNote(s, after, s.kind === 'limit' ? listed('limit') : undefined))
                  },
                  onError: fail(s.kind === 'limit' ? 'Not cancelled' : 'Not stopped'),
                })
              }
            >
              {prompt.confirm}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-1.5 text-sm text-fg-2">
          <p className="wrap-break-word">
            <Figures>{describeStrategy(s)}</Figures>
          </p>
          {sibling && (
            <p className="wrap-break-word">
              <Figures>{describeStrategy(sibling)}</Figures>
            </p>
          )}
        </div>
      </Modal>
    </span>
  )
}

/** Why it is where it is, or what it waits for: the server's own words (long ones wrap, ids included). */
function Reason({ s }: { s: StrategyView }) {
  const text = s.statusReason ?? (s.waiting ? `Waiting: ${s.waiting}` : null)
  if (!text) return null
  return (
    <p className={cn('min-w-0 text-xs leading-5 wrap-break-word', s.status === 'failed' ? 'text-neg' : s.waiting && !s.statusReason ? 'text-warn' : 'text-fg-3')}>
      <Figures>{text}</Figures>
    </p>
  )
}

const EMPTY: Record<ListTab, string> = {
  active: 'Nothing running. Create one with the form.',
  paused: 'Nothing paused.',
  history: 'Filled, completed, cancelled, stopped, expired and failed ones collect here.',
}

/** The user's strategies of one kind: running, paused, ended; each with its controls. */
export function StrategiesPanel({ kind, selected, onSelect, title }: { kind: StrategyKind; selected: string | null; onSelect: (id: string) => void; title: string }) {
  const list = useStrategies(kind)
  const now = useNow(30_000)
  const [tab, setTab] = useState<ListTab>('active')
  const all = list.data ?? []
  const of = (t: ListTab) => all.filter((s) => tabOf(s.status) === t)
  const shown = of(tab)
  const idBase = `auto-${kind}`
  return (
    <Panel>
      <PanelHeader title={title} meta={list.data ? all.length : undefined} />
      <div className="px-4 pt-2">
        <Tabs
          idBase={idBase}
          label={title}
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'active', label: 'Active', count: of('active').length },
            { value: 'paused', label: 'Paused', count: of('paused').length },
            { value: 'history', label: 'History', count: of('history').length },
          ]}
        />
      </div>
      <div {...tabPanelProps(idBase, tab)} className="outline-none">
        {list.isPending ? (
          <div className="p-4">
            <Skeleton className="h-32 w-full" />
          </div>
        ) : list.isError ? (
          <LoadFailed title="Your automations couldn’t be read" error={list.error} onRetry={() => void list.refetch()} />
        ) : shown.length === 0 ? (
          <EmptyState title={tab === 'active' ? 'Nothing active' : tab === 'paused' ? 'Nothing paused' : 'No history yet'} graphic={false}>
            {EMPTY[tab]}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line-soft" aria-label={`${title}: ${tab}`}>
            {shown.map((s) => (
              <li key={s.id} className={cn('flex flex-col gap-2 px-4 py-3', s.id === selected && 'bg-raised/50')}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <StrategyLamp status={s.status} />
                    {s.ocoGroup && (
                      <Tag tone="neutral" title="Take profit and stop loss: the first to trigger cancels the other, and cancelling either cancels both">
                        Pair
                      </Tag>
                    )}
                  </span>
                  <span className="num text-xs text-fg-3">
                    <Figures>
                      {s.closedAt ? `ended ${formatAgo(s.closedAt, now)}` : s.expiresAt ? `expires ${formatUntil(s.expiresAt, now)}` : `since ${formatAgo(s.createdAt, now)}`}
                    </Figures>
                  </span>
                </div>
                <p className="text-sm text-fg wrap-break-word">
                  <Figures>{describeStrategy(s)}</Figures>
                </p>
                <p className="num text-xs text-fg-3 wrap-break-word">
                  <Figures>
                    {[
                      kind === 'copy' ? `follows ${formatAccount(s.subject, 28)}` : null,
                      `from ${s.walletName ?? 'a NEARKITS wallet'}`,
                      kind === 'limit'
                        ? s.lastPriceNear
                          ? `last price ${s.lastPriceNear} NEAR${s.lastQuoteAt ? ` (${formatAgo(s.lastQuoteAt, now)})` : ''}`
                          : 'no price read yet'
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Figures>
                </p>
                <Reason s={s} />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Controls s={s} />
                  <Button size="xs" variant="ghost" className="ml-auto" onClick={() => onSelect(s.id)} aria-pressed={s.id === selected}>
                    Details
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  )
}

function TxLinks({ hashes, label }: { hashes: readonly string[]; label?: string }) {
  const caps = useCapabilities()
  if (hashes.length === 0 || !caps.explorerUrl) return null
  const explorerUrl = caps.explorerUrl
  return (
    <span className="flex flex-wrap items-center gap-2">
      {label && <span className="text-xs text-fg-3">{label}</span>}
      {hashes.map((h) => (
        <a
          key={h}
          href={explorerTxUrl({ explorerUrl }, h)}
          target="_blank"
          rel="noreferrer noopener"
          title={h}
          className="num inline-flex items-center gap-1 text-xs text-fg-2 underline-offset-2 hover:text-fg hover:underline"
        >
          {h.slice(0, 8)}… <ExternalLink size={11} aria-hidden="true" />
        </a>
      ))}
    </span>
  )
}

/** The token a trade moved, with its symbol and decimals: the strategy's own, a listed one, or read from chain. */
function useTradeToken(id: string, known: TokenRef | null): TokenRef | null {
  const { data: tokens = [] } = useTokens()
  const listed = known && known.id === id ? known : tokenRefOf(tokens.find((t) => t.contract === id))
  const lookup = useTokenLookup(listed ? null : id)
  if (listed) return listed
  return lookup.data ? (tokenRefOf(lookup.data) ?? { id, symbol: lookup.data.symbol, decimals: lookup.data.decimals }) : null
}

/** One automated trade: confirmed only when the server says the chain confirmed it; before that, the quote's figures, labelled. */
function ExecutionRow({ e, token: known, now }: { e: ExecutionView; token: TokenRef | null; now: number }) {
  const token = useTradeToken(e.token, known)
  const a = executionAmounts(e, token)
  const lamp = EXECUTION_LAMP[e.status]
  return (
    <li className="flex flex-col gap-1 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <Tag tone={e.side === 'buy' ? 'accent' : 'neg'}>{e.side}</Tag>
          <Lamp tone={lamp.tone} label={lamp.label} />
        </span>
        <span className="num text-xs text-fg-3">{formatAgo(e.createdAt, now)}</span>
      </div>
      <p className="num text-xs text-fg-2 wrap-break-word">
        <Figures>{`${a.quoted ? 'Quoted: ' : ''}${a.spent} → ${a.received}${e.priceNear ? ` · ${e.priceNear} NEAR per token` : ''}`}</Figures>
      </p>
      {e.message && (
        <p className={cn('text-xs wrap-break-word', e.status === 'failed' ? 'text-neg' : 'text-fg-3')}>
          <Figures>{e.message}</Figures>
        </p>
      )}
      <TxLinks hashes={e.txHashes} />
    </li>
  )
}

/**
 * One thing a Copy Trade rule or a sniper saw, and what it decided. A new pool names its exchange and
 * pool; a token-for-token swap's legs name the copied side and link the followed account's
 * transaction. "Seen" is never a trade: a trade is in Trades, confirmed only once the chain says so.
 */
function DetectionRow({ d, kind, now }: { d: DetectionView; kind: StrategyKind; now: number }) {
  const source = detectionSourceOf(d.sourceKey, kind)
  const title = detectionTitle(source)
  const lamp = detectionLamp(d.status, kind)
  const tx = source.kind === 'leg' || source.kind === 'tx' ? source.txHash : null
  return (
    <li className="flex flex-col gap-1 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          {title ? <span className="text-xs font-medium text-fg">{title}</span> : d.side && <Tag tone={d.side === 'buy' ? 'accent' : 'neg'}>{d.side}</Tag>}
          <Lamp tone={lamp.tone} label={lamp.label} />
        </span>
        <span className="num text-xs text-fg-3">{formatAgo(d.at, now)}</span>
      </div>
      {source.kind === 'pool' ? (
        <p className="num text-xs text-fg-2 wrap-anywhere">
          {`${source.exchange} pool ${source.poolId}`}
          {d.token ? ` · ${formatAccount(d.token, 26)}` : ''}
        </p>
      ) : (
        <p className="num text-xs text-fg-2 wrap-anywhere">
          <Figures>{[d.token ? formatAccount(d.token, 26) : null, d.nearRaw ? `${shownRaw(d.nearRaw, NEAR_DECIMALS)} NEAR` : null].filter(Boolean).join(' · ') || '—'}</Figures>
        </p>
      )}
      {d.reason && (
        <p className="text-xs text-fg-3 wrap-break-word">
          <Figures>{d.reason}</Figures>
        </p>
      )}
      {tx && <TxLinks hashes={[tx]} label="Their transaction" />}
    </li>
  )
}

/** One strategy: its facts, its trades (confirmed only when the chain says so), what it saw, and its audit trail. */
export function StrategyDetailPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const detail = useStrategy(id)
  const now = useNow(30_000)
  if (detail.isPending)
    return (
      <Panel className="p-4">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="mt-4 h-28 w-full" />
      </Panel>
    )
  if (detail.isError)
    return (
      <Panel>
        <LoadFailed title="This automation couldn’t be read" error={detail.error} onRetry={() => void detail.refetch()} />
      </Panel>
    )
  const { strategy: s, executions, events, detections } = detail.data
  const token: TokenRef | null = tokenOfStrategy(s.config)
  const pools = s.config.kind === 'sniper' && s.config.sniper.target === 'new-pools' ? s.config.sniper : null
  const confirmedBuys = executions.filter((e) => e.side === 'buy' && e.status === 'confirmed').length
  return (
    <Panel>
      <PanelHeader
        title={`${KIND_LABEL[s.kind]} detail`}
        actions={
          <IconButton label="Close detail" size="sm" onClick={onClose}>
            <X size={14} />
          </IconButton>
        }
      />
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <StrategyLamp status={s.status} />
          <Controls s={s} size="sm" />
        </div>
        <p className="text-sm text-fg wrap-break-word">
          <Figures>{describeStrategy(s)}</Figures>
        </p>
        <Reason s={s} />
        <Lines>
          {s.kind === 'copy' && <Line label="Follows">{formatAccount(s.subject, 30)}</Line>}
          {token && <Line label="Token">{`${token.symbol} · ${formatAccount(token.id, 24)}`}</Line>}
          {pools && (
            <>
              <Line label="New pools from">{sourcesText(pools.sources)}</Line>
              <Line label="Pool holds at least">{pools.minPoolNear === null ? '—' : `${formatNumber(pools.minPoolNear, 0, 4)} NEAR`}</Line>
              <Line label="Each buy">{`${formatNumber(pools.amountNear, 0, 4)} NEAR`}</Line>
              {pools.mode === 'execute' && <Line label="Tokens bought (on chain)">{`${confirmedBuys} of ${pools.maxBuys}`}</Line>}
            </>
          )}
          <Line label="Wallet">{s.walletName ?? '—'}</Line>
          {s.kind === 'limit' && (
            <Line label="Last price seen">{s.lastPriceNear ? `${s.lastPriceNear} NEAR${s.lastQuoteAt ? ` · ${formatAgo(s.lastQuoteAt, now)}` : ''}` : 'None read yet'}</Line>
          )}
          <Line label="Attempts">{String(s.attempts)}</Line>
          <Line label="Created">{formatDateTime(s.createdAt)}</Line>
          <Line label={s.closedAt ? 'Ended' : 'Expires'}>{s.closedAt ? formatDateTime(s.closedAt) : s.expiresAt ? formatDateTime(s.expiresAt) : 'Never'}</Line>
        </Lines>

        <section aria-label="Trades" className="flex flex-col gap-2">
          <h3 className="legend">Trades</h3>
          {executions.length === 0 ? (
            <p className="text-xs text-fg-3">No trade yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line-soft rounded-md border border-line-soft">
              {executions.map((e) => (
                <ExecutionRow key={e.id} e={e} token={token} now={now} />
              ))}
            </ul>
          )}
        </section>

        {(s.kind === 'copy' || s.kind === 'sniper') && (
          <section aria-label="What it saw" className="flex flex-col gap-2">
            <h3 className="legend">{s.kind === 'copy' ? 'Detected trades' : pools ? 'New pools seen' : 'Sightings'}</h3>
            {detections.length === 0 ? (
              <p className="text-xs text-fg-3">
                {s.kind === 'copy'
                  ? 'Nothing detected yet from the followed account.'
                  : pools
                    ? 'No new pool from its sources yet. Pools made before this sniper are never reported.'
                    : 'The token hasn’t been seen trading yet.'}
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-line-soft rounded-md border border-line-soft">
                {detections.map((d) => (
                  <DetectionRow key={d.sourceKey} d={d} kind={s.kind} now={now} />
                ))}
              </ul>
            )}
          </section>
        )}

        <section aria-label="Audit trail" className="flex flex-col gap-2">
          <h3 className="legend">Audit trail</h3>
          {events.length === 0 ? (
            <p className="text-xs text-fg-3">No events yet.</p>
          ) : (
            <ol className="flex flex-col gap-1.5">
              {events.map((ev, i) => (
                <li key={`${ev.at}-${i}`} className="flex gap-3 text-xs">
                  <span className="num w-24 shrink-0 text-fg-3">{formatAgo(ev.at, now)}</span>
                  <span className="min-w-0 text-fg-2 wrap-break-word">
                    <Figures>{ev.message}</Figures>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </Panel>
  )
}

/** A fresh executable quote, as the server read it now: never a promise of the price a trigger trades at. */
export function PreviewLines({ preview, token, triggerText }: { preview: StrategyPreview; token: TokenRef; triggerText?: string }) {
  const outDecimals = preview.side === 'buy' ? token.decimals : NEAR_DECIMALS
  const outUnit = preview.side === 'buy' ? token.symbol : 'NEAR'
  const feeDecimals = preview.feeToken === token.id ? token.decimals : NEAR_DECIMALS
  const feeUnit = preview.feeToken === token.id ? token.symbol : 'NEAR'
  return (
    <Lines>
      <Line label="Executable price now" emphasis>{`${preview.priceNear} NEAR per ${token.symbol}`}</Line>
      {preview.wouldTrigger !== null && (
        <Line label="Would trigger now">
          {preview.wouldTrigger ? <span className="text-warn">Yes: it would trade at the next check</span> : `No${triggerText ? ` (trigger ${triggerText} NEAR)` : ''}`}
        </Line>
      )}
      <Line label="Spends">{`${preview.amountIn} ${preview.side === 'buy' ? 'NEAR' : token.symbol}`}</Line>
      <Line label="Expected now">{`${shownRaw(preview.expectedOutRaw, outDecimals)} ${outUnit}`}</Line>
      <Line label="Minimum received now">{`${shownRaw(preview.minOutRaw, outDecimals)} ${outUnit}`}</Line>
      <Line label="Price impact">{preview.priceImpactPct === null ? 'Unknown' : `${formatNumber(preview.priceImpactPct, 0, 2)}%`}</Line>
      <Line label="NEARKITS fee">{preview.feeRaw ? `${shownRaw(preview.feeRaw, feeDecimals)} ${feeUnit}` : 'None on this route'}</Line>
      <Line label="Network fee">{`${preview.networkFeeNear} NEAR`}</Line>
      <Line label="Wallet holds">{`${shownRaw(preview.balanceNearRaw, NEAR_DECIMALS, 4)} NEAR · ${shownRaw(preview.balanceTokenRaw, token.decimals, 4)} ${token.symbol}`}</Line>
    </Lines>
  )
}

/** The review before creating: what was asked, the server's fresh quote (when it has one), and the honest terms. */
export function ReviewModal({
  open,
  onClose,
  title,
  summary,
  preview,
  extra,
  terms,
  error,
  confirmLabel,
  confirmDisabled,
  confirming,
  onConfirm,
}: {
  open: boolean
  onClose: () => void
  title: string
  summary: ReactNode
  /** The quote's state: null where nothing is quoted (Copy Trade). */
  preview: { pending: boolean; error: string | null; body: ReactNode | null } | null
  extra?: ReactNode
  terms: string
  error: string | null
  confirmLabel: string
  confirmDisabled?: boolean
  confirming: boolean
  onConfirm: () => void
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Back
          </Button>
          <Button variant="primary" loading={confirming} disabled={confirmDisabled || (preview?.pending ?? false)} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="text-sm text-fg">{summary}</div>
        {preview && (
          <div className="rounded-md border border-line-soft p-3">
            <h3 className="legend mb-2">Fresh quote from your NEARKITS wallet</h3>
            {preview.pending ? (
              <Skeleton className="h-24 w-full" />
            ) : preview.error ? (
              <p className="text-xs text-neg" role="alert">
                <Figures>{preview.error}</Figures>
              </p>
            ) : (
              preview.body
            )}
          </div>
        )}
        {extra}
        <p className="text-xs leading-5 text-fg-3">
          <Figures>{terms}</Figures>
        </p>
        {error && (
          <p className="text-sm text-neg" role="alert">
            <Figures>{error}</Figures>
          </p>
        )}
      </div>
    </Modal>
  )
}
