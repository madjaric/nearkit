import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { cn } from '@/lib/cn'
import { formatPct } from '@/lib/format'
import { toneOf } from '@/lib/tone'
import { VIEW_W, formatDivision, linePathAt, nearestAt, xFracs, yScale } from './geometry'
import { niceTicks } from './scale'
import { CursorHandle, Dot, Graticule, HoverReadout, VLine, XLabels, YLabels } from './ScopeParts'
import { useCursors } from './useCursors'

export interface TracePoint {
  t: number
  v: number
}

interface ValueTraceProps {
  points: TracePoint[]
  label: string
  height?: number
  formatValue: (v: number) => string
  formatTick: (v: number) => string
  formatTime: (t: number) => string
  /** Axis labels (defaults to formatTime). */
  formatAxis?: (t: number) => string
  /** Two measurement cursors with a Δ readout above the plot. */
  measure?: boolean
  /** Hold the previous render at reduced opacity while refetching. */
  dim?: boolean
  /** Place points by their time (a gap in time stays one), not evenly by index. */
  timeScale?: boolean
  /** With a time scale: no line is drawn between points further apart than this. */
  gapMs?: number
}

const PAD = { top: 24, right: 60, bottom: 22, left: 4 }

/**
 * Single-series trace on an oscilloscope graticule. Geometry is CSS-driven (see
 * geometry.ts); the crosshair snaps to samples and arrow keys walk it.
 */
