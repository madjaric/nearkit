import { isKitToken, KIT, type KitConfig } from '@/config/kit'
import { NATIVE_TOKEN_ID } from '@/config/networks'
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
