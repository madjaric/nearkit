import type { ScanReport } from '@/types/domain'
import { DAY, SEED_NOW } from './time'

/**
 * Scanner samples are fictional tokens on a `.sample.near` namespace so no real
 * project is shown with invented risk data. Three profiles cover the indicator range.
 */
type SampleReport = Omit<ScanReport, 'query' | 'scannedAt'>

export const SCAN_SAMPLES: SampleReport[] = [
  {
    symbol: 'MOSS',
    name: 'Moss',
    contract: 'moss.sample.near',
    sample: true,
    decimals: 18,
    totalSupply: 420_690_000_000,
    holders: 612,
    top10Pct: 71.8,
    creatorPct: 18.5,
    liquidityUsd: 9_400,
    createdAt: SEED_NOW - 3 * DAY,
    indicators: { contractVerified: true, mintEnabled: true, transferRestrictions: 'none', liquidity: 'low' },
    holderBreakdown: [
      { label: 'Creator', pct: 18.5 },
      { label: 'Holders 2–10', pct: 53.3 },
      { label: 'Everyone else', pct: 28.2 },
    ],
    flags: [
      { id: 'concentration', level: 'high', label: 'Top 10 hold 71.8% of supply', detail: 'A few wallets can move the price sharply by selling.' },
      { id: 'mint', level: 'high', label: 'Owner can mint new tokens', detail: 'Supply is not fixed; new tokens can dilute holders.' },
      { id: 'liquidity', level: 'high', label: 'Liquidity is $9.4K', detail: 'Trades above a few hundred dollars will move the price.' },
      { id: 'creator', level: 'elevated', label: 'Creator holds 18.5%', detail: 'Creator-held supply is above 10%.' },
      { id: 'age', level: 'elevated', label: 'Contract is 3 days old', detail: 'Short trading history.' },
      { id: 'verified', level: 'info', label: 'Source code verified', detail: 'Deployed code matches published source.' },
    ],
  },
  {
    symbol: 'ORBIT',
    name: 'Orbit',
    contract: 'orbit.sample.near',
    sample: true,
    decimals: 24,
    totalSupply: 1_000_000_000,
    holders: 4_812,
    top10Pct: 38.4,
    creatorPct: 2.1,
    liquidityUsd: 184_200,
    createdAt: SEED_NOW - 214 * DAY,
    indicators: { contractVerified: true, mintEnabled: false, transferRestrictions: 'none', liquidity: 'locked' },
    holderBreakdown: [
      { label: 'Creator', pct: 2.1 },
      { label: 'Holders 2–10', pct: 36.3 },
      { label: 'Everyone else', pct: 61.6 },
    ],
    flags: [
      { id: 'concentration', level: 'info', label: 'Top 10 hold 38.4% of supply', detail: 'Below the 50% level that commonly signals concentration.' },
      { id: 'mint', level: 'info', label: 'Minting disabled', detail: 'Total supply is fixed at deployment.' },
      { id: 'liquidity', level: 'info', label: 'Liquidity locked', detail: 'Pool tokens are held by a time-lock contract.' },
      { id: 'verified', level: 'info', label: 'Source code verified', detail: 'Deployed code matches published source.' },
    ],
  },
  {
    symbol: 'GRID',
    name: 'Grid Protocol',
    contract: 'grid.sample.near',
    sample: true,
    decimals: 18,
    totalSupply: 50_000_000,
    holders: 1_944,
    top10Pct: 52.2,
    creatorPct: 6.4,
    liquidityUsd: 41_000,
    createdAt: SEED_NOW - 41 * DAY,
    indicators: { contractVerified: false, mintEnabled: false, transferRestrictions: 'pausable', liquidity: 'unlocked' },
    holderBreakdown: [
      { label: 'Creator', pct: 6.4 },
      { label: 'Holders 2–10', pct: 45.8 },
      { label: 'Everyone else', pct: 47.8 },
    ],
    flags: [
      { id: 'verified', level: 'high', label: 'Source code not verified', detail: 'Deployed code cannot be matched to published source.' },
      { id: 'transfers', level: 'high', label: 'Owner can pause transfers', detail: 'The contract exposes a pause function that can freeze transfers.' },
      { id: 'concentration', level: 'elevated', label: 'Top 10 hold 52.2% of supply', detail: 'Just above the 50% concentration level.' },
      { id: 'liquidity', level: 'elevated', label: 'Liquidity not locked', detail: 'Pool tokens can be withdrawn by their holder at any time.' },
      { id: 'mint', level: 'info', label: 'Minting disabled', detail: 'Total supply is fixed at deployment.' },
    ],
  },
]
