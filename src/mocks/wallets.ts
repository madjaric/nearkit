import { hexFromSeed } from '@/lib/prng'
import type { Holding, Wallet, WalletPreset } from '@/types/domain'
import { TOKEN_IDS } from './tokens'
import { DAY, SEED_NOW } from './time'

/** Main is a named demo account; the rest are NearKit-managed implicit accounts. */
export const MAIN_ACCOUNT = 'demo-trader.near'

const pad = (n: number) => String(n).padStart(2, '0')

export const SEED_WALLETS: Wallet[] = Array.from({ length: 12 }, (_, i) => {
  const n = i + 1
  if (n === 1) return { id: 'w01', label: 'Main', accountId: MAIN_ACCOUNT, kind: 'named', isMain: true }
  return { id: `w${pad(n)}`, label: `Wallet ${pad(n)}`, accountId: hexFromSeed(`nearkit-demo-wallet-${n}`), kind: 'implicit', isMain: false }
})

const NEAR_BALANCES = [8420.55, 1142.2, 612.75, 488.1, 364.33, 118.4, 96.25, 84.6, 72.15, 41.8, 36.2, 12.95]

export const SEED_HOLDINGS: Holding[] = [
  ...NEAR_BALANCES.map((amount, i) => ({ walletId: `w${pad(i + 1)}`, tokenId: TOKEN_IDS.near, amount })),
  // KITS: the split example (1,000,000 from Main) and the consolidate example (427,560 across 02–05).
  { walletId: 'w01', tokenId: TOKEN_IDS.kits, amount: 1_250_000 },
  { walletId: 'w02', tokenId: TOKEN_IDS.kits, amount: 82_420 },
  { walletId: 'w03', tokenId: TOKEN_IDS.kits, amount: 112_810 },
  { walletId: 'w04', tokenId: TOKEN_IDS.kits, amount: 42_220 },
  { walletId: 'w05', tokenId: TOKEN_IDS.kits, amount: 190_110 },
  { walletId: 'w01', tokenId: TOKEN_IDS.blackdragon, amount: 684_203_110 },
  { walletId: 'w02', tokenId: TOKEN_IDS.blackdragon, amount: 152_000_000 },
  { walletId: 'w03', tokenId: TOKEN_IDS.blackdragon, amount: 88_500_000 },
  { walletId: 'w06', tokenId: TOKEN_IDS.blackdragon, amount: 42_800_000 },
  { walletId: 'w07', tokenId: TOKEN_IDS.blackdragon, amount: 38_150_000 },
  { walletId: 'w08', tokenId: TOKEN_IDS.blackdragon, amount: 27_600_000 },
  { walletId: 'w09', tokenId: TOKEN_IDS.blackdragon, amount: 19_440_000 },
  { walletId: 'w01', tokenId: TOKEN_IDS.shitzu, amount: 241_880 },
  { walletId: 'w02', tokenId: TOKEN_IDS.shitzu, amount: 62_400 },
  { walletId: 'w03', tokenId: TOKEN_IDS.shitzu, amount: 18_000 },
]

const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `w${pad(from + i)}`)

export const SEED_PRESETS: WalletPreset[] = [
  { id: 'preset-main', name: 'MAIN', walletIds: ['w01'], note: 'Primary account only', createdAt: SEED_NOW - 40 * DAY, updatedAt: SEED_NOW - 40 * DAY },
  { id: 'preset-trading', name: 'TRADING', walletIds: ids(1, 5), note: 'Day-to-day multi-wallet entries', createdAt: SEED_NOW - 38 * DAY, updatedAt: SEED_NOW - 6 * DAY },
  { id: 'preset-snipers', name: 'SNIPERS', walletIds: ids(3, 12), note: 'Small balances for launch entries', createdAt: SEED_NOW - 21 * DAY, updatedAt: SEED_NOW - 2 * DAY },
  { id: 'preset-test', name: 'TEST', walletIds: ids(10, 12), note: 'Dry runs and new tools', createdAt: SEED_NOW - 9 * DAY, updatedAt: SEED_NOW - 9 * DAY },
]
