import { NATIVE_TOKEN_ID } from '@/config/networks'
import { isValidAccountId } from '@/lib/validation'
import { describeError } from '@/services/errors'
import type { TokenListing } from '@/types/domain'
import type { ServerNear } from '../near'

/**
 * Finding the token a Telegram user means, the way the web app's token selector
 * does: an exact contract is read from chain (the same `lookupToken` as the web's
 * exact-contract import, so a brand-new token works too); anything else is matched
 * by symbol, then name, against NearKit's list plus the user's own tokens.
 */

export type TokenMatch = { kind: 'one'; token: TokenListing } | { kind: 'many'; tokens: TokenListing[] } | { kind: 'none'; message: string; error?: unknown }

export const looksLikeContract = (q: string) => isValidAccountId(q) && (q.includes('.') || /^[0-9a-f]{64}$/.test(q) || q.startsWith('0x'))

export async function resolveToken(near: ServerNear, query: string, extra: readonly string[]): Promise<TokenMatch> {
  const q = query.trim().toLowerCase()
  if (!q) return { kind: 'none', message: 'Send a token symbol or its exact contract ID.' }
  const list = await near.market.listTokens([...extra])
  if (q === 'near' || q === NATIVE_TOKEN_ID) return { kind: 'one', token: list[0] as TokenListing }
  if (looksLikeContract(q)) {
    const listed = list.find((t) => t.id === q)
    if (listed) return { kind: 'one', token: listed }
    try {
      return { kind: 'one', token: await near.tokens.lookupToken(q) }
    } catch (e) {
      return { kind: 'none', message: describeError(e).message, error: e }
    }
  }
  const exact = list.filter((t) => t.symbol.toLowerCase() === q)
  if (exact.length === 1) return { kind: 'one', token: exact[0] as TokenListing }
  if (exact.length > 1) return { kind: 'many', tokens: exact }
  const partial = list.filter((t) => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q)).slice(0, 6)
  if (partial.length) return { kind: 'many', tokens: partial }
  return { kind: 'none', message: `No token called “${query.trim().slice(0, 40)}” in NearKit’s list. Paste its exact contract ID instead.` }
}
