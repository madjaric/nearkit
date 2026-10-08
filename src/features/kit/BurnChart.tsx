import { useId, useState, type PointerEvent } from 'react'
import { VIEW_W, nearestAt, pct, pointerFrac } from '@/components/chart/geometry'
import { niceTicks } from '@/components/chart/scale'
import { Graticule, XLabels } from '@/components/chart/ScopeParts'
import { NETWORKS } from '@/config/networks'
import { cn } from '@/lib/cn'
import { formatCompact, formatDateTime, truncateMiddle } from '@/lib/format'
import { explorerTxUrl } from '@/services/near/explorer'
import type { BurnSeries, BurnStep } from './burnSeries'

/**
 * KITS burned in all, over time: a step trace that rises at each verified burn and holds level
 * between them, on the app's scope graticule, over a faint lime fill. Each burn is a marker you can
 * point at or tab to (it opens the transaction on NearBlocks); its readout names the moment, the
 * amount, the running total and the source. Only real burns are drawn: nothing between two of them
 * is invented. The trace draws itself in once.
 */

/** Plot insets, px: room for the value axis at the right and the time axis under it. */
const INSET = { top: 18, right: 58, bottom: 26, left: 0 }
/** A little room before the first burn, so its step reads as a step (the total there is 0). */
const LEAD = 0.035

const SOURCE: Record<BurnStep['kind'], string> = { tax: 'Tax · Buyback & Burn', other: 'Burn' }

export function BurnChart({ series, className }: { series: BurnSeries; className?: string }) {
  const id = useId()
  const [active, setActive] = useState<number | null>(null)
  const { steps } = series
  const span = Math.max(1, series.end - series.start)
  const start = series.start - span * LEAD
  const total = series.end - start
  const fracOf = (t: number) => (t - start) / total
  const fracs = steps.map((s) => fracOf(s.at))

  // Round ticks can stop short of the total (3.49M → 0…3M); one more step keeps every burn on the plot.
  const ticks = niceTicks(0, series.max, 4)
  const top = ticks[ticks.length - 1] ?? series.max
  if (ticks.length > 1 && top < series.max) ticks.push(Number((top + (ticks[1] ?? 0) - (ticks[0] ?? 0)).toPrecision(12)))
  const hi = Math.max(ticks[ticks.length - 1] ?? 0, series.max)
  /** A value as a percentage of the plot's height, from the top. */
  const yPct = (v: number) => (1 - v / (hi || 1)) * 100
  const x = (f: number) => (f * VIEW_W).toFixed(2)

  // Step-after: flat at the previous total until the burn, then straight up to the new total.
  let d = `M${x(0)},${yPct(0).toFixed(3)}`
  for (const [i, s] of steps.entries()) d += ` H${x(fracs[i] ?? 0)} V${yPct(s.cumulative).toFixed(3)}`
  d += ` H${x(1)}`
  const area = `${d} V${yPct(0).toFixed(3)} H${x(0)} Z`

  const first = steps[0] as BurnStep
  const last = steps[steps.length - 1] as BurnStep
  const axis = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ frac: f, text: formatDateTime(start + f * total) }))
  const shown = active !== null ? steps[active] : undefined
  const shownFrac = active !== null ? (fracs[active] ?? 0) : 0

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => setActive(nearestAt(fracs, pointerFrac(e.clientX, e.currentTarget)))

  return (
    <div className={cn('relative select-none', className)}>
      <div
        role="img"
        aria-label={`KITS burned over time: ${steps.length} verified burn${steps.length === 1 ? '' : 's'} from ${formatDateTime(first.at)} to ${formatDateTime(last.at)}, ${last.cumulativeText} KITS in all.`}
        className="absolute cursor-crosshair touch-none"
        style={INSET}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setActive(null)}
      >
        {/* The graticule measures in pixels; the trace and markers scale with the box (percent of its height). */}
        <div className="absolute inset-0" aria-hidden="true">
          <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox={`0 0 ${VIEW_W} 100`} preserveAspectRatio="none">
            {ticks.map((t) => (
              <line key={t} x1={0} x2={VIEW_W} y1={yPct(t)} y2={yPct(t)} className={t === 0 ? 'stroke-line-strong' : 'stroke-line-soft'} vectorEffect="non-scaling-stroke" />
            ))}
          </svg>
          <Graticule height={100} tickYs={[]} baselineY={100} />
        </div>
        <div className="absolute inset-0 animate-reveal" aria-hidden="true">
          <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox={`0 0 ${VIEW_W} 100`} preserveAspectRatio="none">
            <defs>
              <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.2} />
                <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <path d={area} fill={`url(#${id}-fill)`} stroke="none" />
            <path d={d} fill="none" className="stroke-accent" strokeWidth={2} strokeLinejoin="miter" vectorEffect="non-scaling-stroke" />
          </svg>
        </div>

        {active !== null && <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 z-[1] w-px -translate-x-1/2 bg-fg-4" style={{ left: pct(shownFrac) }} />}

        {/* Each burn: a marker (a link to its transaction) sitting on the step it made. */}
        {steps.map((s, i) => (
          <a
            key={s.tx}
            href={explorerTxUrl(NETWORKS.mainnet, s.tx)}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={`Burn of ${s.amountText} KITS on ${formatDateTime(s.at)}, ${s.cumulativeText} KITS burned in all. Open the transaction on NearBlocks.`}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
            className="group absolute z-[2] grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full outline-none"
            style={{ left: pct(fracs[i] ?? 0), top: `${yPct(s.cumulative)}%` }}
          >
            <span
              className={cn(
                'size-2.5 rounded-full ring-2 ring-panel transition-transform duration-150',
                active === i ? 'scale-125 bg-accent-hi' : 'bg-accent',
                'group-focus-visible:ring-accent/40',
              )}
            />
          </a>
        ))}

        {shown && (
          <div
            role="status"
            className="pointer-events-none absolute top-1 z-10 w-max max-w-[15rem] rounded-sm border border-line bg-raised px-3 py-2 shadow-pop"
            style={shownFrac > 0.6 ? { right: `calc(${pct(1 - shownFrac)} + 14px)` } : { left: `calc(${pct(shownFrac)} + 14px)` }}
          >
            <p className="num text-[11px] text-fg-3">{formatDateTime(shown.at)}</p>
            <p className="mt-1 text-sm text-fg">
              <span className="num">−{shown.amountText}</span> <span className="text-xs text-fg-3">KITS burned</span>
            </p>
            <p className="text-[11px] text-fg-3">
              Total <span className="num text-fg-2">{shown.cumulativeText}</span> KITS
            </p>
            <p className="mt-1 flex items-center justify-between gap-3 text-[11px] text-fg-3">
              <span>{SOURCE[shown.kind]}</span>
              <span className="num text-fg-2">{truncateMiddle(shown.tx, 5, 4)}</span>
            </p>
          </div>
        )}
      </div>

      <div className="pointer-events-none absolute" style={INSET} aria-hidden="true">
        {ticks.map((t) => (
          <span
            key={t}
            className={cn('num absolute left-full ml-2 -translate-y-1/2 whitespace-nowrap text-[10.5px] leading-none', t === 0 ? 'text-fg-2' : 'text-fg-3')}
            style={{ top: `${yPct(t)}%` }}
          >
            {t === 0 ? '0' : formatCompact(t, 1)}
          </span>
        ))}
        <XLabels items={axis} />
      </div>
    </div>
  )
}
