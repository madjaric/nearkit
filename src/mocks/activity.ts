import type { ActivityItem } from '@/types/domain'
import { DAY, HOUR, MINUTE, SEED_NOW } from './time'

export const SEED_ACTIVITY: ActivityItem[] = [
  { id: 'act-9', kind: 'swap', title: 'Bought BLACKDRAGON', detail: '25.00 NEAR → 8,845,210 BLACKDRAGON · Main', at: SEED_NOW - 2 * HOUR - 12 * MINUTE, origin: 'seed' },
  { id: 'act-8', kind: 'multi-trade', title: 'Multi buy SHITZU', detail: '5 wallets · 10.00 NEAR total', at: SEED_NOW - 7 * HOUR, origin: 'seed' },
  { id: 'act-7', kind: 'split', title: 'Split KITS', detail: '400,000 KITS to 4 wallets', at: SEED_NOW - 26 * HOUR, origin: 'seed' },
  { id: 'act-6', kind: 'order', title: 'Limit buy placed', detail: 'BLACKDRAGON at $0.00000700 · 250 NEAR', at: SEED_NOW - 26 * HOUR - 20 * MINUTE, origin: 'seed' },
  { id: 'act-5', kind: 'consolidate', title: 'Consolidated NEAR', detail: '6 wallets → Main · 214.60 NEAR', at: SEED_NOW - 2 * DAY - 3 * HOUR, origin: 'seed' },
  { id: 'act-4', kind: 'batch-send', title: 'Batch send SHITZU', detail: '3 recipients · 850 SHITZU', at: SEED_NOW - 3 * DAY, origin: 'seed' },
  { id: 'act-3', kind: 'swap', title: 'Sold SHITZU', detail: '12,000 SHITZU → 43.12 NEAR · Wallet 02', at: SEED_NOW - 3 * DAY - 5 * HOUR, origin: 'seed' },
  { id: 'act-2', kind: 'automation', title: 'DCA plan created', detail: '1 NEAR of BLACKDRAGON every 4 hours', at: SEED_NOW - 4 * DAY - 2 * HOUR, origin: 'seed' },
]
