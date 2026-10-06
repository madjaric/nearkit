import { HIGH_SLIPPAGE } from '@/lib/fees'
import { readHandoffId } from '@/services/telegramLink'

export interface Prefill {
  amount?: string
  slippage?: number
  /** A trade prepared in the Telegram bot. */
  handoff: string | null
}

/**
 * Amount and slippage from a link, only when they are exactly what the form would accept. A link
 * anyone can make never sets a high slippage: above HIGH_SLIPPAGE it is the user's to set, on the form.
 */
export function readPrefill(params: URLSearchParams): Prefill {
  const amount = params.get('amount') ?? ''
  const slippage = Number(params.get('slippage'))
  return {
    ...(/^\d{1,30}(\.\d{1,24})?$/.test(amount) ? { amount } : {}),
    ...(params.has('slippage') && slippage > 0 && slippage <= HIGH_SLIPPAGE ? { slippage } : {}),
    handoff: readHandoffId(params.get('tg')),
  }
}
