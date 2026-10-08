import { useId, useRef, useState, type PointerEvent } from 'react'
import { cn } from '@/lib/cn'
import { formatClock, formatDate, formatPct, USD_FORMAT, type MoneyFormat } from '@/lib/format'
import { bucketLabel, bucketWord } from '@/lib/pnlPeriod'
import { toneOf } from '@/lib/tone'
import type { PnlPoint } from '@/types/domain'
import { DailyBars } from './DailyBars'
import { VIEW_W, linePathAt, nearestAt, pointerFrac, xFracs, yScale } from './geometry'
import { niceTicks } from './scale'
import { CursorHandle, Dot, Graticule, HoverReadout, VLine, XLabels, YLabels } from './ScopeParts'
import { useCursors } from './useCursors'

const PAD = { top: 26, right: 64, bottom: 24, left: 4 }
const DAY = 86_400_000

interface PnlScopeProps {
  points: PnlPoint[]
  /** Each point's bucket (an hour, six hours, a day). */
  bucketMs: number
  /** The period in words, for the empty state: "the last 24 hours". */
  periodName: string
  height?: number
  dim?: boolean
  /** Units of the figures (USD unless the report is in NEAR). */
  money?: MoneyFormat
}

/**
 * Cumulative realized PnL over the selected period, from 0 at its start: green where the total is
 * above zero, red below, over a soft fill to the zero line, on the app's scope graticule. Two
 * measurement cursors read the PnL between any two points (drag A and B, or focus a handle and use
 * the arrow keys); the hover readout names the exact bucket. With nothing realized in the period it
 * draws the zero line and says so, rather than an empty frame.
 */
