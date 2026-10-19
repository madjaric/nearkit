import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  HistogramSeries,
  LineStyle,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
  type WhitespaceData,
} from 'lightweight-charts'
import { RotateCcw } from 'lucide-react'
import { forwardRef, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { planUpdate, priceMinMove, viewAfterReplace } from '@/lib/chart/ohlc'
import { formatDateTime } from '@/lib/format'
import type { Candle } from '@/types/domain'
import { chartColors, type ChartColors } from './chartColors'

/**
 * NEARKITS' interactive price chart (TradingView Lightweight Charts): real OHLC candles, green when a
 * candle closed at or above its open, red below; volume in its own pane beneath, only when the source
 * reports it; no price at or below zero is ever labelled; drag to pan,
 * wheel, trackpad or pinch to zoom, a crosshair with each candle's figures, the price scale on the right.
 *
 * The chart is created once. A refresh that only moves the last candle (or adds new ones) is drawn in
 * place; anything else replaces the series and puts the view back where the user had it (still
 * following the newest candle if that is where they were). A new `viewKey` (another token or interval)
 * fits the next data instead. Candles come normalized (src/lib/chart/ohlc.ts): valid, unique, in order.
 */

export interface PriceChartProps {
  candles: readonly Candle[]
  /** The candles' period in seconds (named in the readout). */
  intervalSec: number
  /** loading: the first read is pending; error: nothing could be read. A background refresh keeps the chart. */
  status?: 'loading' | 'error' | 'ready'
  /** Said when the data is read and holds no candle. */
  empty?: ReactNode
  /** Said when nothing could be read. */
  error?: ReactNode
  onRetry?: () => void
  /** The latest price, drawn as a dashed line with its label; none: the last close is labelled. */
  livePrice?: number | null
  formatPrice: (v: number) => string
  /** A volume as the source counts it, with its unit. */
  formatVolume?: (v: number) => string
  /** The chart's accessible name, e.g. "HOOTERS price in USD, 15-minute candles". */
  label: string
  /** Another token or interval: the next data is fitted to the view instead of keeping the user's place. */
  viewKey: string
  /** Height classes; the chart fills the box. */
  className?: string
}

/** Candles in the first view of a long history (the rest is a drag away). */
const FIRST_VIEW = 90
/** Empty bars right of the newest candle. */
const RIGHT_GAP = 3
/** A short history is drawn at this bar width on the right, the plot left of it empty: never stretched across it. */
const FEW_SPACING = 12

interface Tip {
  x: number
  y: number
  width: number
  height: number
  candle: Candle
}

type ChartRefs = {
  chart: IChartApi
  candles: ISeriesApi<'Candlestick'>
  /** Its own pane under the price; there only while the data has volume. */
  volume: ISeriesApi<'Histogram'> | null
  colors: ChartColors
}

/** A price label: none at or below zero (a margin of the scale, never a price). */
const positiveOnly = (fmt: (v: number) => string) => (p: number) => (p > 0 ? fmt(p) : '')

/** The volume pane, added when the data has volume and removed when it has none. */
function setVolume(r: ChartRefs, on: boolean) {
  if (on && !r.volume) {
    r.volume = r.chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false }, 1)
    r.volume.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: 0 } })
    const panes = r.chart.panes()
    panes[0]?.setStretchFactor(4)
    panes[1]?.setStretchFactor(1)
  } else if (!on && r.volume) {
    r.chart.removeSeries(r.volume)
    r.volume = null
  }
}

function intervalText(sec: number): string {
  if (sec % 86_400 === 0) return sec === 86_400 ? 'daily' : `${sec / 86_400}-day`
  if (sec % 3_600 === 0) return sec === 3_600 ? 'hourly' : `${sec / 3_600}-hour`
  return `${Math.round(sec / 60)}-minute`
}

