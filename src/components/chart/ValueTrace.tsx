import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { cn } from '@/lib/cn'
import { formatPct } from '@/lib/format'
import { toneOf } from '@/lib/tone'
import { VIEW_W, formatDivision, linePath, xFrac, yScale } from './geometry'
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
}

const PAD = { top: 24, right: 60, bottom: 22, left: 4 }

/**
 * Single-series trace on an oscilloscope graticule. Geometry is CSS-driven (see
 * geometry.ts); the crosshair snaps to samples and arrow keys walk it.
 */
export function ValueTrace({ points, label, height = 200, formatValue, formatTick, formatTime, formatAxis = formatTime, measure = false, dim = false }: ValueTraceProps) {
  const plotRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const n = points.length
  const cursors = useCursors(n, [0, n - 1], plotRef)
  const padTop = measure ? PAD.top : 10
  const plotH = height - padTop - PAD.bottom

  const values = points.map((p) => p.v)
  const ticks = niceTicks(Math.min(...values), Math.max(...values), 3)
  const lo = ticks[0] ?? 0
  const hi = ticks[ticks.length - 1] ?? 1
  const y = yScale([lo, hi], plotH)
  const path = linePath(values, y)
  const first = points[0]
  const last = points[n - 1]
  const axis = n > 1 ? [0, Math.round((n - 1) / 3), Math.round(((n - 1) * 2) / 3), n - 1] : []
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
    setHover(Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1)))))
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
                    x={xFrac(Math.min(cursors.a, cursors.b), n) * VIEW_W}
                    y={0}
                    width={Math.abs(xFrac(cursors.b, n) - xFrac(cursors.a, n)) * VIEW_W}
                    height={plotH}
                    className="fill-fg/[0.035]"
                  />
                )}
                <path d={path} fill="none" className="stroke-accent" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              </svg>
              {last && <Dot frac={1} y={y(last.v)} />}
              {hp && hover !== null && (
                <>
                  <VLine frac={xFrac(hover, n)} className="bg-fg-4" />
                  <Dot frac={xFrac(hover, n)} y={y(hp.v)} />
                  <HoverReadout frac={xFrac(hover, n)}>
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
                <XLabels items={axis.map((i) => ({ frac: xFrac(i, n), text: formatAxis(points[i]?.t ?? 0) }))} />
              </div>
              {measure &&
                (['a', 'b'] as const).map((id) => {
                  const index = id === 'a' ? cursors.a : cursors.b
                  const p = points[index]
                  if (!p) return null
                  return (
                    <div key={id}>
                      <VLine frac={xFrac(index, n)} className="bg-fg-2" />
                      <Dot frac={xFrac(index, n)} y={y(p.v)} tone="fg" />
                      <div className="pointer-events-auto">
                        <CursorHandle
                          id={id}
                          frac={xFrac(index, n)}
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
