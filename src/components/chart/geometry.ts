/**
 * Chart geometry is resolution-independent: x is a fraction of the plot box
 * width (laid out by CSS), y is pixels inside a fixed-height plot. SVG marks
 * draw in a 1000-unit-wide viewBox stretched to the box with non-scaling
 * strokes, and dots, labels and cursors are HTML placed by percentage. Nothing
 * depends on a measured width, so a resize can never desync marks from axes.
 */
export const VIEW_W = 1000

export interface Pad {
  top: number
  right: number
  bottom: number
  left: number
}

export function xFrac(index: number, count: number): number {
  return count > 1 ? index / (count - 1) : 0
}

export function yScale(domain: [number, number], plotHeight: number) {
  const [lo, hi] = domain
  const span = hi - lo || 1
  return (v: number) => plotHeight * (1 - (v - lo) / span)
}

/** Polyline path in viewBox units (x 0–1000, y in plot pixels). */
export function linePath(values: number[], y: (v: number) => number): string {
  const n = values.length
  return values.map((v, i) => `${i ? 'L' : 'M'}${(xFrac(i, n) * VIEW_W).toFixed(2)},${y(v).toFixed(2)}`).join('')
}

/** Nearest sample index for a pointer x inside the plot element. */
export function indexAtPointer(clientX: number, plot: HTMLElement, count: number): number {
  const rect = plot.getBoundingClientRect()
  const frac = rect.width > 0 ? (clientX - rect.left) / rect.width : 0
  return Math.max(0, Math.min(count - 1, Math.round(frac * (count - 1))))
}

export const pct = (frac: number) => `${(frac * 100).toFixed(4)}%`

/** Time per graticule division, rounded the way a scope's time base reads (17h, 9d). */
export function formatDivision(ms: number): string {
  const hours = ms / 3_600_000
  if (hours >= 48) return `${Math.round(hours / 24)}d`
  if (hours >= 1) return `${Math.round(hours)}h`
  return `${Math.max(1, Math.round(ms / 60_000))}m`
}
