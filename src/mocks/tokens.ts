import type { MarketQuote, Token, TokenId } from '@/types/domain'

/**
 * Demo token universe. Contracts for listed tokens are their real NEAR accounts,
 * $KITS' included (kits.nearlytrade.near); every price and market figure below is
 * demo data for the preview.
 */
export const TOKEN_IDS = {
  near: 'near',
  kits: 'kits.nearlytrade.near',
  blackdragon: 'blackdragon.tkn.near',
  shitzu: 'token.0xshitzu.near',
  usdc: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
} as const satisfies Record<string, TokenId>

export const SEED_TOKENS: Token[] = [
  { id: TOKEN_IDS.near, symbol: 'NEAR', name: 'NEAR', decimals: 24, contract: 'wrap.near', isNative: true, status: 'listed' },
  { id: TOKEN_IDS.kits, symbol: 'KITS', name: 'Near Kits', decimals: 18, contract: TOKEN_IDS.kits, status: 'listed' },
  { id: TOKEN_IDS.blackdragon, symbol: 'BLACKDRAGON', name: 'Black Dragon', decimals: 24, contract: TOKEN_IDS.blackdragon, status: 'listed' },
  { id: TOKEN_IDS.shitzu, symbol: 'SHITZU', name: 'Shitzu', decimals: 18, contract: TOKEN_IDS.shitzu, status: 'listed' },
  { id: TOKEN_IDS.usdc, symbol: 'USDC', name: 'USD Coin', decimals: 6, contract: TOKEN_IDS.usdc, status: 'listed' },
]

type SeedMarket = Omit<MarketQuote, 'updatedAt' | 'priceNear'>

export const SEED_MARKET: SeedMarket[] = [
  { tokenId: TOKEN_IDS.near, priceUsd: 2.84, change24hPct: 2.18, liquidityUsd: 0, volume24hUsd: 0 },
  { tokenId: TOKEN_IDS.kits, priceUsd: 0.000538, change24hPct: 8.62, liquidityUsd: 96_400, volume24hUsd: 38_900 },
  { tokenId: TOKEN_IDS.blackdragon, priceUsd: 0.00000788, change24hPct: -6.31, liquidityUsd: 412_300, volume24hUsd: 221_800 },
  { tokenId: TOKEN_IDS.shitzu, priceUsd: 0.01046, change24hPct: 3.07, liquidityUsd: 286_100, volume24hUsd: 64_200 },
  { tokenId: TOKEN_IDS.usdc, priceUsd: 1, change24hPct: 0.01, liquidityUsd: 4_210_000, volume24hUsd: 1_380_000 },
]

/** Average entry per token for the demo portfolio (USD). */
export const SEED_COST_BASIS: Record<TokenId, number> = {
  [TOKEN_IDS.near]: 2.41,
  [TOKEN_IDS.kits]: 0.000412,
  [TOKEN_IDS.blackdragon]: 0.00000921,
  [TOKEN_IDS.shitzu]: 0.00981,
}
