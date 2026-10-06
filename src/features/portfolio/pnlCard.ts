import { formatNumber, formatPct, formatPrice, formatUsdPrice, NEAR_FORMAT, USD_FORMAT, formatDate } from '@/lib/format'
import type { PnlLimitation, PnlRange, PnlReport, Position } from '@/types/domain'
import { LIMITATION_SHORT } from './pnlText'

/**
 * A shareable PnL card: figures from the one PnL engine (src/lib/pnl.ts), never
 * recomputed here, drawn onto a 1200×630 canvas. Partial figures say so on the card,
 * and demo data is marked as demo, so a card can't pass for more than it is.
 */

type Tone = 'pos' | 'neg' | 'flat'

export interface PnlCard {
  title: string
  scope: string
  headline: { label: string; value: string; tone: Tone }
  pct: { value: string; tone: Tone } | null
  rows: { label: string; value: string }[]
  method: string
  partial: string | null
  /** e.g. "NEAR mainnet"; null for the demo, which has no network. */
  network: string | null
  demo: boolean
  at: number
}

const toneOf = (v: number): Tone => (v > 0 ? 'pos' : v < 0 ? 'neg' : 'flat')
const partialOf = (limits: readonly PnlLimitation[] | undefined): string | null => (limits?.length ? `Partial: ${limits.map((l) => LIMITATION_SHORT[l]).join(', ')}` : null)
const networkName = (network: 'mainnet' | 'testnet' | null) => (network ? `NEAR ${network}` : null)

const SCOPE: Record<PnlRange, string> = { '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days', all: 'All time' }

/** A position's card, or null when there is no total to show (no current price). */
export function cardFromPosition(position: Position, opts: { usd: boolean; network: 'mainnet' | 'testnet' | null; demo: boolean; at: number }): PnlCard | null {
  const pnl = position.pnl
  if (!pnl) return null
  const inUsd = opts.usd && pnl.usd.total !== null && pnl.usd.invested > 0
  const f = inUsd ? pnl.usd : pnl.near
  if (f.total === null) return null
  const money = inUsd ? USD_FORMAT : NEAR_FORMAT
  const price = (v: number | null) => (v === null ? '—' : inUsd ? formatUsdPrice(v) : `${formatPrice(v)} NEAR`)
  return {
    title: position.token.symbol,
    scope: 'Position',
    headline: { label: 'Total PnL', value: money.full(f.total, { signed: true }), tone: toneOf(f.total) },
    pct: f.pnlPct === null ? null : { value: formatPct(f.pnlPct), tone: toneOf(f.pnlPct) },
    rows: [
      { label: 'Cost basis', value: money.full(f.costBasis) },
      { label: 'Realized', value: money.full(f.realized, { signed: true }) },
      { label: 'Unrealized', value: f.unrealized === null ? '—' : money.full(f.unrealized, { signed: true }) },
      { label: 'Avg entry', value: price(f.avgEntry) },
    ],
    method: inUsd ? 'Average cost · USD at each trade’s hour' : 'Average cost · in NEAR, exact',
    partial: partialOf(pnl.limitations),
    network: networkName(opts.network),
    demo: opts.demo,
    at: opts.at,
  }
}

/** The PnL page's card for its range: realized in the range plus unrealized now. */
export function cardFromReport(r: PnlReport, opts: { network: 'mainnet' | 'testnet' | null; at: number }): PnlCard {
  const money = r.currency === 'NEAR' ? NEAR_FORMAT : USD_FORMAT
  // Unknown stays unknown: a total needs both parts.
  const total = r.realizedUsd === null || r.unrealizedUsd === null ? null : r.realizedUsd + r.unrealizedUsd
  const fig = (v: number | null) => (v === null ? '—' : money.full(v, { signed: true }))
  const judged = r.wins + r.losses
  return {
    title: 'Portfolio',
    scope: SCOPE[r.range],
    headline: { label: 'Total PnL', value: fig(total), tone: total === null ? 'flat' : toneOf(total) },
    pct: null,
    rows: [
      { label: 'Realized', value: fig(r.realizedUsd) },
      { label: 'Unrealized', value: fig(r.unrealizedUsd) },
      { label: 'Closed trades', value: formatNumber(r.trades, 0, 0) },
      { label: 'Win rate', value: judged > 0 ? `${formatNumber(r.winRatePct, 0, 1)}%` : '—' },
    ],
    method: r.currency === 'NEAR' ? 'Average cost · in NEAR, exact' : 'Average cost · USD at each trade’s hour',
    partial: r.complete === false ? (partialOf(r.limitations) ?? 'Partial') : null,
    network: networkName(opts.network),
    demo: r.source !== 'chain',
    at: opts.at,
  }
}