export function ValueTrace({
  points,
  label,
  height = 200,
  formatValue,
  formatTick,
  formatTime,
  formatAxis = formatTime,
  measure = false,
  dim = false,
  timeScale = false,
  gapMs,
}: ValueTraceProps) {
  const plotRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const n = points.length
  const fracs = xFracs(
    points.map((p) => p.t),
    timeScale,
  )
  const breaks = timeScale && gapMs ? points.map((p, i) => i > 0 && p.t - (points[i - 1]?.t ?? p.t) > gapMs) : undefined
  const broken = breaks?.some(Boolean) ?? false
  const cursors = useCursors(n, [0, n - 1], plotRef, timeScale ? fracs : undefined)
  const padTop = measure ? PAD.top : 10
  const plotH = height - padTop - PAD.bottom

  const values = points.map((p) => p.v)
  const ticks = niceTicks(Math.min(...values), Math.max(...values), 3)
  const lo = ticks[0] ?? 0
  const hi = ticks[ticks.length - 1] ?? 1
  const y = yScale([lo, hi], plotH)
  const path = linePathAt(fracs, values, y, breaks)
  const fillId = useId()
  const first = points[0]
  const last = points[n - 1]
  const t0 = points[0]?.t ?? 0
  const span = (points[n - 1]?.t ?? 0) - t0
  // On a time scale the axis reads evenly spaced times; otherwise the samples at a third of the way each.
  const axis =
    n < 2
      ? []
      : timeScale && span > 0
        ? [0, 1 / 3, 2 / 3, 1].map((frac) => ({ frac, text: formatAxis(t0 + frac * span) }))
        : [0, Math.round((n - 1) / 3), Math.round(((n - 1) * 2) / 3), n - 1].map((i) => ({ frac: fracs[i] ?? 0, text: formatAxis(points[i]?.t ?? 0) }))
  const summary =
    first && last
      ? `${label}: from ${formatValue(first.v)} on ${formatTime(first.t)} to ${formatValue(last.v)} on ${formatTime(last.t)}. Low ${formatValue(Math.min(...values))}, high ${formatValue(Math.max(...values))}.`
      : `${label}: no data`

  const pa = points[cursors.a]
  const pb = points[cursors.b]
  const delta = pa && pb ? pb.v - pa.v : 0
  const deltaPct = pa && pa.v ? (delta / pa.v) * 100 : 0
  const hp = hover !== null ? points[hover] : undefined

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (measure && cursors.dragTo(e)) return
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = rect.width ? (e.clientX - rect.left) / rect.width : 0
    setHover(timeScale ? nearestAt(fracs, Math.max(0, Math.min(1, frac))) : Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1)))))
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
    e.preventDefault()
    setHover((h) => {
      const cur = h ?? n - 1
      if (e.key === 'Home') return 0
      if (e.key === 'End') return n - 1
      return Math.max(0, Math.min(n - 1, cur + (e.key === 'ArrowRight' ? 1 : -1)))
    })
  }

  const inset = { top: padTop, bottom: PAD.bottom, left: PAD.left, right: PAD.right }

  return (
    <div className={cn('flex flex-col gap-2', dim && 'opacity-50 transition-opacity')}>
      {measure && pa && pb && (
        <p className="num flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-fg-3" aria-live="polite">
          <span>
            <span className="font-sans text-fg-4">A</span> {formatTime(pa.t)} <span className="text-fg-2">{formatValue(pa.v)}</span>
          </span>
          <span>
            <span className="font-sans text-fg-4">B</span> {formatTime(pb.t)} <span className="text-fg-2">{formatValue(pb.v)}</span>
          </span>
          <span>
            <span className="font-sans text-fg-4">Δ</span>{' '}
            <span className={toneOf(delta)}>
              {delta >= 0 ? '+' : '−'}
              {formatValue(Math.abs(delta))} ({formatPct(deltaPct)})
            </span>
          </span>
          <span className="ml-auto text-fg-4" title="Graticule scale: value and time per major division">
            {formatTick((ticks[1] ?? 0) - (ticks[0] ?? 0))}/div · {formatDivision(((last?.t ?? 0) - (first?.t ?? 0)) / 10)}/div
          </span>
        </p>
      )}
      <div className="relative select-none" style={{ height }}>
        <div
          ref={plotRef}
          data-plot
          role="img"
          aria-label={summary}
          tabIndex={0}
          className={cn('absolute touch-none outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent', measure && 'cursor-crosshair')}
          style={inset}
          onPointerDown={measure ? cursors.plotHandlers.onPointerDown : undefined}
          onPointerUp={measure ? cursors.plotHandlers.onPointerUp : undefined}
          onPointerCancel={measure ? cursors.plotHandlers.onPointerUp : undefined}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHover(null)}
          onKeyDown={onKeyDown}
          onBlur={() => setHover(null)}
        >
          {n > 1 && (
            <>
              <Graticule height={plotH} tickYs={ticks.map(y)} baselineY={plotH / 2} />
              <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox={`0 0 ${VIEW_W} ${plotH}`} preserveAspectRatio="none" aria-hidden="true">
                {measure && (
                  <rect
                    x={Math.min(fracs[cursors.a] ?? 0, fracs[cursors.b] ?? 0) * VIEW_W}
                    y={0}
                    width={Math.abs((fracs[cursors.b] ?? 0) - (fracs[cursors.a] ?? 0)) * VIEW_W}
                    height={plotH}
                    className="fill-fg/[0.035]"
                  />
                )}
                <defs>
                  <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="var(--color-accent)" stopOpacity="0.2" />
                    <stop offset="1" stopColor="var(--color-accent)" stopOpacity="0" />
                  </linearGradient>
                </defs>
                {/* A faint fill under the trace, fading to the panel: the line stays the measurement. */}
                {!broken && <path d={`${path} L ${VIEW_W} ${plotH} L 0 ${plotH} Z`} fill={`url(#${fillId})`} stroke="none" />}
                <path d={path} fill="none" className="stroke-accent" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              </svg>
              {last && <Dot frac={1} y={y(last.v)} />}
              {hp && hover !== null && (
                <>
                  <VLine frac={fracs[hover] ?? 0} className="bg-fg-4" />
                  <Dot frac={fracs[hover] ?? 0} y={y(hp.v)} />
                  <HoverReadout frac={fracs[hover] ?? 0}>
                    <div className="num text-sm text-fg">{formatValue(hp.v)}</div>
                    <div className="text-[11px] text-fg-3">{formatTime(hp.t)}</div>
                  </HoverReadout>
                </>
              )}
            </>
          )}
        </div>

        {/* Axes and cursor keys sit in an overlay so the plot stays a single image for assistive tech. */}
        <div className="pointer-events-none absolute" style={inset}>
          {n > 1 && (
            <>
              <div aria-hidden="true">
                <YLabels ticks={ticks} y={y} format={formatTick} />
                <XLabels items={axis} />
              </div>
              {measure &&
                (['a', 'b'] as const).map((id) => {
                  const index = id === 'a' ? cursors.a : cursors.b
                  const p = points[index]
                  if (!p) return null
                  return (
                    <div key={id}>
                      <VLine frac={fracs[index] ?? 0} className="bg-fg-2" />
                      <Dot frac={fracs[index] ?? 0} y={y(p.v)} tone="fg" />
                      <div className="pointer-events-auto">
                        <CursorHandle
                          id={id}
                          frac={fracs[index] ?? 0}
                          index={index}
                          max={n - 1}
                          valueText={`${formatTime(p.t)}: ${formatValue(p.v)}`}
                          onKeyDown={cursors.handleKeys(id)}
                          onPointerDown={cursors.grab(id)}
                        />
                      </div>
                    </div>
                  )
                })}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
