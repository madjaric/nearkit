import { formatUnits } from '@/lib/amounts'
import { formatUsd, formatUsdCompact, formatUsdPrice } from '@/lib/format'
import { bold, esc, link, shortAccount } from '../telegram/html'

/**
 * The buy alert. Every figure comes from the buy itself (amounts from the chain)
 * or from a named price source; a figure that isn't known is left out, never
 * estimated. Market cap is not shown: circulating supply isn't known on chain.
 * FDV is total supply × this buy's price, and says so.
 */

export interface BuyView {
  symbol: string
  name: string
  decimals: number
  amount: bigint
  paid: { text: string }[]
  paidUsd: number | null
  buyer: string
  buyerUrl: string
  txUrl: string
  /** USD per token at this buy (paid USD / tokens received). */
  priceUsd: number | null
  fdvUsd: number | null
  emoji: string
  emojiCount: number
  networkLabel: string
  preview?: boolean
}

export const MAX_EMOJI = 30

export function emojiCount(valueNear: bigint | null, stepNear: bigint): number {
  if (valueNear === null || stepNear <= 0n) return 1
  const n = Number(valueNear / stepNear)
  return Math.max(1, Math.min(MAX_EMOJI, n))
}

/** Token amounts: grouped, with fewer decimals for bigger numbers. */
export function tokenAmount(raw: bigint, decimals: number): string {
  const whole = raw / 10n ** BigInt(decimals)
  const maxFraction = whole >= 1000n ? 0 : whole >= 1n ? 2 : 6
  return formatUnits(raw, decimals, { maxFraction, group: true })
}

export function renderBuy(v: BuyView): string {
  const header = v.emoji.repeat(v.emojiCount)
  const lines = [
    ...(v.preview ? ['🧪 <b>Preview</b>: not a real buy. The figures below show the layout only.', ''] : []),
    header,
    `${bold(`${v.symbol} buy`)} · ${esc(v.name)}${v.networkLabel === 'Testnet' ? ' · testnet' : ''}`,
    '',
    `💸 ${bold(v.paid.map((p) => p.text).join(' + '))}${v.paidUsd !== null ? ` (${esc(formatUsd(v.paidUsd))})` : ''}`,
    `🪙 ${bold(`${tokenAmount(v.amount, v.decimals)} ${v.symbol}`)}`,
    `👤 ${link(v.buyerUrl, shortAccount(v.buyer, 32))}`,
  ]
  if (v.priceUsd !== null) lines.push(`💵 Price ${esc(formatUsdPrice(v.priceUsd))} (this buy)`)
  if (v.fdvUsd !== null) lines.push(`🏦 FDV ${esc(formatUsdCompact(v.fdvUsd))} (total supply × this price)`)
  lines.push(`🔗 ${link(v.txUrl, 'Transaction')}`)
  return lines.join('\n')
}
