/**
 * Wallet dust: when a NEARKITS wallet may be deleted. Sending everything out of a wallet leaves a
 * little NEAR behind (the transaction's gas is held up front and its unused part is refunded after),
 * so "empty" can't mean zero. Below 0.05 NEAR the wallet holds dust: it may be deleted, and that dust
 * stays on chain where nobody can move it once the key is erased. At 0.05 NEAR and above it holds a
 * balance and is not deleted. Tokens are never dust: any token balance, or a token list that could
 * not be read in full, keeps the wallet. The web, the bot and the signer apply this same line.
 */

export const WALLET_DUST_NEAR = 0.05
export const WALLET_DUST_YOCTO = 50_000_000_000_000_000_000_000n

export interface WalletHoldingsView {
  /** False until the account first receives NEAR; null when it couldn't be read. */
  exists: boolean | null
  /** The account's NEAR (its liquid balance); null when it couldn't be read. */
  nearYocto: bigint | null
  /** Staked NEAR: never dust. */
  lockedYocto: bigint
  tokens: readonly { contract: string; raw: bigint }[]
  /** True only when every token the account may hold was read from chain. */
  tokensKnown: boolean
}

export type DeletionVerdict = { ok: true; dustYocto: bigint } | { ok: false; reason: 'near' | 'tokens' | 'unknown' }

export function deletionVerdict(v: WalletHoldingsView): DeletionVerdict {
  if (v.tokens.some((t) => t.raw > 0n)) return { ok: false, reason: 'tokens' }
  if (v.exists === null || !v.tokensKnown) return { ok: false, reason: 'unknown' }
  if (v.exists === false) return { ok: true, dustYocto: 0n }
  if (v.nearYocto === null) return { ok: false, reason: 'unknown' }
  if (v.lockedYocto > 0n || v.nearYocto >= WALLET_DUST_YOCTO) return { ok: false, reason: 'near' }
  return { ok: true, dustYocto: v.nearYocto }
}
