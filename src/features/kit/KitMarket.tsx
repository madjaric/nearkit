import { useId, type ReactNode } from 'react'
import { CopyButton } from '@/components/ui/Copy'
import { Led } from '@/components/ui/Indicators'
import { Pct } from '@/components/ui/Num'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { KIT, KITS_CONTRACT } from '@/config/kit'
import { cn } from '@/lib/cn'
import { formatAgo, formatPrice, formatUsdCompact } from '@/lib/format'
import { useNow } from '@/lib/hooks'
import type { MarketFigure, PriceHistory, TokenMarket } from '@/types/domain'

/**
 * $KITS' market in one compact terminal block: its price in NEAR (its pool is KITS/wNEAR) and 24h
 * change, a seven-day trace of the real candle closes when the source has them, and the market
 * figures each from the source that reports it (or why one is missing), the supply after burns from
 * the chain, the contract and the status. Nothing here is estimated or filled in.
 */

const known = (f: MarketFigure | undefined): number | null => (f && (f.state === 'known' || f.state === 'stale') ? f.value : null)

/** The value of a figure, or a dash whose title says why there is none. */
function Value({ figure, format }: { figure: MarketFigure | undefined; format: (v: number) => string }) {
  const v = known(figure)
  if (v !== null) return <span className={cn('num text-fg', figure?.state === 'stale' && 'text-warn')}>{format(v)}</span>
  return (
    <span className="text-fg-4" title={figure && 'reason' in figure ? figure.reason : undefined}>
      —
    </span>
  )
}

function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-4 py-2">
      <dt className="text-xs text-fg-3" title={hint}>
        {label}
      </dt>
      <dd className="min-w-0 truncate text-right text-sm">{children}</dd>
    </div>
  )
}

/** Real candle closes as a small trace; fewer than two draws nothing (no line through one price). */
function Trace({ history }: { history: PriceHistory }) {
  const id = useId()
  const values = history.points.map((p) => p.usd).filter((v) => Number.isFinite(v) && v > 0)
  if (values.length < 2) return null
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo || hi || 1
  const y = (v: number) => 4 + (1 - (v - lo) / span) * 52
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * 1000).toFixed(1)},${y(v).toFixed(2)}`).join('')
  return (
    <figure className="flex flex-col gap-1 px-4 pb-3">
      <div className="relative h-14">
        <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 1000 60" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--color-accent)" stopOpacity="0.18" />
              <stop offset="1" stopColor="var(--color-accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`${line} L1000,60 L0,60 Z`} fill={`url(#${id})`} />
          <path d={line} fill="none" className="stroke-accent" strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
      <figcaption className="flex justify-between gap-2 text-[10.5px] text-fg-3">
        <span>{`7 days · ${history.source.name}`}</span>
        <span className="num">{`$${formatPrice(lo)} – $${formatPrice(hi)}`}</span>
      </figcaption>
    </figure>
  )
}

export function KitMarket({
  onNetwork,
  market,
  history,
  supplyNow,
  className,
}: {
  onNetwork: boolean
  market: TokenMarket | null | undefined
  history: PriceHistory | null | undefined
  /** Whole KITS after burns, from the chain (the burn reading); null without one. */
  supplyNow: string | null
  className?: string
}) {
  const now = useNow(15_000)
  const priceNear = known(market?.priceNear)
  const pair = market?.pair ? `${market.pair.baseSymbol}/${market.pair.quoteSymbol} on ${market.pair.dex}` : null
  return (
    <Panel aria-labelledby="kit-market" className={cn('flex flex-col', className)}>
      <PanelHeader id="kit-market" title="KITS / NEAR" meta={pair ?? undefined} />
      {onNetwork ? (
        <>
          <div className="flex items-baseline justify-between gap-3 px-4 pb-2 pt-3">
            <p className="flex items-baseline gap-2">
              <span className={cn('num text-2xl leading-8', priceNear !== null ? 'text-fg' : 'text-fg-4')}>{priceNear !== null ? formatPrice(priceNear) : '—'}</span>
              <span className="text-xs text-fg-3">NEAR</span>
            </p>
            {known(market?.change24hPct) !== null && (
              <span className="flex items-baseline gap-1.5 text-xs">
                <Pct value={known(market?.change24hPct)} /> <span className="text-fg-3">24h</span>
              </span>
            )}
          </div>
          {history && <Trace history={history} />}
          <dl className="divide-y divide-line-soft border-t border-line-soft">
            <Row label="Market cap">
              <Value figure={market?.marketCapUsd} format={(v) => formatUsdCompact(v, 2)} />
            </Row>
            <Row label="FDV" hint="Fully diluted value: total supply × price">
              <Value figure={market?.fdvUsd} format={(v) => formatUsdCompact(v, 2)} />
            </Row>
            <Row label="Liquidity">
              <Value figure={market?.liquidityUsd} format={(v) => formatUsdCompact(v, 2)} />
            </Row>
            <Row label="24h volume">
              <Value figure={market?.volume24hUsd} format={(v) => formatUsdCompact(v, 2)} />
            </Row>
            <Row label="Supply now" hint="ft_total_supply on NEAR, after burns">
              {supplyNow ? (
                <span className="num text-fg">
                  {supplyNow} <span className="font-sans text-xs text-fg-3">KITS</span>
                </span>
              ) : (
                <span className="text-fg-4">—</span>
              )}
            </Row>
            <Row label="Contract">
              <span className="flex items-center justify-end gap-1">
                <span className="num truncate text-xs text-fg-2">{KITS_CONTRACT}</span>
                <CopyButton value={KITS_CONTRACT} label={`Copy the ${KIT.ticker} contract`} />
              </span>
            </Row>
            <Row label="Launch venue">
              <span className="text-fg-2">{KIT.launchVenue}</span>
            </Row>
            <Row label="Status">
              <span className="inline-flex items-center gap-1.5 text-fg">
                <Led tone="on" /> Live
              </span>
            </Row>
          </dl>
          <p className="mt-auto border-t border-line-soft px-4 py-2.5 text-[11px] text-fg-3">
            {market ? `Market figures from their sources, updated ${formatAgo(market.updatedAt, now)}; supply from NEAR.` : 'Reading the market…'}
          </p>
        </>
      ) : (
        <p className="p-4 text-sm text-fg-3">{`This build reads no ${KIT.ticker} market: its price, supply and liquidity are on NEAR mainnet.`}</p>
      )}
    </Panel>
  )
}