// ─── drawing ────────────────────────────────────────────────────────────────

export const CARD_WIDTH = 1200
export const CARD_HEIGHT = 630

const MONO = "'JetBrains Mono Variable', ui-monospace, Menlo, Consolas, monospace"
const SANS = "'Archivo Variable', ui-sans-serif, system-ui, sans-serif"

/** Design tokens as the page resolved them, so the card matches the app. */
function palette() {
  const css = getComputedStyle(document.documentElement)
  const token = (name: string, fallback: string) => css.getPropertyValue(`--color-${name}`).trim() || fallback
  return {
    canvas: token('canvas', '#1b1c19'),
    panel: token('panel', '#232420'),
    line: token('line', '#393a36'),
    lineStrong: token('line-strong', '#51524d'),
    fg: token('fg', '#f1f1ee'),
    fg2: token('fg-2', '#b8b9b3'),
    fg3: token('fg-3', '#94958f'),
    accent: token('accent', '#d7f25a'),
    pos: token('pos', '#b9ec6c'),
    neg: token('neg', '#f0786a'),
    warn: token('warn', '#eebf6b'),
  }
}

/** Largest font size (from `max` down) at which `text` fits in `width`. */
function fit(ctx: CanvasRenderingContext2D, text: string, font: (size: number) => string, max: number, width: number): number {
  for (let size = max; size > 12; size -= 2) {
    ctx.font = font(size)
    if (ctx.measureText(text).width <= width) return size
  }
  return 12
}

/** Waits for the app's fonts, so the canvas doesn't fall back to system fonts. */
export async function loadCardFonts(): Promise<void> {
  await Promise.all([document.fonts.load(`400 48px ${MONO}`), document.fonts.load(`600 24px ${SANS}`), document.fonts.load(`700 24px ${SANS}`)]).catch(() => undefined)
}

