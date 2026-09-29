import type { PnlLimitation } from '@/types/domain'

/** Why a PnL figure is partial, in words (see src/lib/pnl.ts). Shared by the web app and the bot. */
export const LIMITATION_TEXT: Record<PnlLimitation, string> = {
  'unknown-cost-units': 'Some tokens arrived by transfer or were paid for with a token without a price: their cost is unknown and left out.',
  'unknown-proceeds': 'Some sales were paid in a token without a price: their result is unknown and left out.',
  'history-incomplete': 'The history NearKit could read doesn’t explain the whole balance (older or unindexed transactions): figures cover what it could read.',
  'no-current-price': 'No current price: unrealized PnL is unknown.',
}
