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

/** Each point's x as a fraction of the plot: by its time when `byTime` (so a gap in time stays a gap), else evenly by index. */
export function xFracs(times: readonly number[], byTime: boolean): number[] {
  const n = times.length
  const t0 = times[0] ?? 0
  const t1 = times[n - 1] ?? 0
  if (!byTime || n < 2 || !(t1 > t0)) return times.map((_, i) => xFrac(i, n))
  return times.map((t) => (t - t0) / (t1 - t0))
}

/** Polyline through points at `fracs`; after a break a new segment starts, so no line is drawn across a gap. */
export function linePathAt(fracs: readonly number[], values: readonly number[], y: (v: number) => number, breaks?: readonly boolean[]): string {
  return values.map((v, i) => `${i === 0 || breaks?.[i] ? 'M' : 'L'}${((fracs[i] ?? 0) * VIEW_W).toFixed(2)},${y(v).toFixed(2)}`).join('')
}

/** The sample whose x is nearest to `frac` (0–1), for points not evenly spaced. */
export function nearestAt(fracs: readonly number[], frac: number): number {
  let best = 0
  for (let i = 1; i < fracs.length; i += 1) if (Math.abs((fracs[i] ?? 0) - frac) < Math.abs((fracs[best] ?? 0) - frac)) best = i
  return best
}

/** A pointer's x as a fraction (0–1) of the plot element. */
export function pointerFrac(clientX: number, plot: HTMLElement): number {
  const rect = plot.getBoundingClientRect()
  return rect.width > 0 ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0
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
