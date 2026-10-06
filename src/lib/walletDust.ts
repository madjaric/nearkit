/**
 * Wallet dust: when a NEARKITS wallet may be deleted. Sending everything out of a wallet leaves a
 * little NEAR behind (the transaction's gas is held up front and its unused part is refunded after),
 * so "empty" can't mean zero. Below 0.05 NEAR the wallet holds dust: it may be deleted, and that dust
 * stays on chain. At 0.05 NEAR and above it holds a balance and is not deleted. Tokens are never dust:
 * any token balance, or a token list that could not be read in full, keeps the wallet. The web and the
 * bot apply this same line. Deleting closes the wallet; only a never-funded wallet's key is erased (by
 * the signer, which reads the chain itself): a dust wallet's key stays sealed, so nothing that reaches
 * it later is lost.
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

/** Why a wallet isn't deleted: a balance, tokens, holdings that couldn't be read, a trade or send on its way, a live Volume Bot on it. */
export type UndeletableReason = 'near' | 'tokens' | 'unknown' | 'busy' | 'bot'

export type DeletionVerdict = { ok: true; dustYocto: bigint } | { ok: false; reason: UndeletableReason }

export function deletionVerdict(v: WalletHoldingsView): DeletionVerdict {
  if (v.tokens.some((t) => t.raw > 0n)) return { ok: false, reason: 'tokens' }
  if (v.exists === null || !v.tokensKnown) return { ok: false, reason: 'unknown' }
  if (v.exists === false) return { ok: true, dustYocto: 0n }
  if (v.nearYocto === null) return { ok: false, reason: 'unknown' }
  if (v.lockedYocto > 0n || v.nearYocto >= WALLET_DUST_YOCTO) return { ok: false, reason: 'near' }
  return { ok: true, dustYocto: v.nearYocto }
}
