import { NEAR_DECIMALS } from '@/config/networks'
import { formatUnits } from '@/lib/amounts'
import type { PnlLimitation } from '@/types/domain'
import { toNearKitError } from '@/services/near/errors'
import type { Logger } from '../log'

/**
 * How the bot writes numbers and errors. One rule above all: an unknown figure is
 * shown as —, never as 0 (0 means a computed zero).
 */

export const UNKNOWN = '—'

/** A token amount: grouped, at most `maxFraction` decimals, never rounded up. */
export function amountText(raw: bigint, decimals: number, maxFraction = 4): string {
  return formatUnits(raw, decimals, { maxFraction, group: true })
}

/** NEAR with at least two decimals, e.g. 2.00, 0.4393. */
export function nearText(raw: bigint, maxFraction = 4): string {
  const s = amountText(raw, NEAR_DECIMALS, maxFraction)
  const [whole, fraction = ''] = s.split('.')
  return `${whole}.${fraction.padEnd(2, '0')}`
}

/** A few words for why a PnL figure is unknown or partial, for compact lines. */
export const LIMITATION_TAG: Record<PnlLimitation, string> = {
  'no-current-price': 'no price',
  'unknown-cost-units': 'cost unknown',
  'unknown-proceeds': 'sale value unknown',
  'history-incomplete': 'history incomplete',
}

/**
 * Any error as a short message for Telegram. The technical details go to the log,
 * never to the chat, and nothing secret is ever part of either.
 */
export function friendlyError(e: unknown, opts: { network: 'mainnet' | 'testnet'; side?: 'buy' | 'sell'; log?: Logger; context?: string }): string {
  const err = toNearKitError(e)
  opts.log?.warn(opts.context ?? 'bot action failed', { code: err.code, message: err.message, detail: err.detail })
  const other = opts.network === 'mainnet' ? 'testnet' : 'mainnet'
  switch (err.code) {
    case 'QUOTE_UNAVAILABLE':
      return /no route/i.test(err.message) ? 'No route is available for this pair right now.' : 'Quotes are unavailable right now. Try again in a moment.'
    case 'QUOTE_REJECTED':
      return 'NearKit refused the route it was offered, so nothing was prepared. Try again in a moment.'
    case 'QUOTE_EXPIRED':
      return 'That quote expired. Get a fresh one.'
    case 'SLIPPAGE_EXCEEDED':
      return 'The price moved past your slippage. Get a fresh quote.'
    case 'INSUFFICIENT_BALANCE':
      return opts.side === 'sell' ? 'Not enough of this token for that amount.' : 'Not enough NEAR for this trade plus gas.'
    case 'INSUFFICIENT_GAS':
      return 'Not enough NEAR left to pay for gas.'
    case 'NETWORK_MISMATCH':
      return `This belongs to NEAR ${other} while NearKit is using ${opts.network}.`
    case 'INVALID_TOKEN':
    case 'INVALID_AMOUNT':
    case 'INVALID_ACCOUNT':
    case 'EXECUTION_DISABLED':
      // Already written for people, about their own input or a setting.
      return err.message
    case 'RPC_ERROR':
      return 'The NEAR network isn’t answering right now. Try again in a moment.'
    default:
      return 'Something went wrong. Nothing was sent or signed. Try again in a moment.'
  }
}