const HoverTip = forwardRef<{ show(t: Tip | null): void }, { formatPrice: (v: number) => string; formatVolume?: (v: number) => string; intervalSec: number }>(function HoverTip(
  { formatPrice, formatVolume, intervalSec },
  ref,
) {
  const [tip, setTip] = useState<Tip | null>(null)
  useImperativeHandle(ref, () => ({ show: setTip }), [])
  if (!tip) return null
  const c = tip.candle
  const up = c.c >= c.o
  const W = 184
  const left = tip.x + 16 + W > tip.width - 64 ? Math.max(4, tip.x - 16 - W) : tip.x + 16
  const top = Math.min(Math.max(6, tip.y - 40), Math.max(6, tip.height - 150))
  return (
    <div
      className="pointer-events-none absolute z-10 w-[184px] rounded-md border border-line bg-panel/95 px-2.5 py-2 text-xs shadow-lg backdrop-blur-sm"
      style={{ left, top }}
      role="status"
      aria-live="off"
    >
      <div className="mb-1 text-[11px] text-fg-3">
        {formatDateTime(c.t)} · {intervalText(intervalSec)}
      </div>
      <dl className="num grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <dt className="text-fg-4">O</dt>
        <dd className="text-right text-fg">{formatPrice(c.o)}</dd>
        <dt className="text-fg-4">H</dt>
        <dd className="text-right text-fg">{formatPrice(c.h)}</dd>
        <dt className="text-fg-4">L</dt>
        <dd className="text-right text-fg">{formatPrice(c.l)}</dd>
        <dt className="text-fg-4">C</dt>
        <dd className={cn('text-right', up ? 'text-pos' : 'text-neg')}>{formatPrice(c.c)}</dd>
        {c.v !== null && formatVolume && (
          <>
            <dt className="text-fg-4">Vol</dt>
            <dd className="text-right text-fg-2">{formatVolume(c.v)}</dd>
          </>
        )}
      </dl>
    </div>
  )
})

/** The first view: everything when it fits (a short history at a normal width, on the right), otherwise the newest candles; the price scale back on auto. */
function fitView(chart: IChartApi, n: number) {
  const ts = chart.timeScale()
  if (n <= FIRST_VIEW && ts.width() / (n + RIGHT_GAP) > FEW_SPACING) {
    ts.applyOptions({ barSpacing: FEW_SPACING })
    ts.scrollToRealTime()
  } else if (n <= FIRST_VIEW) ts.fitContent()
  else ts.setVisibleLogicalRange({ from: n - FIRST_VIEW, to: n - 1 + RIGHT_GAP })
  chart.priceScale('right').applyOptions({ autoScale: true })
}

