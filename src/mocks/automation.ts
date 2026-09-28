import type { CopyRule, DcaPlan, SniperConfig } from '@/types/domain'
import { TOKEN_IDS } from './tokens'
import { DAY, HOUR, SEED_NOW } from './time'

export const SEED_DCA: DcaPlan[] = [
  {
    id: 'dca-201',
    tokenId: TOKEN_IDS.blackdragon,
    amountNear: 1,
    frequency: '4h',
    startAt: SEED_NOW - 4 * DAY,
    endAt: SEED_NOW + 26 * DAY,
    walletId: 'w01',
    createdAt: SEED_NOW - 4 * DAY - 2 * HOUR,
    status: 'standby',
  },
]

/** Copy trade starts empty so the first-run state is visible. */
export const SEED_COPY: CopyRule[] = []

export const SEED_SNIPER: SniperConfig[] = []
