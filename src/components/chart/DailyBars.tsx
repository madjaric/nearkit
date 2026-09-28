import { useState, type PointerEvent } from 'react'
import { cn } from '@/lib/cn'
import { formatDate, formatUsd, formatUsdCompact } from '@/lib/format'
import { toneOf } from '@/lib/tone'
import type { PnlPoint } from '@/types/domain'
import { pct, xFrac, yScale } from './geometry'
import { niceTicks } from './scale'
import { HoverReadout, VLine, YLabels } from './ScopeParts'

const PAD = { top: 8, right: 60, bottom: 8, left: 4 }

/**
 * Daily realized PnL as columns from a zero line: position carries the sign,
 * color reinforces it. Columns are HTML so their width caps at 24px with a
 * 2px gap at any container size, sharing x positions with the scope above.
 */
export function DailyBars({ points, height = 110, window, dim = false }: { points: PnlPoint[]; height?: number; window?: [number, number]; dim?: boolean }) {
  const [hover, setHover] = useState<number | null>(null)
  const n = points.length
  const plotH = height - PAD.top - PAD.bottom
  const values = points.map((p) => p.daily)
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values), 2)
  const lo = ticks[0] ?? -1
  const hi = ticks[ticks.length - 1] ?? 1
  const y = yScale([lo, hi], plotH)
  const zero = y(0)
  const slot = n > 1 ? 100 / (n - 1) : 100
  const hp = hover !== null ? points[hover] : undefined
  const from = window ? Math.min(...window) : -1
  const to = window ? Math.max(...window) : n

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = rect.width ? (e.clientX - rect.left) / rect.width : 0
    setHover(Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1)))))
  }

  return (
    <div className={cn('relative select-none', dim && 'opacity-50 transition-opacity')} style={{ height }}>
      <div
        className="absolute"
        style={{ top: PAD.top, bottom: PAD.bottom, left: PAD.left, right: PAD.right }}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={`Daily realized PnL for ${n} days. Winning days ${values.filter((v) => v > 0).length}, losing days ${values.filter((v) => v < 0).length}.`}
      >
        {ticks.map((t) => (
          <span key={t} aria-hidden="true" className={cn('absolute inset-x-0 h-px', t === 0 ? 'bg-line-strong' : 'bg-line-soft')} style={{ top: y(t) }} />
        ))}
        {points.map((p, i) => {
          if (p.daily === 0) return null
          const up = p.daily > 0
          const top = up ? y(p.daily) : zero
          const h = Math.max(1, Math.abs(y(p.daily) - zero))
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
              style={{ left: pct(xFrac(i, n)), top, height: h, width: `min(24px, max(1px, calc(${slot}% - 2px)))` }}
            />
          )
        })}
        {hp && hover !== null && (
          <>
            <VLine frac={xFrac(hover, n)} className="bg-fg-4" />
            <HoverReadout frac={xFrac(hover, n)}>
              <div className={cn('num text-sm', toneOf(hp.daily))}>{hp.daily === 0 ? 'No closed trades' : formatUsd(hp.daily, { signed: true })}</div>
              <div className="text-[11px] text-fg-3">{formatDate(hp.t)}</div>
            </HoverReadout>
          </>
        )}
        <div aria-hidden="true">
          <YLabels ticks={ticks} y={y} format={(t) => (t === 0 ? '0' : formatUsdCompact(t, 1))} strong={0} />
        </div>
      </div>
    </div>
  )
}