export function PriceChart({
  candles,
  intervalSec,
  status = 'ready',
  empty,
  error,
  onRetry,
  livePrice = null,
  formatPrice,
  formatVolume,
  label,
  viewKey,
  className = 'h-[320px] sm:h-[400px]',
}: PriceChartProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const refs = useRef<ChartRefs | null>(null)
  const tipRef = useRef<{ show(t: Tip | null): void }>(null)
  const dataRef = useRef<readonly Candle[]>([])
  const byTime = useRef(new Map<number, Candle>())
  const fitNext = useRef(true)
  const offset = useRef<number | null>(null)
  const minMove = useRef(0)
  const hadVolume = useRef(false)
  const liveLine = useRef<IPriceLine | null>(null)
  const fmt = useRef(formatPrice)
  const summaryId = useId()

  // The chart, once per mount: its series, crosshair readout and cleanup.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const colors = chartColors(host)
    const chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'rgba(0,0,0,0)' },
        textColor: colors.text,
        fontFamily: getComputedStyle(host).getPropertyValue('--font-mono').trim() || 'ui-monospace, monospace',
        fontSize: 11,
        attributionLogo: true,
        panes: { separatorColor: colors.grid, separatorHoverColor: colors.border, enableResize: false },
      },
      localization: { locale: 'en-US' },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      rightPriceScale: { borderColor: colors.border, scaleMargins: { top: 0.1, bottom: 0.08 } },
      timeScale: {
        borderColor: colors.border,
        timeVisible: intervalSec < 86_400,
        secondsVisible: false,
        rightOffset: RIGHT_GAP,
        barSpacing: 8,
        minBarSpacing: 0.5,
        maxBarSpacing: 40,
        lockVisibleTimeRangeOnResize: true,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: colors.crosshair, style: LineStyle.Dashed, width: 1, labelBackgroundColor: colors.labelBg },
        horzLine: { color: colors.crosshair, style: LineStyle.Dashed, width: 1, labelBackgroundColor: colors.labelBg },
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: { time: true, price: true } },
      kineticScroll: { mouse: false, touch: true },
    })
    const series = chart.addSeries(CandlestickSeries, {
      upColor: colors.pos,
      downColor: colors.neg,
      borderUpColor: colors.pos,
      borderDownColor: colors.neg,
      wickUpColor: colors.pos,
      wickDownColor: colors.neg,
      priceLineVisible: false,
      priceFormat: { type: 'custom', minMove: 0.01, formatter: positiveOnly((p) => fmt.current(p)) },
    })
    const onMove = (p: MouseEventParams<Time>) => {
      const c = p.time !== undefined ? byTime.current.get(p.time as number) : undefined
      if (!c || !p.point || p.point.x < 0 || p.point.y < 0) return tipRef.current?.show(null)
      tipRef.current?.show({ x: p.point.x, y: p.point.y, width: host.clientWidth, height: host.clientHeight, candle: c })
    }
    chart.subscribeCrosshairMove(onMove)
    refs.current = { chart, candles: series, volume: null, colors }
    // A handle for the browser tests (never in a production build).
    if (!import.meta.env.PROD) (host as HTMLDivElement & { __nearkitsChart?: IChartApi }).__nearkitsChart = chart
    return () => {
      chart.unsubscribeCrosshairMove(onMove)
      chart.remove()
      refs.current = null
      liveLine.current = null
      dataRef.current = []
      byTime.current = new Map()
      fitNext.current = true
      offset.current = null
      minMove.current = 0
      hadVolume.current = false
    }
    // intervalSec only sets whether the axis shows the time of day: read once, a new interval comes with a new viewKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The price format the scale and readout use, kept current without rebuilding the chart.
  useEffect(() => {
    fmt.current = formatPrice
  }, [formatPrice])

  // A new token or interval: the next data is fitted, and the axis shows the time of day for intraday candles.
  useEffect(() => {
    fitNext.current = true
    tipRef.current?.show(null)
    refs.current?.chart.applyOptions({ timeScale: { timeVisible: intervalSec < 86_400 } })
  }, [viewKey, intervalSec])

  // The data: drawn in place when only the newest candles changed; otherwise replaced, the view kept.
  useEffect(() => {
    const r = refs.current
    if (!r) return
    const prev = dataRef.current
    if (candles.length === 0) {
      if (prev.length) {
        r.candles.setData([])
        r.volume?.setData([])
        dataRef.current = []
        byTime.current = new Map()
      }
      return
    }
    // One constant shift to the viewer's UTC offset: the axis reads local time and the order stays strict.
    if (offset.current === null) offset.current = -new Date((candles[candles.length - 1] as Candle).t).getTimezoneOffset() * 60
    const off = offset.current
    const time = (c: Candle) => (Math.floor(c.t / 1000) + off) as UTCTimestamp
    const bar = (c: Candle): CandlestickData<Time> => ({ time: time(c), open: c.o, high: c.h, low: c.l, close: c.c })
    const vol = (c: Candle): HistogramData<Time> | WhitespaceData<Time> =>
      c.v === null ? { time: time(c) } : { time: time(c), value: c.v, color: c.c >= c.o ? r.colors.posVolume : r.colors.negVolume }
    const hasVolume = candles.some((c) => c.v !== null)
    const plan = fitNext.current || hasVolume !== hadVolume.current ? ({ kind: 'replace' } as const) : planUpdate(prev, candles)
    if (plan.kind === 'none') return
    const mm = priceMinMove(candles)
    if (mm !== minMove.current) {
      r.candles.applyOptions({ priceFormat: { type: 'custom', minMove: mm, formatter: positiveOnly((p) => fmt.current(p)) } })
      minMove.current = mm
    }
    if (plan.kind === 'tail') {
      for (let i = plan.from; i < candles.length; i++) {
        const c = candles[i] as Candle
        r.candles.update(bar(c))
        r.volume?.update(vol(c))
        byTime.current.set(time(c), c)
      }
    } else {
      const ts = r.chart.timeScale()
      const logical = fitNext.current ? null : ts.getVisibleLogicalRange()
      const range = fitNext.current ? null : ts.getVisibleRange()
      r.candles.setData(candles.map(bar))
      setVolume(r, hasVolume)
      r.volume?.setData(candles.map(vol))
      byTime.current = new Map(candles.map((c) => [time(c), c]))
      const view = viewAfterReplace({ prevLength: prev.length, logical, nextLength: candles.length })
      if (view.kind === 'fit') fitView(r.chart, candles.length)
      else if (view.kind === 'logical') ts.setVisibleLogicalRange({ from: view.from, to: view.to })
      else if (range) ts.setVisibleRange(range)
      fitNext.current = false
      hadVolume.current = hasVolume
    }
    dataRef.current = candles
  }, [candles])

  // The live price: a dashed line labelled on the scale; without it, the last close is labelled.
  useEffect(() => {
    const r = refs.current
    if (!r) return
    const known = livePrice !== null && Number.isFinite(livePrice) && livePrice > 0
    if (!known) {
      if (liveLine.current) r.candles.removePriceLine(liveLine.current)
      liveLine.current = null
      r.candles.applyOptions({ lastValueVisible: true })
      return
    }
    if (liveLine.current) liveLine.current.applyOptions({ price: livePrice })
    else liveLine.current = r.candles.createPriceLine({ price: livePrice, color: r.colors.live, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '' })
    r.candles.applyOptions({ lastValueVisible: false })
  }, [livePrice])

  const reset = () => {
    const r = refs.current
    if (r) fitView(r.chart, dataRef.current.length)
  }
  // Keys for the chart in focus: arrows pan, + and − zoom, 0 or Home resets the view.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const r = refs.current
    if (!r) return
    const ts = r.chart.timeScale()
    const spacing = ts.options().barSpacing
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') ts.scrollToPosition(ts.scrollPosition() + (e.key === 'ArrowLeft' ? -5 : 5), false)
    else if (e.key === '+' || e.key === '=') ts.applyOptions({ barSpacing: Math.min(40, spacing * 1.25) })
    else if (e.key === '-' || e.key === '_') ts.applyOptions({ barSpacing: Math.max(0.5, spacing / 1.25) })
    else if (e.key === '0' || e.key === 'Home') reset()
    else return
    e.preventDefault()
  }

  const summary = useMemo(() => {
    const first = candles[0]
    const last = candles[candles.length - 1]
    if (!first || !last) return `${label}: no candles.`
    let hi = -Infinity
    let lo = Infinity
    for (const c of candles) {
      if (c.h > hi) hi = c.h
      if (c.l < lo) lo = c.l
    }
    return `${label}: ${candles.length} ${intervalText(intervalSec)} candles from ${formatDateTime(first.t)} to ${formatDateTime(last.t)}; last close ${formatPrice(last.c)}, high ${formatPrice(hi)}, low ${formatPrice(lo)}. Arrow keys pan, plus and minus zoom, 0 resets the view.`
  }, [candles, label, intervalSec, formatPrice])

  const overlay =
    candles.length > 0 ? null : status === 'loading' ? (
      <div className="flex flex-col items-center gap-2 text-sm text-fg-3" aria-busy="true">
        <span className="h-1 w-24 animate-pulse rounded-full bg-raised" />
        Loading candles…
      </div>
    ) : status === 'error' ? (
      <div className="flex max-w-sm flex-col items-center gap-2 text-center text-sm text-fg-3" role="alert">
        {error ?? 'The price history couldn’t be read.'}
        {onRetry && (
          <button type="button" onClick={onRetry} className="rounded-xs border border-line px-2 py-1 text-xs text-fg-2 hover:border-line-strong hover:text-fg">
            Try again
          </button>
        )}
      </div>
    ) : (
      <div className="max-w-sm text-center text-sm text-fg-3">{empty ?? 'No candles in this window.'}</div>
    )

  return (
    <div className={cn('relative w-full min-w-0 overflow-hidden', className)} role="group" aria-label={label} aria-describedby={summaryId}>
      <div
        ref={hostRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerLeave={() => tipRef.current?.show(null)}
        className="absolute inset-0 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      />
      <HoverTip ref={tipRef} formatPrice={formatPrice} formatVolume={formatVolume} intervalSec={intervalSec} />
      {candles.length > 0 && (
        <button
          type="button"
          onClick={reset}
          title="Fit the view to the data (0)"
          className="absolute left-2 top-2 z-10 inline-flex items-center gap-1 rounded-xs border border-line bg-panel/90 px-1.5 py-1 text-[11px] text-fg-3 backdrop-blur-sm hover:border-line-strong hover:text-fg"
        >
          <RotateCcw size={12} aria-hidden="true" /> Reset view
        </button>
      )}
      {overlay && <div className="absolute inset-0 z-10 grid place-items-center bg-panel/60 px-4">{overlay}</div>}
      <p id={summaryId} className="sr-only">
        {summary}
      </p>
    </div>
  )
}
