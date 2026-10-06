import { ExternalLink, OctagonX, Pause, Pencil, Play, Square, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { ValueTrace } from '@/components/chart/ValueTrace'
import { TokenGlyph } from '@/components/domain/TokenGlyph'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Dialog'
import { EmptyState } from '@/components/ui/EmptyState'
import { Figures } from '@/components/ui/Figures'
import { Segmented } from '@/components/ui/Form'
import { Led, Skeleton, Tag } from '@/components/ui/Indicators'
import { Line, Lines, Panel, PanelHeader } from '@/components/ui/Panel'
import { ReadoutSlot, ReadoutStrip } from '@/components/ui/Readout'
import { Table, Td, Th, Tr } from '@/components/ui/Table'
import { useToast } from '@/components/ui/toast-context'
import { cn } from '@/lib/cn'
import { formatAgo, formatClock, formatDateTime, formatDuration, formatNumber, formatPct, MINUS } from '@/lib/format'
import { useNow } from '@/lib/hooks'
import type { BotDetail, BotMetricPoint } from '@/lib/volumeBot/api'
import { GUARDIAN_LABEL } from '@/lib/volumeBot/risk'
import type { GuardianCode } from '@/lib/volumeBot/types'
import { explorerTxUrl } from '@/services/near/explorer'
import { useCapabilities } from '@/services/queries'
import { controlsFor, runPoints, statusLamp, STRATEGY } from './model'
import { useVolumeBot, useVolumeBotMutations } from './queries'

/**
 * One Volume Bot at work: its status and keys, its run's figures from executed trades only, the
 * market it last read, the guardian's state, its wallets, its trades and its log.
 */

const near = (v: number | null | undefined, digits = 4) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${formatNumber(v, 0, digits)} NEAR`)
const signedNear = (v: number | null) => (v === null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? MINUS : ''}${formatNumber(Math.abs(v), 0, 4)} NEAR`)
const price = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${formatNumber(v, 0, v < 0.001 ? 10 : 6)} NEAR`)
const tone = (v: number | null) => (v === null || v === 0 ? 'text-fg' : v > 0 ? 'text-pos' : 'text-neg')

type ChartKey = 'price' | 'pnl' | 'volume' | 'exposure'
const CHARTS: Record<ChartKey, { label: string; of: (p: BotMetricPoint) => number | null; format: (v: number) => string; empty: string }> = {
  price: { label: 'Price', of: (p) => p.priceNear, format: (v) => price(v), empty: 'The price the bot reads, about once a minute while it runs.' },
  pnl: { label: 'PnL', of: (p) => p.pnlNear, format: (v) => signedNear(v), empty: 'Realized and unrealized, from its own trades at the price of the moment.' },
  volume: { label: 'Volume', of: (p) => p.volumeNear, format: (v) => near(v, 2), empty: 'Executed volume of this run: confirmed trades only.' },
  exposure: { label: 'Exposure', of: (p) => p.tokenPct, format: (v) => formatPct(v, { decimals: 1 }), empty: 'The share of the bot’s value held in the token.' },
}

function Charts({ detail }: { detail: BotDetail }) {
  const [chart, setChart] = useState<ChartKey>('price')
  const spec = CHARTS[chart]
  const points = runPoints(detail.series, detail.bot.startedAt).flatMap((p) => {
    const v = spec.of(p)
    return v === null || !Number.isFinite(v) ? [] : [{ t: p.at, v }]
  })
  return (
    <Panel>
      <PanelHeader
        title="Run"
        meta={points.length > 0 ? `${points.length} point${points.length === 1 ? '' : 's'}` : undefined}
        actions={
          <Segmented<ChartKey>
            label="Chart"
            size="sm"
            value={chart}
            onChange={setChart}
            options={(Object.keys(CHARTS) as ChartKey[]).map((k) => ({ value: k, label: CHARTS[k].label }))}
          />
        }
      />
      <div className="p-4">
        {points.length < 2 ? (
          <EmptyState title={`No ${spec.label.toLowerCase()} line yet`}>{spec.empty}</EmptyState>
        ) : (
          <ValueTrace
            key={chart}
            points={points}
            timeScale
            gapMs={10 * 60_000}
            label={`${detail.bot.symbol} bot ${spec.label.toLowerCase()}, this run`}
            formatValue={spec.format}
            formatTick={spec.format}
            formatTime={formatDateTime}
            height={220}
          />
        )}
      </div>
    </Panel>
  )
}

function Readouts({ detail, now }: { detail: BotDetail; now: number }) {
  const { bot, metrics } = detail
  const exposure = detail.series.at(-1)?.tokenPct ?? null
  return (
    <ReadoutStrip cols="grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
      <ReadoutSlot
        className="col-span-2 md:col-span-1"
        legend="Volume (run)"
        value={formatNumber(metrics.volumeNear, 0, 4)}
        unit="NEAR"
        sub={`${formatNumber(metrics.volume24hNear, 0, 2)} NEAR in 24h`}
        size="lg"
      />
      <ReadoutSlot
        legend="PnL"
        value={<span className={tone(bot.pnlNear)}>{signedNear(bot.pnlNear).replace(' NEAR', '')}</span>}
        unit={bot.pnlNear === null ? undefined : 'NEAR'}
        sub={bot.pnlNear === null ? 'After its first market read' : 'Realized + unrealized'}
      />
      <ReadoutSlot
        legend="Trades"
        value={String(metrics.confirmed)}
        sub={metrics.successRate === null ? 'None attempted' : `${metrics.failed} failed · ${formatPct(metrics.successRate * 100, { decimals: 0 })} succeeded`}
      />
      <ReadoutSlot legend="Exposure" value={exposure === null ? '—' : formatPct(exposure, { decimals: 1 })} sub="Of its value in the token" />
      <ReadoutSlot
        legend="Runtime"
        value={bot.startedAt === null ? '—' : formatDuration(bot.runtimeSec * 1000)}
        sub={bot.lastTradeAt ? `Last trade ${formatAgo(bot.lastTradeAt, now)}` : 'No trade yet'}
      />
    </ReadoutStrip>
  )
}

function MarketPanel({ detail, now }: { detail: BotDetail; now: number }) {
  const m = detail.market
  const spread = m && m.askNear !== null && m.bidNear !== null && m.midNear > 0 ? ((m.askNear - m.bidNear) / m.midNear) * 100 : null
  const age = m ? Math.max(0, Math.round((now - m.at) / 1000)) : null
  const stale = age !== null && age > detail.config.risk.maxDataAgeSec
  const fairOff = m && detail.fair && detail.fair.value > 0 ? ((m.midNear - detail.fair.value) / detail.fair.value) * 100 : null
  return (
    <Panel>
      <PanelHeader
        title="Market"
        meta={m ? m.source : undefined}
        actions={age !== null && <span className={cn('num text-xs', stale ? 'text-warn' : 'text-fg-4')}>{stale ? 'stale' : `${age}s`}</span>}
      />
      <div className="p-4">
        {!m ? (
          <p className="text-sm text-fg-3">Read when the bot runs: a small quote each way through Rhea, after every fee.</p>
        ) : (
          <Lines>
            <Line label="Mid price">{price(m.midNear)}</Line>
            <Line label="Fair value">{detail.fair ? `${price(detail.fair.value)} · ${detail.fair.samples} reads` : 'Learning'}</Line>
            {fairOff !== null && <Line label="Price vs fair">{formatPct(fairOff, { signed: true, decimals: 2 })}</Line>}
            <Line label="Buy (ask)">{price(m.askNear)}</Line>
            <Line label="Sell (bid)">{price(m.bidNear)}</Line>
            <Line label="Spread">{spread === null ? '—' : formatPct(spread, { decimals: 2 })}</Line>
            <Line label="Pool liquidity">{m.liquidityUsd === null ? 'Unknown' : `$${formatNumber(m.liquidityUsd, 0, 0)}`}</Line>
          </Lines>
        )}
      </div>
    </Panel>
  )
}

function RiskPanel({ detail }: { detail: BotDetail }) {
  const r = detail.config.risk
  const h = detail.health
  const lamp = (n: number, limit: number) => <Led tone={n === 0 ? 'on' : n >= limit ? 'neg' : 'warn'} />
  return (
    <Panel>
      <PanelHeader title="Guardian" />
      <div className="flex flex-col gap-3 p-4">
        <Lines>
          <Line label={<span className="flex items-center gap-2">{lamp(h?.consecutiveFailures ?? 0, r.maxConsecutiveFailures)} Failures in a row</span>}>
            {`${h?.consecutiveFailures ?? 0} of ${r.maxConsecutiveFailures}`}
          </Line>
          <Line label={<span className="flex items-center gap-2">{lamp(h?.rpcErrors ?? 0, 3)} RPC errors</span>}>{`${h?.rpcErrors ?? 0} of 3`}</Line>
          <Line label={<span className="flex items-center gap-2">{lamp(h?.providerErrors ?? 0, 3)} Data source errors</span>}>{`${h?.providerErrors ?? 0} of 3`}</Line>
        </Lines>
        <Lines className="border-t border-line-soft pt-3">
          <Line label="Largest trade">{near(r.maxTradeNear, 2)}</Line>
          <Line label="Daily loss limit">{near(r.maxDailyLossNear, 2)}</Line>
          <Line label="Drawdown limit">{`${r.maxDrawdownPct}%`}</Line>
          <Line label="Max slippage · impact">{`${r.maxSlippageBps / 100}% · ${r.maxPriceImpactBps / 100}%`}</Line>
          <Line label="Abnormal move">{`${r.maxPriceMovePct}%`}</Line>
          <Line label="Liquidity floor">{`$${formatNumber(r.minLiquidityUsd, 0, 0)}`}</Line>
        </Lines>
      </div>
    </Panel>
  )
}

function Wallets({ detail }: { detail: BotDetail }) {
  const symbol = detail.bot.symbol
  return (
    <Panel>
      <PanelHeader title="Wallets" meta={detail.wallets.length} />
      <div className="@container">
        <div className="hidden @[40rem]:block">
          <Table label="The bot’s wallets">
            <thead>
              <tr>
                <Th>Wallet</Th>
                <Th align="right">NEAR</Th>
                <Th align="right">{symbol}</Th>
                <Th align="right">Exposure</Th>
                <Th align="right">PnL</Th>
                <Th align="right">Trades</Th>
              </tr>
            </thead>
            <tbody>
              {detail.wallets.map((w) => (
                <Tr key={w.walletId}>
                  <Td>
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-fg">{w.name}</span>
                      {w.frozen && <Tag tone="warn">Frozen</Tag>}
                    </span>
                  </Td>
                  <Td align="right" mono>
                    {w.near === null ? '—' : formatNumber(w.near, 0, 4)}
                  </Td>
                  <Td align="right" mono>
                    {w.tokens === null ? '—' : formatNumber(w.tokens, 0, 4)}
                  </Td>
                  <Td align="right" mono>
                    {w.exposurePct === null ? '—' : formatPct(w.exposurePct, { decimals: 1 })}
                  </Td>
                  <Td align="right" mono className={tone(w.pnlNear)}>
                    {signedNear(w.pnlNear).replace(' NEAR', '')}
                  </Td>
                  <Td align="right" mono>
                    {w.trades}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </div>
        <ul className="divide-y divide-line-soft @[40rem]:hidden" aria-label="The bot’s wallets">
          {detail.wallets.map((w) => (
            <li key={w.walletId} className="flex flex-col gap-2 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="truncate text-sm text-fg">{w.name}</span>
                <span className={cn('num text-sm', tone(w.pnlNear))}>{signedNear(w.pnlNear)}</span>
              </div>
              <dl className="grid grid-cols-3 gap-2 text-xs">
                <div>
                  <dt className="legend">NEAR</dt>
                  <dd className="num mt-0.5 text-fg-2">{w.near === null ? '—' : formatNumber(w.near, 0, 4)}</dd>
                </div>
                <div>
                  <dt className="legend">{symbol}</dt>
                  <dd className="num mt-0.5 truncate text-fg-2">{w.tokens === null ? '—' : formatNumber(w.tokens, 0, 4)}</dd>
                </div>
                <div className="text-right">
                  <dt className="legend">Trades</dt>
                  <dd className="num mt-0.5 text-fg-2">{w.trades}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  )
}

function Trades({ detail }: { detail: BotDetail }) {
  const caps = useCapabilities()
  const names = new Map(detail.wallets.map((w) => [w.walletId, w.name]))
  const symbol = detail.bot.symbol
  if (detail.trades.length === 0)
    return (
      <Panel>
        <PanelHeader title="Trades" />
        <EmptyState title="No trades yet">Each trade the bot sends shows here with its fill, price and transaction, once the chain confirms it.</EmptyState>
      </Panel>
    )
  const status = (s: string) => (s === 'confirmed' ? <Tag tone="neutral">Confirmed</Tag> : s === 'failed' ? <Tag tone="neg">Failed</Tag> : <Tag tone="warn">Settling</Tag>)
  const explorerUrl = caps.explorerUrl
  const tx = (hash: string | null) =>
    hash && explorerUrl ? (
      <a
        href={explorerTxUrl({ explorerUrl }, hash)}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex items-center gap-1 text-fg-3 hover:text-fg"
        aria-label="Transaction on the explorer"
      >
        <ExternalLink size={13} />
      </a>
    ) : null
  return (
    <Panel>
      <PanelHeader title="Trades" meta={detail.trades.length} />
      <div className="@container">
        <div className="hidden @[46rem]:block">
          <Table label="The bot’s trades">
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>Side</Th>
                <Th>Wallet</Th>
                <Th align="right">NEAR</Th>
                <Th align="right">{symbol}</Th>
                <Th align="right">Price</Th>
                <Th>Status</Th>
                <Th align="right">
                  <span className="sr-only">Transaction</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {detail.trades.map((t) => (
                <Tr key={t.id}>
                  <Td mono className="text-fg-3">
                    {formatDateTime(t.at)}
                  </Td>
                  <Td className={t.side === 'buy' ? 'text-pos' : 'text-neg'}>{t.side === 'buy' ? 'Buy' : 'Sell'}</Td>
                  <Td className="text-fg-2">{names.get(t.walletId) ?? '—'}</Td>
                  <Td align="right" mono>
                    {t.status === 'submitted' ? '—' : formatNumber(t.near, 0, 4)}
                  </Td>
                  <Td align="right" mono>
                    {t.status === 'submitted' ? '—' : formatNumber(t.tokens, 0, 4)}
                  </Td>
                  <Td align="right" mono>
                    {t.priceNear === null ? '—' : formatNumber(t.priceNear, 0, 8)}
                  </Td>
                  <Td title={t.message ?? undefined}>{status(t.status)}</Td>
                  <Td align="right">{tx(t.txHash)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </div>
        <ul className="divide-y divide-line-soft @[46rem]:hidden" aria-label="The bot’s trades">
          {detail.trades.map((t) => (
            <li key={t.id} className="flex flex-col gap-1.5 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-sm">
                  <span className={t.side === 'buy' ? 'text-pos' : 'text-neg'}>{t.side === 'buy' ? 'Buy' : 'Sell'}</span>
                  <span className="truncate text-fg-3">{names.get(t.walletId) ?? '—'}</span>
                </span>
                <span className="flex items-center gap-2">
                  {status(t.status)}
                  {tx(t.txHash)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 text-xs text-fg-2">
                <span className="num">{t.status === 'submitted' ? 'Settling…' : `${formatNumber(t.near, 0, 4)} NEAR · ${formatNumber(t.tokens, 0, 4)} ${symbol}`}</span>
                <span className="num text-fg-3">{formatClock(t.at)}</span>
              </div>
              {t.message && t.status === 'failed' && <p className="text-xs text-fg-3">{t.message}</p>}
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  )
}

function Activity({ detail }: { detail: BotDetail }) {
  return (
    <Panel>
      <PanelHeader title="Log" meta={detail.events.length} />
      {detail.events.length === 0 ? (
        <p className="p-4 text-sm text-fg-3">Starts, pauses, guardian decisions and stops are recorded here.</p>
      ) : (
        <ol className="max-h-80 divide-y divide-line-soft overflow-y-auto" aria-label="The bot’s log">
          {detail.events.map((e) => (
            <li key={e.id} className="flex flex-col gap-0.5 px-4 py-2">
              <span className="flex items-center justify-between gap-3 text-xs">
                <span className={cn('legend', e.kind === 'guardian' && 'text-warn')}>
                  {e.kind === 'guardian' && e.code ? (GUARDIAN_LABEL[e.code as GuardianCode] ?? e.kind) : e.kind.replace('-', ' ')}
                </span>
                <span className="num text-fg-4">{formatDateTime(e.at)}</span>
              </span>
              <span className="text-sm text-fg-2">
                <Figures>{e.message}</Figures>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  )
}

/** Confirmation before something consequential: starting real trading, an emergency stop, deleting. */
type Confirm = 'start' | 'emergency' | 'delete' | null

function BotHead({ detail, onEdit, onDeleted }: { detail: BotDetail; onEdit: () => void; onDeleted: () => void }) {
  const toast = useToast()
  const caps = useCapabilities()
  const m = useVolumeBotMutations()
  const [confirm, setConfirm] = useState<Confirm>(null)
  const { bot, config } = detail
  const lamp = statusLamp(bot)
  const controls = controlsFor(bot.status)
  const guardian = bot.status === 'paused' && bot.pauseCode && bot.pauseCode !== 'owner'
  const failed = (title: string) => (e: unknown) => toast.push({ tone: 'neg', title, detail: e instanceof Error ? e.message : undefined })
  const pending = m.start.isPending || m.pause.isPending || m.resume.isPending || m.stop.isPending || m.remove.isPending

  const start = () =>
    m.start.mutate(bot.id, {
      onSuccess: () => {
        setConfirm(null)
        toast.push({ tone: 'accent', title: `${bot.symbol} bot started`, detail: 'NEARKITS told you in Telegram too. Pause or stop it here or with /volume.' })
      },
      onError: (e) => {
        setConfirm(null)
        failed('The bot didn’t start')(e)
      },
    })
  const stop = (emergency: boolean) =>
    m.stop.mutate(
      { botId: bot.id, emergency },
      {
        onSuccess: () => {
          setConfirm(null)
          toast.push({ title: emergency ? 'Emergency stop: nothing new is sent' : 'Stopping', detail: 'A trade already sent settles and is recorded, then the bot ends stopped.' })
        },
        onError: failed('The bot didn’t stop'),
      },
    )

  return (
    <Panel>
      <div className="flex flex-col gap-4 p-4 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <TokenGlyph symbol={bot.symbol} tokenId={bot.token} size={32} />
          <div className="min-w-0">
            <h2 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-lg font-semibold text-fg">
              <span className="truncate">{bot.symbol}</span>
              <span className="text-fg-3">·</span>
              <span className="text-fg-2">{STRATEGY[bot.strategy].label}</span>
            </h2>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-fg-2">
              <Led tone={lamp.tone} size={8} />
              <span>{lamp.label}</span>
              <span className="text-fg-4">·</span>
              <span className="text-fg-3">
                <Figures>{`${config.walletIds.length} wallet${config.walletIds.length === 1 ? '' : 's'}`}</Figures>
              </span>
            </p>
            {bot.status === 'running' && bot.waiting && (
              <p className="mt-1 text-xs text-fg-3">
                <Figures>{`Now: ${bot.waiting}`}</Figures>
              </p>
            )}
          </div>
        </div>
        {controls.length > 0 && (
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
            {controls.includes('start') && (
              <Button variant="primary" onClick={() => setConfirm('start')} disabled={pending}>
                <Play size={14} /> Start
              </Button>
            )}
            {controls.includes('resume') && (
              <Button variant="primary" loading={m.resume.isPending} disabled={pending} onClick={() => m.resume.mutate(bot.id, { onError: failed('The bot didn’t resume') })}>
                <Play size={14} /> Resume
              </Button>
            )}
            {controls.includes('pause') && (
              <Button variant="secondary" loading={m.pause.isPending} disabled={pending} onClick={() => m.pause.mutate(bot.id, { onError: failed('The bot didn’t pause') })}>
                <Pause size={14} /> Pause
              </Button>
            )}
            {controls.includes('stop') && (
              <Button variant="secondary" loading={m.stop.isPending && m.stop.variables?.emergency === false} disabled={pending} onClick={() => stop(false)}>
                <Square size={14} /> Stop
              </Button>
            )}
            {controls.includes('emergency') && (
              <Button variant="danger" className="col-span-2 sm:col-span-1" disabled={pending} onClick={() => setConfirm('emergency')}>
                <OctagonX size={14} /> Emergency stop
              </Button>
            )}
            {controls.includes('edit') && (
              <Button variant="secondary" disabled={pending} onClick={onEdit}>
                <Pencil size={14} /> Edit
              </Button>
            )}
            {controls.includes('delete') && (
              <Button variant="danger" disabled={pending} onClick={() => setConfirm('delete')}>
                <Trash2 size={14} /> Delete
              </Button>
            )}
          </div>
        )}
      </div>
      {bot.status === 'paused' && bot.pauseReason && (
        <div className={cn('mx-4 mb-4 rounded-md border px-3 py-2 text-sm', guardian ? 'border-warn/35 bg-warn/10 text-warn' : 'border-line text-fg-2')} role="status">
          <Figures>{guardian ? `${bot.pauseReason}. Check the market and its wallets, then resume it, or stop it.` : bot.pauseReason}</Figures>
        </div>
      )}
      {bot.status === 'stopping' && (
        <p className="mx-4 mb-4 rounded-md border border-line px-3 py-2 text-sm text-fg-2" role="status">
          Stopping: nothing new is sent. A trade already sent settles and is recorded, then the bot ends stopped.
        </p>
      )}

      <Modal
        open={confirm === 'start'}
        onClose={() => setConfirm(null)}
        title={`Start the ${bot.symbol} bot?`}
        description="It trades from your NEARKITS wallets until you pause or stop it, its own limits end it, or the guardian pauses it."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button variant="primary" loading={m.start.isPending} onClick={start}>
              Start bot
            </Button>
          </>
        }
      >
        <Lines>
          <Line label="Network">
            <Tag tone={caps.network === 'mainnet' ? 'warn' : 'neutral'}>{caps.networkLabel}</Tag>
          </Line>
          <Line label="Strategy">{STRATEGY[bot.strategy].label}</Line>
          <Line label="Wallets">{String(config.walletIds.length)}</Line>
          <Line label="Largest trade">{near(config.risk.maxTradeNear, 2)}</Line>
          <Line label="Daily loss limit">{near(config.risk.maxDailyLossNear, 2)}</Line>
          {bot.strategy === 'market-maker' && <Line label="Edge over fair value">{`${config.marketMaker.minEdgeBps / 100}%`}</Line>}
        </Lines>
        <p className="mt-3 text-xs leading-5 text-fg-3">
          Each trade goes through the same checks, route and NEARKITS fee as a manual one. Prices move: a bot can lose money, and past fills say nothing about the next.
        </p>
      </Modal>

      <Modal
        open={confirm === 'emergency'}
        onClose={() => setConfirm(null)}
        size="sm"
        title="Emergency stop?"
        description="Nothing new is sent from this moment. A trade already on chain can’t be recalled: it settles and is recorded, then the bot ends stopped."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button variant="danger" loading={m.stop.isPending} onClick={() => stop(true)}>
              Emergency stop
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-2">The tokens it holds stay in its wallets. Nothing is sold to unwind them.</p>
      </Modal>

      <Modal
        open={confirm === 'delete'}
        onClose={() => setConfirm(null)}
        size="sm"
        title={`Delete the ${bot.symbol} bot?`}
        description="Its configuration and its own log go. The trades it made stay in your wallets’ history and on chain."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={m.remove.isPending}
              onClick={() =>
                m.remove.mutate(bot.id, {
                  onSuccess: () => {
                    setConfirm(null)
                    toast.push({ title: 'Volume Bot deleted' })
                    onDeleted()
                  },
                  onError: failed('The bot wasn’t deleted'),
                })
              }
            >
              Delete bot
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-2">Wallets and balances are untouched.</p>
      </Modal>
    </Panel>
  )
}

export function BotConsole({ botId, onEdit, onDeleted }: { botId: string; onEdit: (detail: BotDetail) => void; onDeleted: () => void }) {
  const detail = useVolumeBot(botId)
  const now = useNow(5_000)
  if (detail.isPending)
    return (
      <Panel className="p-5">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="mt-3 h-4 w-80" />
        <Skeleton className="mt-6 h-40 w-full" />
      </Panel>
    )
  if (detail.isError || !detail.data)
    return (
      <Panel>
        <EmptyState title="The bot couldn’t be read">
          <Figures>{detail.error instanceof Error ? detail.error.message : 'Try again in a moment.'}</Figures>
        </EmptyState>
      </Panel>
    )
  const d = detail.data
  return (
    <div className="flex flex-col gap-4">
      <BotHead detail={d} onEdit={() => onEdit(d)} onDeleted={onDeleted} />
      <Readouts detail={d} now={now} />
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Charts detail={d} />
          <Wallets detail={d} />
          <Trades detail={d} />
        </div>
        <aside className="flex min-w-0 flex-col gap-4">
          <MarketPanel detail={d} now={now} />
          <RiskPanel detail={d} />
          <Activity detail={d} />
        </aside>
      </div>
    </div>
  )
}
