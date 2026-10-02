import type { KeyboardEvent, PointerEvent, ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { VIEW_W, pct } from './geometry'

const DIVISIONS = 10

/** Scope graticule: 10 major divisions, horizontal rules at the value ticks, minor ticks on one rule. */
export function Graticule({ height, tickYs, baselineY, strongY }: { height: number; tickYs: number[]; baselineY: number; strongY?: number }) {
  return (
    <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox={`0 0 ${VIEW_W} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      {Array.from({ length: DIVISIONS + 1 }, (_, i) => (
        <line key={`v${i}`} x1={(VIEW_W * i) / DIVISIONS} x2={(VIEW_W * i) / DIVISIONS} y1={0} y2={height} className="stroke-line-soft" vectorEffect="non-scaling-stroke" />
      ))}
      {tickYs.map((y, i) => (
        <line key={`h${i}`} x1={0} x2={VIEW_W} y1={y} y2={y} className={y === strongY ? 'stroke-line-strong' : 'stroke-line-soft'} vectorEffect="non-scaling-stroke" />
      ))}
      {Array.from({ length: DIVISIONS * 5 + 1 }, (_, i) => {
        const x = (VIEW_W * i) / (DIVISIONS * 5)
        return <line key={`m${i}`} x1={x} x2={x} y1={baselineY - 2} y2={baselineY + 2} className="stroke-line-strong" vectorEffect="non-scaling-stroke" />
      })}
    </svg>
  )
}

/** A value's dot, drawn in HTML so it stays round at any width. */
export function Dot({ frac, y, tone = 'accent' }: { frac: number; y: number; tone?: 'accent' | 'fg' }) {
  return (
    <span
      aria-hidden="true"
      className={cn('pointer-events-none absolute z-[2] size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-panel', tone === 'accent' ? 'bg-accent' : 'bg-fg')}
      style={{ left: pct(frac), top: y }}
    />
  )
}

export function VLine({ frac, className }: { frac: number; className?: string }) {
  return <span aria-hidden="true" className={cn('pointer-events-none absolute inset-y-0 z-[1] w-px -translate-x-1/2', className)} style={{ left: pct(frac) }} />
}

/** Right-hand value axis: labels vertically centred on their rules. */
export function YLabels({ ticks, y, format, strong }: { ticks: number[]; y: (v: number) => number; format: (v: number) => string; strong?: number }) {
  return (
    <>
      {ticks.map((t) => (
        <span
          key={t}
          className={cn('num absolute left-full ml-2 -translate-y-1/2 whitespace-nowrap text-[10.5px] leading-none', t === strong ? 'text-fg-2' : 'text-fg-3')}
          style={{ top: y(t) }}
        >
          {format(t)}
        </span>
      ))}
    </>
  )
}

/**
 * Time axis under the plot; first label left-aligned, last right-aligned. The labels between
 * them print only where the plot is wide enough for all of them (measured against the plot
 * itself, by how long the labels are), so they never run into each other on a phone.
 */
export function XLabels({ items }: { items: { frac: number; text: string }[] }) {
  const longest = items.reduce((m, item) => Math.max(m, item.text.length), 0)
  const inner = longest <= 6 ? '' : longest <= 13 ? 'hidden @[25rem]:inline' : 'hidden @[37rem]:inline'
  return (
    <div data-axis="x" className="@container absolute inset-x-0 top-full">
      {items.map((item, k) => {
        const end = k === 0 || k === items.length - 1
        return (
          <span
            key={`${item.text}-${k}`}
            className={cn(
              'num absolute top-0 mt-1.5 whitespace-nowrap text-[10.5px] leading-none text-fg-3',
              k === 0 ? '' : k === items.length - 1 ? '-translate-x-full' : '-translate-x-1/2',
              !end && inner,
            )}
            style={{ left: pct(item.frac) }}
          >
            {item.text}
          </span>
        )
      })}
    </div>
  )
}

interface HandleProps {
  id: 'a' | 'b'
  frac: number
  index: number
  max: number
  valueText: string
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void
  onPointerDown: (e: PointerEvent<HTMLElement>) => void
}

/** Cursor handle: a lettered key on top of the cursor line; a slider for assistive tech. */
export function CursorHandle({ id, frac, index, max, valueText, onKeyDown, onPointerDown }: HandleProps) {
  return (
    <button
      type="button"
      role="slider"
      aria-label={`Cursor ${id.toUpperCase()}`}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={index}
      aria-valuetext={valueText}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      className="absolute -top-5 z-[3] grid h-[18px] w-[22px] -translate-x-1/2 cursor-ew-resize touch-none place-items-center rounded-xs border border-fg-3 bg-raised font-mono text-[11px] font-semibold text-fg outline-none focus-visible:border-accent focus-visible:text-accent"
      style={{ left: pct(frac) }}
    >
      {id.toUpperCase()}
    </button>
  )
}

/** Hover readout pinned to the top of the plot, flipping side near the right edge. */
export function HoverReadout({ frac, children }: { frac: number; children: ReactNode }) {
  const right = frac > 0.7
  return (
    <div
      className="pointer-events-none absolute top-1 z-10 rounded-sm border border-line bg-raised px-2.5 py-1.5 shadow-pop"
      style={right ? { right: `calc(${pct(1 - frac)} + 10px)` } : { left: `calc(${pct(frac)} + 10px)` }}
    >
      {children}
    </div>
  )
}
