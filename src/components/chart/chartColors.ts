/**
 * The theme's colours (index.css tokens, in oklch) as rgba strings for a canvas chart library that
 * can't parse oklch: each is painted on a 1×1 canvas and read back, so the chart uses exactly the
 * colours the rest of NEARKITS uses. Without a DOM (tests, prerender) the fallbacks stand.
 */

export interface ChartColors {
  text: string
  muted: string
  grid: string
  border: string
  crosshair: string
  labelBg: string
  pos: string
  neg: string
  posVolume: string
  negVolume: string
  live: string
}

const FALLBACK: ChartColors = {
  text: 'rgba(152,158,166,1)',
  muted: 'rgba(110,115,122,1)',
  grid: 'rgba(40,43,48,1)',
  border: 'rgba(52,56,62,1)',
  crosshair: 'rgba(110,115,122,1)',
  labelBg: 'rgba(45,48,54,1)',
  pos: 'rgba(196,232,88,1)',
  neg: 'rgba(238,104,92,1)',
  posVolume: 'rgba(196,232,88,0.32)',
  negVolume: 'rgba(238,104,92,0.32)',
  live: 'rgba(152,158,166,1)',
}

function rgba(ctx: CanvasRenderingContext2D, css: string, alpha = 1): string | null {
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillStyle = '#000'
  ctx.fillStyle = css
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
  if (a === undefined || a === 0) return null
  return `rgba(${r},${g},${b},${Math.round((a / 255) * alpha * 1000) / 1000})`
}

export function chartColors(el: Element | null): ChartColors {
  if (typeof document === 'undefined' || !el) return FALLBACK
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!ctx) return FALLBACK
  const style = getComputedStyle(el)
  const token = (name: string) => style.getPropertyValue(name).trim()
  const pick = (name: string, fallback: string, alpha = 1) => {
    const v = token(name)
    return (v && rgba(ctx, v, alpha)) || fallback
  }
  return {
    text: pick('--color-fg-3', FALLBACK.text),
    muted: pick('--color-fg-4', FALLBACK.muted),
    grid: pick('--color-line-soft', FALLBACK.grid),
    border: pick('--color-line', FALLBACK.border),
    crosshair: pick('--color-fg-4', FALLBACK.crosshair),
    labelBg: pick('--color-raised', FALLBACK.labelBg),
    pos: pick('--color-pos', FALLBACK.pos),
    neg: pick('--color-neg', FALLBACK.neg),
    posVolume: pick('--color-pos', FALLBACK.posVolume, 0.32),
    negVolume: pick('--color-neg', FALLBACK.negVolume, 0.32),
    live: pick('--color-fg-2', FALLBACK.live),
  }
}
