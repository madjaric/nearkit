import { isKitToken, KIT, type KitConfig } from '@/config/kit'
import { NATIVE_TOKEN_ID, NETWORKS, type NetworkId } from '@/config/networks'
import type { TokenId, TokenListing } from '@/types/domain'

type Listed = Pick<TokenListing, 'id' | 'isNative' | 'status'>

/** The token a trade tool opens on: the first of `preferred` that is listed here, else the first listed token that isn't NEAR, else NEAR. */
export function openingToken(tokens: readonly Listed[], preferred: readonly (TokenId | null)[]): TokenId {
  for (const id of preferred) if (id !== null && tokens.some((t) => t.id === id)) return id
  return tokens.find((t) => !t.isNative && t.status === 'listed')?.id ?? NATIVE_TOKEN_ID
}

/** $KITS' id (its canonical contract, config/kit.ts) while it is listed in this build; null where it isn't (testnet, or not live yet). */
export function listedKit(tokens: readonly Listed[], kit: Pick<KitConfig, 'contract'> = KIT): TokenId | null {
  return tokens.find((t) => isKitToken(t.id, kit) && t.status === 'listed')?.id ?? null
}

/**
 * The token Quick Trade, Swap, Multi Trade and the Volume Bot open on: $KITS, the NEARKITS token
 * (its one configuration, config/kit.ts), while it is listed here; else the network's configured
 * default (Black Dragon on mainnet, USDT on testnet); else the first listed token.
 */
export function kitsFirstToken(tokens: readonly Listed[], network: NetworkId, kit: Pick<KitConfig, 'contract'> = KIT): TokenId {
  return openingToken(tokens, [listedKit(tokens, kit), NETWORKS[network].defaultTradeToken])
}
