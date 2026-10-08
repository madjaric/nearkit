import type { BridgeChain } from '@/config/bridge'
import { base58Decode } from '@/lib/encoding'

/**
 * Addresses and transaction hashes on Bridge & Buy's source chains, checked by their shape: a
 * Solana address is 32 bytes in base58 and a Solana signature 64; an EVM address is 20 bytes and
 * a transaction hash 32, in 0x-hex. A wrong one is refused before anything is asked of NEAR Intents.
 */

const b58Len = (text: string, n: number) => /^[1-9A-HJ-NP-Za-km-z]+$/.test(text) && base58Decode(text)?.length === n

export const isSolanaAddress = (a: string): boolean => a.length >= 32 && a.length <= 44 && b58Len(a, 32)
export const isSolanaSignature = (s: string): boolean => s.length >= 64 && s.length <= 88 && b58Len(s, 64)
export const isEvmAddress = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a)
export const isEvmTxHash = (h: string): boolean => /^0x[0-9a-fA-F]{64}$/.test(h)

/** Why `address` isn't an address on `chain`, or null when it is one. */
export function sourceAddressError(chain: Pick<BridgeChain, 'family' | 'name'>, address: string): string | null {
  const a = address.trim()
  if (!a) return `Enter your ${chain.name} address.`
  if (chain.family === 'solana') return isSolanaAddress(a) ? null : `That isn’t a ${chain.name} address.`
  return isEvmAddress(a) ? null : `That isn’t a ${chain.name} address (0x followed by 40 hex characters).`
}

/** Whether `hash` has the shape of a transaction on `chain`. */
export function isSourceTxHash(chain: Pick<BridgeChain, 'family'>, hash: string): boolean {
  return chain.family === 'solana' ? isSolanaSignature(hash) : isEvmTxHash(hash)
}

/** An address the way 1Click and the explorers compare it: EVM case-insensitively, Solana exactly. */
export const sameSourceAddress = (chain: Pick<BridgeChain, 'family'>, a: string, b: string): boolean => (chain.family === 'evm' ? a.toLowerCase() === b.toLowerCase() : a === b)
