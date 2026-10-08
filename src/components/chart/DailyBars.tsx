import { useState, type PointerEvent } from 'react'
import { cn } from '@/lib/cn'
import { formatDate, USD_FORMAT, type MoneyFormat } from '@/lib/format'
import { toneOf } from '@/lib/tone'
import type { PnlPoint } from '@/types/domain'
import { nearestAt, pct, pointerFrac, xFrac, yScale } from './geometry'
import { niceTicks } from './scale'
import { HoverReadout, VLine, YLabels } from './ScopeParts'

const PAD = { top: 8, right: 60, bottom: 8, left: 4 }

/**
 * Realized PnL per bucket (an hour, six hours, a day) as columns from a zero line: position carries
 * the sign, color reinforces it. Columns are HTML so their width caps at 24px with a 2px gap at any
 * container size, sharing x positions with the scope above. The first point (the period's start) has none.
 */
export function DailyBars({
  points,
  height = 110,
  window,
  dim = false,
  money = USD_FORMAT,
  label = (p) => formatDate(p.t),
  word = 'day',
  fracs,
}: {
  points: PnlPoint[]
  height?: number
  window?: [number, number]
  dim?: boolean
  money?: MoneyFormat
  /** A bucket's name in the hover readout. */
  label?: (p: PnlPoint) => string
  /** What a bucket is called ("hour", "6 h", "day"). */
  word?: string
  /** Each point's x, shared with the chart above (by time); evenly by index without it. */
  fracs?: readonly number[]
}) {
  const [hover, setHover] = useState<number | null>(null)
  const n = points.length
  const plotH = height - PAD.top - PAD.bottom
  const values = points.map((p) => p.booked)
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values), 2)
  const lo = ticks[0] ?? -1
  const hi = ticks[ticks.length - 1] ?? 1
  const y = yScale([lo, hi], plotH)
  const zero = y(0)
  const slot = n > 1 ? 100 / (n - 1) : 100
  const hp = hover !== null ? points[hover] : undefined
  const from = window ? Math.min(...window) : -1
  const to = window ? Math.max(...window) : n

  const xAt = (i: number) => fracs?.[i] ?? xFrac(i, n)
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const frac = pointerFrac(e.clientX, e.currentTarget)
    setHover(fracs ? nearestAt(fracs, frac) : Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1)))))
  }

  return (
    <div className={cn('relative select-none', dim && 'opacity-50 transition-opacity')} style={{ height }}>
      <div
        className="absolute"
        style={{ top: PAD.top, bottom: PAD.bottom, left: PAD.left, right: PAD.right }}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={`Realized PnL per ${word}, ${n - 1} of them: ${values.filter((v) => v > 0).length} winning, ${values.filter((v) => v < 0).length} losing.`}
      >
        {ticks.map((t) => (
          <span key={t} aria-hidden="true" className={cn('absolute inset-x-0 h-px', t === 0 ? 'bg-line-strong' : 'bg-line-soft')} style={{ top: y(t) }} />
        ))}
        {points.map((p, i) => {
          if (p.booked === 0) return null
          const up = p.booked > 0
          const top = up ? y(p.booked) : zero
          const h = Math.max(1, Math.abs(y(p.booked) - zero))
          const inWindow = !window || (i > from && i <= to)
          return (
            <span
              key={p.t}
              aria-hidden="true"
              className={cn(
                'absolute -translate-x-1/2',
                up ? 'rounded-t-[2px] bg-chart-pos' : 'rounded-b-[2px] bg-chart-neg',
                !inWindow && 'opacity-30',
                hover === i && 'brightness-125',
              )}
              style={{ left: pct(xAt(i)), top, height: h, width: `min(24px, max(1px, calc(${slot}% - 2px)))` }}
            />
          )
        })}
        {hp && hover !== null && (
          <>
            <VLine frac={xAt(hover)} className="bg-fg-4" />
            <HoverReadout frac={xAt(hover)}>
              <div className={cn('num text-sm', toneOf(hp.booked))}>{hp.booked === 0 ? 'No closed trades' : money.full(hp.booked, { signed: true })}</div>
              <div className="text-[11px] text-fg-3">{label(hp)}</div>
            </HoverReadout>
          </>
        )}
        <div aria-hidden="true">
          <YLabels ticks={ticks} y={y} format={(t) => (t === 0 ? '0' : money.compact(t, 1))} strong={0} />
        </div>
      </div>
    </div>
  )
}
