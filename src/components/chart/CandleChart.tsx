import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { cn } from '@/lib/cn'
import type { Candle } from '@/types/domain'
import { layoutCandles } from './candleGeometry'
import { VIEW_W, nearestAt } from './geometry'
import { Graticule, HoverReadout, VLine, XLabels, YLabels } from './ScopeParts'

interface CandleChartProps {
  candles: readonly Candle[]
  /** The window drawn, in ms: candles sit at their own time in it, and a period without trades stays a gap. */
  start: number
  end: number
  candleSec: number
  /** The latest price (live), drawn as the current-price line; null: the last close. */
  live: number | null
  label: string
  height?: number
  formatPrice: (v: number) => string
  formatTime: (t: number) => string
  formatAxis: (t: number) => string
  /** A volume as the source counts it, with its unit. */
  formatVolume: (v: number) => string
}

const PAD = { top: 10, right: 64, bottom: 22, left: 4 }

/**
 * OHLCV candles of a token's market (Token Detail): green candles closed at or above their open, red
 * below; volume in a band beneath; the price axis on the right, time below; the current price as a
 * dashed line. Only the source's own candles: none is made up, interpolated or carried over a gap.
 * The crosshair snaps to candles, and arrow keys walk them.
 */
export function CandleChart({ candles, start, end, candleSec, live, label, height = 300, formatPrice, formatTime, formatAxis, formatVolume }: CandleChartProps) {
  const plotRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const plotH = height - PAD.top - PAD.bottom
  const priceH = Math.round(plotH * 0.76)
  const volTop = Math.round(plotH * 0.8)
  const volH = plotH - volTop
  const { boxes, ticks, y } = layoutCandles(candles, { start, end, candleMs: candleSec * 1000, priceH, volTop, volH, extra: live })
  const lastBox = boxes[boxes.length - 1]
  const lastCandle = lastBox ? candles[lastBox.i] : undefined
  const current = live ?? lastCandle?.c ?? null
  const fracs = boxes.map((b) => b.x)
  const hb = hover !== null ? boxes[hover] : undefined
  const hc = hb ? candles[hb.i] : undefined
  const firstCandle = boxes[0] ? candles[boxes[0].i] : undefined
  const summary =
    firstCandle && lastCandle
      ? `${label}: ${boxes.length} candles, from ${formatTime(firstCandle.t)} (open ${formatPrice(firstCandle.o)}) to ${formatTime(lastCandle.t)} (close ${formatPrice(lastCandle.c)}). High ${formatPrice(Math.max(...boxes.map((b) => candles[b.i]?.h ?? 0)))}, low ${formatPrice(Math.min(...boxes.map((b) => candles[b.i]?.l ?? Number.POSITIVE_INFINITY)))}.`
      : `${label}: no candles`

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!boxes.length) return
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = rect.width ? Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) : 0
    setHover(nearestAt(fracs, frac))
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) || !boxes.length) return
    e.preventDefault()
    setHover((h) => {
      const cur = h ?? boxes.length - 1
      if (e.key === 'Home') return 0
      if (e.key === 'End') return boxes.length - 1
      return Math.max(0, Math.min(boxes.length - 1, cur + (e.key === 'ArrowRight' ? 1 : -1)))
    })
  }
  const inset = { top: PAD.top, bottom: PAD.bottom, left: PAD.left, right: PAD.right }
  const lastUp = lastCandle ? lastCandle.c >= lastCandle.o : true

  return (
    <div className="relative select-none" style={{ height }}>
      <div
        ref={plotRef}
        role="img"
        aria-label={summary}
        tabIndex={0}
        className="absolute cursor-crosshair touch-none outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
        style={inset}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKeyDown}
        onBlur={() => setHover(null)}
      >
        <Graticule height={plotH} tickYs={ticks.map(y)} baselineY={priceH / 2} />
        <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox={`0 0 ${VIEW_W} ${plotH}`} preserveAspectRatio="none" aria-hidden="true">
          {boxes.map((b) =>
            b.volH > 0 ? (
              <rect key={`v${b.i}`} x={(b.x - b.w / 2) * VIEW_W} y={b.volY} width={b.w * VIEW_W} height={b.volH} className={b.up ? 'fill-pos/30' : 'fill-neg/30'} />
            ) : null,
          )}
          {boxes.map((b) => (
            <line
              key={`w${b.i}`}
              x1={b.x * VIEW_W}
              x2={b.x * VIEW_W}
              y1={b.wickY1}
              y2={b.wickY2}
              className={b.up ? 'stroke-pos' : 'stroke-neg'}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {boxes.map((b) => (
            <rect key={`b${b.i}`} x={(b.x - b.w / 2) * VIEW_W} y={b.bodyY} width={b.w * VIEW_W} height={b.bodyH} className={b.up ? 'fill-pos' : 'fill-neg'} />
          ))}
          {current !== null && (
            <line x1={0} x2={VIEW_W} y1={y(current)} y2={y(current)} className="stroke-fg-3" strokeWidth={1} strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
          )}
        </svg>
        {hb && hc && (
          <>
            <VLine frac={hb.x} className="bg-fg-4" />
            <HoverReadout frac={hb.x}>
              <div className="text-[11px] text-fg-3">{formatTime(hc.t)}</div>
              <div className="num grid grid-cols-[auto_auto] gap-x-2 text-xs">
                <span className="text-fg-4">O</span>
                <span className="text-fg">{formatPrice(hc.o)}</span>
                <span className="text-fg-4">H</span>
                <span className="text-fg">{formatPrice(hc.h)}</span>
                <span className="text-fg-4">L</span>
                <span className="text-fg">{formatPrice(hc.l)}</span>
                <span className="text-fg-4">C</span>
                <span className={hc.c >= hc.o ? 'text-pos' : 'text-neg'}>{formatPrice(hc.c)}</span>
                {hc.v !== null && (
                  <>
                    <span className="text-fg-4">Vol</span>
                    <span className="text-fg-2">{formatVolume(hc.v)}</span>
                  </>
                )}
              </div>
            </HoverReadout>
          </>
        )}
      </div>

      {/* Axes sit in an overlay so the plot stays a single image for assistive tech. */}
      <div className="pointer-events-none absolute" style={inset} aria-hidden="true">
        <YLabels ticks={ticks} y={y} format={formatPrice} />
        {current !== null && (
          <span
            className={cn(
              'num absolute left-full ml-1 -translate-y-1/2 whitespace-nowrap rounded-xs px-1 py-px text-[10.5px] leading-none text-canvas',
              lastUp ? 'bg-pos' : 'bg-neg',
            )}
            style={{ top: y(current) }}
          >
            {formatPrice(current)}
          </span>
        )}
        <XLabels items={[0, 1 / 3, 2 / 3, 1].map((frac) => ({ frac, text: formatAxis(start + frac * (end - start)) }))} />
      </div>
    </div>
  )
}
