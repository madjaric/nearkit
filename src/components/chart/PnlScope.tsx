import { useRef, useState, type PointerEvent } from 'react'
import { ReadoutSlot, ReadoutStrip } from '@/components/ui/Readout'
import { cn } from '@/lib/cn'
import { formatDate, formatPct, USD_FORMAT, type MoneyFormat } from '@/lib/format'
import { toneOf } from '@/lib/tone'
import type { PnlPoint } from '@/types/domain'
import { DailyBars } from './DailyBars'
import { VIEW_W, formatDivision, linePath, xFrac, yScale } from './geometry'
import { niceTicks } from './scale'
import { CursorHandle, Dot, Graticule, HoverReadout, VLine, XLabels, YLabels } from './ScopeParts'
import { useCursors } from './useCursors'

const PAD = { top: 26, right: 60, bottom: 22, left: 4 }

interface PnlScopeProps {
  points: PnlPoint[]
  height?: number
  dim?: boolean
  /** Units of the figures (USD unless the report is in NEAR). */
  money?: MoneyFormat
}

/**
 * Cumulative realized PnL on a graticule with two measurement cursors, the way
 * a scope measures between two points: drag A and B (or focus a handle and use
 * the arrow keys) to read ΔPnL, return on volume, Δt and the best day between.
 */