export function PnlScope({ points, bucketMs, periodName, height = 280, dim = false, money = USD_FORMAT }: PnlScopeProps) {
  const n = points.length
  const plotRef = useRef<HTMLDivElement>(null)
  const fracs = xFracs(
    points.map((p) => p.end),
    true,
  )
  const cursors = useCursors(n, [0, n - 1], plotRef, fracs)
  const [hover, setHover] = useState<number | null>(null)
  const id = useId()
  const plotH = height - PAD.top - PAD.bottom
  const flat = points.every((p) => p.cumulative === 0)

  const values = points.map((p) => p.cumulative)
  // Small totals get a small scale: the line moves however small the figures are.
  const ticks = flat ? [-1, 0, 1] : niceTicks(Math.min(0, ...values), Math.max(0, ...values), 4)
  const lo = ticks[0] ?? 0
  const hi = ticks[ticks.length - 1] ?? 1
  const y = yScale([lo, hi], plotH)
  const zero = y(0)
  const path = linePathAt(fracs, values, y)
  const area = `${path} L${((fracs[n - 1] ?? 1) * VIEW_W).toFixed(2)},${zero.toFixed(2)} L${((fracs[0] ?? 0) * VIEW_W).toFixed(2)},${zero.toFixed(2)} Z`

  const { a, b } = cursors
  const pa = points[a]
  const pb = points[b]
  const from = Math.min(a, b)
  const to = Math.max(a, b)
  const delta = pa && pb ? pb.cumulative - pa.cumulative : 0
  const between = points.slice(from + 1, to + 1)
  const volume = between.reduce((s, p) => s + p.volumeUsd, 0)
  const returnOnVolume = volume > 0 ? (delta / volume) * 100 : null
  const best = between.reduce<PnlPoint | null>((m, p) => (m === null || p.booked > m.booked ? p : m), null)
  const spanMs = pa && pb ? Math.abs(pb.end - pa.end) : 0
  const hp = hover !== null ? points[hover] : undefined
  const inset = { top: PAD.top, bottom: PAD.bottom, left: PAD.left, right: PAD.right }

  const t0 = points[0]?.end ?? 0
  const t1 = points[n - 1]?.end ?? 0
  const short = t1 - t0 <= 36 * 3_600_000
  const axis = n > 1 ? [0, 0.25, 0.5, 0.75, 1].map((f) => ({ frac: f, text: short ? formatClock(t0 + f * (t1 - t0)) : formatDate(t0 + f * (t1 - t0)) })) : []
  const span = (ms: number) => (ms >= 2 * DAY ? `${Math.round(ms / DAY)}d` : ms >= 3_600_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.max(0, Math.round(ms / 60_000))}m`)

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (cursors.dragTo(e)) {
      setHover(null)
      return
    }
    setHover(nearestAt(fracs, pointerFrac(e.clientX, e.currentTarget)))
  }

  const word = bucketWord(bucketMs)
  const last = points[n - 1]

  return (
    <div className={cn('flex flex-col gap-4', dim && 'opacity-50 transition-opacity')}>
      <div className="relative select-none" style={{ height }}>
        <div
          ref={plotRef}
          data-plot
          role="img"
          aria-label={
            flat
              ? `No realized PnL in ${periodName}.`
              : `Cumulative realized PnL in ${periodName}, ${n - 1} points of one ${word} each, from 0 to ${money.full(last?.cumulative ?? 0, { signed: true })}.`
          }
          className={cn('absolute touch-none', flat ? 'cursor-default' : 'cursor-crosshair')}
          style={inset}
          onPointerDown={flat ? undefined : cursors.plotHandlers.onPointerDown}
          onPointerUp={flat ? undefined : cursors.plotHandlers.onPointerUp}
          onPointerCancel={flat ? undefined : cursors.plotHandlers.onPointerUp}
          onPointerMove={flat ? undefined : onPointerMove}
          onPointerLeave={() => setHover(null)}
        >
          <Graticule height={plotH} tickYs={ticks.map(y)} baselineY={zero} strongY={zero} />
          {n > 1 && !flat && (
            <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox={`0 0 ${VIEW_W} ${plotH}`} preserveAspectRatio="none" aria-hidden="true">
              <defs>
                {/* Above zero green, below red; on the zero line itself (nothing realized) neutral. */}
                <clipPath id={`${id}-up`}>
                  <rect x={0} y={-10} width={VIEW_W} height={Math.max(0, zero + 10 - 1.5)} />
                </clipPath>
                <clipPath id={`${id}-down`}>
                  <rect x={0} y={zero + 1.5} width={VIEW_W} height={Math.max(0, plotH - zero) + 10} />
                </clipPath>
                <clipPath id={`${id}-zero`}>
                  <rect x={0} y={zero - 1.5} width={VIEW_W} height={3} />
                </clipPath>
                <linearGradient id={`${id}-fill-up`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-chart-pos)" stopOpacity={0.22} />
                  <stop offset="100%" stopColor="var(--color-chart-pos)" stopOpacity={0.02} />
                </linearGradient>
                <linearGradient id={`${id}-fill-down`} x1="0" y1="1" x2="0" y2="0">
                  <stop offset="0%" stopColor="var(--color-chart-neg)" stopOpacity={0.22} />
                  <stop offset="100%" stopColor="var(--color-chart-neg)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <rect
                x={fracs[from] !== undefined ? (fracs[from] ?? 0) * VIEW_W : 0}
                y={0}
                width={((fracs[to] ?? 0) - (fracs[from] ?? 0)) * VIEW_W}
                height={plotH}
                className="fill-fg/[0.03]"
              />
              <path d={area} clipPath={`url(#${id}-up)`} fill={`url(#${id}-fill-up)`} stroke="none" />
              <path d={area} clipPath={`url(#${id}-down)`} fill={`url(#${id}-fill-down)`} stroke="none" />
              <path
                d={path}
                clipPath={`url(#${id}-up)`}
                fill="none"
                className="stroke-chart-pos"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
              <path
                d={path}
                clipPath={`url(#${id}-down)`}
                fill="none"
                className="stroke-chart-neg"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
              <path
                d={path}
                clipPath={`url(#${id}-zero)`}
                fill="none"
                className="stroke-fg-3"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          )}
          {flat && (
            <div className="absolute inset-x-0 flex justify-center" style={{ top: Math.max(0, zero - 34) }}>
              <p className="rounded-sm border border-line bg-panel px-3 py-1.5 text-xs text-fg-3">{`No realized PnL in ${periodName}: nothing was sold at a known result.`}</p>
            </div>
          )}
          {hp && hover !== null && !flat && (
            <>
              <VLine frac={fracs[hover] ?? 0} className="bg-fg-4" />
              <Dot frac={fracs[hover] ?? 0} y={y(hp.cumulative)} tone="fg" />
              <HoverReadout frac={fracs[hover] ?? 0}>
                <div className={cn('num text-sm', toneOf(hp.cumulative))}>{money.full(hp.cumulative, { signed: true })}</div>
                <div className="text-[11px] text-fg-3">{bucketLabel(hp, bucketMs)}</div>
                {hp.end !== hp.t && (
                  <div className="text-[11px] text-fg-3">
                    {`This ${word}: `}
                    <span className={cn('num', hp.booked === 0 ? 'text-fg-4' : toneOf(hp.booked))}>
                      {hp.booked === 0 ? 'nothing closed' : money.full(hp.booked, { signed: true })}
                    </span>
                  </div>
                )}
              </HoverReadout>
            </>
          )}
        </div>

        <div className="pointer-events-none absolute" style={inset}>
          <div aria-hidden="true">
            <YLabels ticks={flat ? [0] : ticks} y={y} format={(t) => (t === 0 ? '0' : money.compact(t, 1))} strong={0} />
            <XLabels items={axis} />
          </div>
          {!flat &&
            (['a', 'b'] as const).map((key) => {
              const index = key === 'a' ? a : b
              const p = points[index]
              if (!p) return null
              return (
                <div key={key}>
                  <VLine frac={fracs[index] ?? 0} className="bg-fg-3/70" />
                  <Dot frac={fracs[index] ?? 0} y={y(p.cumulative)} tone="fg" />
                  <div className="pointer-events-auto">
                    <CursorHandle
                      id={key}
                      frac={fracs[index] ?? 0}
                      index={index}
                      max={n - 1}
                      valueText={`${bucketLabel(p, bucketMs)}: ${money.full(p.cumulative, { signed: true })}`}
                      onKeyDown={cursors.handleKeys(key)}
                      onPointerDown={cursors.grab(key)}
                    />
                  </div>
                </div>
              )
            })}
        </div>
      </div>

      {!flat && (
        <>
          <div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-1">
              <span className="legend">{`Realized per ${word}`}</span>
              <span aria-hidden="true" className="h-px min-w-8 flex-1 bg-line-soft" />
              <span className="text-[11px] text-fg-3">Outside A–B dimmed</span>
            </div>
            <DailyBars points={points} fracs={fracs} window={[a, b]} money={money} label={(p) => bucketLabel(p, bucketMs)} word={word} />
          </div>
          {/* The A–B measurement, in one line: what was realized between the cursors, on what volume, over how long. */}
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line-soft sm:grid-cols-4" aria-label="Between cursors A and B">
            {[
              {
                k: 'Δ PnL (B − A)',
                v: <span className={toneOf(delta)}>{money.full(delta, { signed: true })}</span>,
                s: pa && pb ? `${bucketLabel(pa, bucketMs)} → ${bucketLabel(pb, bucketMs)}` : '',
              },
              {
                k: 'Δ % of volume',
                v: <span className={toneOf(returnOnVolume ?? 0)}>{returnOnVolume === null ? '—' : formatPct(returnOnVolume)}</span>,
                s: volume > 0 ? `on ${money.compact(volume, 1)} traded` : 'no trades between',
              },
              { k: 'Δ time', v: span(spanMs), s: from === to ? 'same point' : `${to - from} × ${word}` },
              {
                k: `Best ${word}`,
                v: best && best.booked > 0 ? <span className="text-pos">{money.full(best.booked, { signed: true })}</span> : '—',
                s: best && best.booked > 0 ? bucketLabel(best, bucketMs) : `no winning ${word} between`,
              },
            ].map((c) => (
              <div key={c.k} className="flex min-w-0 flex-col gap-1 bg-panel px-3 py-2.5">
                <dt className="text-[11px] text-fg-3">{c.k}</dt>
                <dd className="num truncate text-sm text-fg">{c.v}</dd>
                <dd className="truncate text-[11px] text-fg-4">{c.s}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </div>
  )
}