export function drawPnlCard(canvas: HTMLCanvasElement, card: PnlCard, account: string | null): void {
  canvas.width = CARD_WIDTH
  canvas.height = CARD_HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const c = palette()
  const tone = (t: Tone) => (t === 'pos' ? c.pos : t === 'neg' ? c.neg : c.fg)
  const pad = 64

  // Panel with corner ticks, like the app's instrument frame.
  ctx.fillStyle = c.canvas
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT)
  ctx.fillStyle = c.panel
  ctx.fillRect(24, 24, CARD_WIDTH - 48, CARD_HEIGHT - 48)
  ctx.strokeStyle = c.line
  ctx.lineWidth = 2
  ctx.strokeRect(25, 25, CARD_WIDTH - 50, CARD_HEIGHT - 50)
  ctx.strokeStyle = c.lineStrong
  for (const [x, y, dx, dy] of [
    [24, 24, 1, 1],
    [CARD_WIDTH - 24, 24, -1, 1],
    [24, CARD_HEIGHT - 24, 1, -1],
    [CARD_WIDTH - 24, CARD_HEIGHT - 24, -1, -1],
  ] as const) {
    ctx.beginPath()
    ctx.moveTo(x + dx * 22, y)
    ctx.lineTo(x, y)
    ctx.lineTo(x, y + dy * 22)
    ctx.stroke()
  }

  // Wordmark: NEARKITS.
  ctx.textBaseline = 'alphabetic'
  ctx.font = `700 30px ${SANS}`
  ctx.letterSpacing = '2px'
  ctx.fillStyle = c.fg
  ctx.fillText('NEARKITS', pad, 96)

  // Chips, right-aligned: network, and DEMO when it is.
  ctx.font = `600 18px ${SANS}`
  ctx.letterSpacing = '2px'
  let right = CARD_WIDTH - pad
  for (const chip of [...(card.network ? [card.network.toUpperCase()] : []), ...(card.demo ? ['DEMO DATA'] : [])].reverse()) {
    const w = ctx.measureText(chip).width + 28
    ctx.strokeStyle = chip === 'DEMO DATA' ? c.warn : c.lineStrong
    ctx.lineWidth = 2
    ctx.strokeRect(right - w, 70, w, 36)
    ctx.fillStyle = chip === 'DEMO DATA' ? c.warn : c.fg2
    ctx.fillText(chip, right - w + 14, 95)
    right -= w + 12
  }

  // Title and scope.
  ctx.letterSpacing = '0px'
  ctx.fillStyle = c.fg
  const titleSize = fit(ctx, card.title, (s) => `650 ${s}px ${SANS}`, 44, CARD_WIDTH - 2 * pad)
  ctx.font = `650 ${titleSize}px ${SANS}`
  ctx.fillText(card.title, pad, 176)
  ctx.font = `600 20px ${SANS}`
  ctx.letterSpacing = '3px'
  ctx.fillStyle = c.fg3
  ctx.fillText(`${card.scope.toUpperCase()} · ${card.headline.label.toUpperCase()}`, pad, 214)

  // Headline figure and return.
  ctx.letterSpacing = '0px'
  const pctText = card.pct?.value ?? ''
  ctx.font = `400 44px ${MONO}`
  const pctWidth = pctText ? ctx.measureText(pctText).width + 32 : 0
  const size = fit(ctx, card.headline.value, (s) => `400 ${s}px ${MONO}`, 104, CARD_WIDTH - 2 * pad - pctWidth)
  ctx.font = `400 ${size}px ${MONO}`
  ctx.fillStyle = tone(card.headline.tone)
  ctx.fillText(card.headline.value, pad, 322)
  if (card.pct) {
    const w = ctx.measureText(card.headline.value).width
    ctx.font = `400 44px ${MONO}`
    ctx.fillStyle = tone(card.pct.tone)
    ctx.fillText(card.pct.value, pad + w + 32, 322)
  }

  // Figures: four columns under a rule.
  ctx.strokeStyle = c.line
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(pad, 372)
  ctx.lineTo(CARD_WIDTH - pad, 372)
  ctx.stroke()
  const col = (CARD_WIDTH - 2 * pad) / card.rows.length
  card.rows.forEach((row, i) => {
    const left = pad + i * col
    ctx.font = `600 17px ${SANS}`
    ctx.letterSpacing = '2px'
    ctx.fillStyle = c.fg3
    ctx.fillText(row.label.toUpperCase(), left, 414)
    ctx.letterSpacing = '0px'
    const vs = fit(ctx, row.value, (s) => `400 ${s}px ${MONO}`, 32, col - 24)
    ctx.font = `400 ${vs}px ${MONO}`
    ctx.fillStyle = row.value.startsWith('+') ? c.pos : row.value.startsWith('−') ? c.neg : c.fg
    ctx.fillText(row.value, left, 458)
  })

  // Footer: method and date; partial in warning color; the account only if asked.
  ctx.font = `400 19px ${SANS}`
  ctx.fillStyle = c.fg3
  ctx.fillText(`${card.method} · ${card.demo ? 'simulated demo history' : 'on-chain history'} · ${formatDate(card.at, true)}`, pad, 540)
  if (card.partial) {
    ctx.fillStyle = c.warn
    ctx.font = `600 19px ${SANS}`
    ctx.fillText(card.partial, pad, 572)
  }
  if (account) {
    ctx.font = `400 19px ${MONO}`
    ctx.fillStyle = c.fg2
    const text = account.length > 42 ? `${account.slice(0, 20)}…${account.slice(-18)}` : account
    ctx.textAlign = 'right'
    ctx.fillText(text, CARD_WIDTH - pad, card.partial ? 572 : 540)
    ctx.textAlign = 'left'
  }
}