export function PnlScope({ points, height = 260, dim = false, money = USD_FORMAT }: PnlScopeProps) {
  const n = points.length
  const plotRef = useRef<HTMLDivElement>(null)
  const cursors = useCursors(n, [Math.floor((n - 1) * 0.25), n - 1], plotRef)
  const [hover, setHover] = useState<number | null>(null)
  const plotH = height - PAD.top - PAD.bottom

  const values = points.map((p) => p.cumulative)
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values), 4)
  const lo = ticks[0] ?? 0
  const hi = ticks[ticks.length - 1] ?? 1
  const y = yScale([lo, hi], plotH)
  const path = linePath(values, y)

  const { a, b } = cursors
  const pa = points[a]
  const pb = points[b]
  const from = Math.min(a, b)
  const to = Math.max(a, b)
  const delta = pa && pb ? pb.cumulative - pa.cumulative : 0
  const days = Math.abs(b - a)
  const windowDays = points.slice(from + 1, to + 1)
  const volume = windowDays.reduce((s, p) => s + p.volumeUsd, 0)
  const returnOnVolume = volume > 0 ? (delta / volume) * 100 : null
  const best = windowDays.reduce<PnlPoint | null>((m, p) => (m === null || p.daily > m.daily ? p : m), null)
  const hp = hover !== null ? points[hover] : undefined
  const axis = n > 1 ? [0, Math.round((n - 1) / 2), n - 1] : []
  const inset = { top: PAD.top, bottom: PAD.bottom, left: PAD.left, right: PAD.right }

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (cursors.dragTo(e)) {
      setHover(null)
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = rect.width ? (e.clientX - rect.left) / rect.width : 0
    setHover(Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1)))))
  }

  return (
    <div className={cn('flex flex-col gap-3', dim && 'opacity-50 transition-opacity')}>
      <p className="num -mb-1 text-right text-[11px] text-fg-4" title="Graticule scale: value and time per major division">
        {money.compact((ticks[1] ?? 0) - (ticks[0] ?? 0), 1)}/div · {formatDivision(((points[n - 1]?.t ?? 0) - (points[0]?.t ?? 0)) / 10)}/div
      </p>
      <div className="relative select-none" style={{ height }}>
        <div
          ref={plotRef}
          data-plot
          role="img"
          aria-label={`Cumulative realized PnL over ${n} days, from ${money.full(points[0]?.cumulative ?? 0, { signed: true })} to ${money.full(points[n - 1]?.cumulative ?? 0, { signed: true })}.`}
          className="absolute cursor-crosshair touch-none"
          style={inset}
          onPointerDown={cursors.plotHandlers.onPointerDown}
          onPointerUp={cursors.plotHandlers.onPointerUp}
          onPointerCancel={cursors.plotHandlers.onPointerUp}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHover(null)}
        >
          {n > 1 && (
            <>
              <Graticule height={plotH} tickYs={ticks.map(y)} baselineY={y(0)} strongY={y(0)} />
              <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox={`0 0 ${VIEW_W} ${plotH}`} preserveAspectRatio="none" aria-hidden="true">
                <rect x={xFrac(from, n) * VIEW_W} y={0} width={(xFrac(to, n) - xFrac(from, n)) * VIEW_W} height={plotH} className="fill-fg/[0.035]" />
                <path d={path} fill="none" className="stroke-accent" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              </svg>
              {hp && hover !== null && (
                <>
                  <VLine frac={xFrac(hover, n)} className="bg-fg-4" />
                  <Dot frac={xFrac(hover, n)} y={y(hp.cumulative)} />
                  <HoverReadout frac={xFrac(hover, n)}>
                    <div className={cn('num text-sm', toneOf(hp.cumulative))}>{money.full(hp.cumulative, { signed: true })}</div>
                    <div className="text-[11px] text-fg-3">
                      {formatDate(hp.t)} · day <span className={cn('num', toneOf(hp.daily))}>{money.full(hp.daily, { signed: true })}</span>
                    </div>
                  </HoverReadout>
                </>
              )}
            </>
          )}
        </div>

        <div className="pointer-events-none absolute" style={inset}>
          {n > 1 && (
            <>
              <div aria-hidden="true">
                <YLabels ticks={ticks} y={y} format={(t) => (t === 0 ? '0' : money.compact(t, 1))} strong={0} />
                <XLabels items={axis.map((i) => ({ frac: xFrac(i, n), text: formatDate(points[i]?.t ?? 0) }))} />
              </div>
              {(['a', 'b'] as const).map((id) => {
                const index = id === 'a' ? a : b
                const p = points[index]
                if (!p) return null
                return (
                  <div key={id}>
                    <VLine frac={xFrac(index, n)} className="bg-fg-2" />
                    <Dot frac={xFrac(index, n)} y={y(p.cumulative)} tone="fg" />
                    <div className="pointer-events-auto">
                      <CursorHandle
                        id={id}
                        frac={xFrac(index, n)}
                        index={index}
                        max={n - 1}
                        valueText={`${formatDate(p.t)}: ${money.full(p.cumulative, { signed: true })}`}
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

      <div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-1">
          <span className="legend">Daily realized</span>
          <span aria-hidden="true" className="h-px min-w-8 flex-1 bg-line-soft" />
          <span className="text-[11px] text-fg-3">Bars outside the A–B window are dimmed</span>
        </div>
        <DailyBars points={points} window={[a, b]} money={money} />
      </div>

      <ReadoutStrip cols="grid-cols-2 sm:grid-cols-3 2xl:grid-cols-6" inset className="rounded-md border border-line">
        <ReadoutSlot legend="Cursor A" value={pa ? money.full(pa.cumulative, { signed: true }) : '—'} sub={pa ? formatDate(pa.t) : ''} />
        <ReadoutSlot legend="Cursor B" value={pb ? money.full(pb.cumulative, { signed: true }) : '—'} sub={pb ? formatDate(pb.t) : ''} />
        <ReadoutSlot legend="Δ PnL (B − A)" value={<span className={toneOf(delta)}>{money.full(delta, { signed: true })}</span>} sub="realized between cursors" />
        <ReadoutSlot
          legend="Δ % of volume"
          value={<span className={toneOf(returnOnVolume ?? 0)}>{returnOnVolume === null ? '—' : formatPct(returnOnVolume)}</span>}
          sub={volume > 0 ? `on ${money.compact(volume, 1)} traded` : 'no trades in window'}
        />
        <ReadoutSlot legend="Δ time" value={`${days}d`} sub={days ? `${money.full(delta / days, { signed: true })} per day` : 'same day'} />
        <ReadoutSlot
          legend="Best day"
          value={best && best.daily > 0 ? <span className="text-pos">{money.full(best.daily, { signed: true })}</span> : '—'}
          sub={best && best.daily > 0 ? formatDate(best.t) : 'no winning day in window'}
        />
      </ReadoutStrip>
    </div>
  )
}
