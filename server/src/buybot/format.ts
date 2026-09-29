import { NEAR_DECIMALS } from '@/config/networks'
import { formatUnits } from '@/lib/amounts'
import { formatUsd, formatUsdCompact, formatUsdPrice } from '@/lib/format'
import { bold, code, esc, link, shortAccount } from '../telegram/html'

/**
 * The NearKit buy (or sell) alert. Every figure comes from the trade itself (amounts from
 * the chain) or from a named source; a figure that isn't known is left out, never
 * estimated:
 * - USD value: the other side's amounts × NearKit's prices (Coinbase for NEAR, Rhea's list).
 * - NEAR value: exact when the buyer paid NEAR; otherwise converted at those prices and
 *   marked "≈".
 * - Market cap is shown as what it is on NEAR, FDV: total supply (from the token contract)
 *   × this trade's price. Circulating supply isn't known on chain, so nothing called
 *   "market cap" is invented.
 * - Holders: NearBlocks' count, when it answers.
 * - The contract (CA), the buyer and the transaction link are the chain's own.
 */

export interface BuyView {
  side: 'buy' | 'sell'
  symbol: string
  name: string
  /** The token contract (CA). */
  token: string
  decimals: number
  /** Tokens bought, or sold. */
  amount: bigint
  /** The other side: what the buyer paid, or what the seller received. */
  paid: { text: string }[]
  paidUsd: number | null
  /** The other side's value in yoctoNEAR (null when a leg has no price). */
  valueNear: bigint | null
  /** True when the other side was NEAR alone (the NEAR value is then exact, and already shown). */
  paidInNear: boolean
  buyer: string
  buyerUrl: string
  txUrl: string
  /** USD per token at this trade (the other side's USD ÷ tokens). */
  priceUsd: number | null
  fdvUsd: number | null
  /** Holder count from NearBlocks, when it answered. */
  holders: number | null
  emoji: string
  emojiCount: number
  networkLabel: string
  preview?: boolean
}

/** Default cap on emoji in one header; each group can set its own. */
export const MAX_EMOJI = 30
/** Telegram's limit for a media caption. */
export const CAPTION_LIMIT = 1024

/** One emoji per `step` of value, at least one, at most `max`. Unknown value: one. */
export function emojiCount(value: number | null, step: number, max: number = MAX_EMOJI): number {
  if (value === null || !(step > 0)) return 1
  return Math.max(1, Math.min(max, Math.floor(value / step)))
}

/** Token amounts: grouped, with fewer decimals for bigger numbers. */
export function tokenAmount(raw: bigint, decimals: number): string {
  const whole = raw / 10n ** BigInt(decimals)
  const maxFraction = whole >= 1000n ? 0 : whole >= 1n ? 2 : 6
  return formatUnits(raw, decimals, { maxFraction, group: true })
}

export function renderBuy(v: BuyView): string {
  const sell = v.side === 'sell'
  const header = (sell ? '🔴' : v.emoji).repeat(v.emojiCount)
  const other = `💸 ${bold(v.paid.map((p) => p.text).join(' + '))}${v.paidUsd !== null ? ` (${esc(formatUsd(v.paidUsd))})` : ''}`
  const tokens = `🪙 ${bold(`${tokenAmount(v.amount, v.decimals)} ${v.symbol}`)}`
  const lines = [
    ...(v.preview ? [`🧪 <b>Preview</b>: not a real ${sell ? 'sale' : 'buy'}. The figures below show the layout only.`, ''] : []),
    header,
    `${bold(`$${v.symbol} ${sell ? 'Sell' : 'Buy!'}`)} · ${esc(v.name)}${v.networkLabel === 'Testnet' ? ' · testnet' : ''}`,
    '',
    ...(sell ? [tokens, other] : [other, tokens]),
  ]
  if (!v.paidInNear && v.valueNear !== null) lines.push(`Ⓝ ≈ ${esc(formatUnits(v.valueNear, NEAR_DECIMALS, { maxFraction: 4, group: true }))} NEAR`)
  lines.push(`👤 ${link(v.buyerUrl, shortAccount(v.buyer, 32))}`)
  if (v.priceUsd !== null) lines.push(`💵 Price ${esc(formatUsdPrice(v.priceUsd))} (this ${sell ? 'sale' : 'buy'})`)
  if (v.fdvUsd !== null) lines.push(`🏦 Market cap (FDV) ${esc(formatUsdCompact(v.fdvUsd))}: total supply × this price`)
  if (v.holders !== null) lines.push(`👥 Holders ${esc(v.holders.toLocaleString('en-US'))} (NearBlocks)`)
  lines.push(`📄 CA ${code(v.token)}`)
  lines.push(`🔗 ${link(v.txUrl, 'Transaction')} · ⚡ NearKit`)
  return lines.join('\n')
}
