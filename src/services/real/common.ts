import { NATIVE_TOKEN_ID, NEAR_DECIMALS } from '@/config/networks'
import { canExecute, signsInBrowser } from '@/lib/wallets'
import { formatUnits, tryParseUnits } from '@/lib/amounts'
import { NearKitError } from '@/services/near/errors'
import type { Session, Wallet } from '@/types/domain'
import type { AmountValue, TokenRef } from '@/types/operations'
import type { NearContext } from './context'

/** Helpers shared by the real planners (transfers and trades). */

export const NEAR_REF: TokenRef = Object.freeze({ id: NATIVE_TOKEN_ID, symbol: 'NEAR', decimals: NEAR_DECIMALS, contract: null })

export const amountValue = (raw: bigint, decimals: number): AmountValue => ({ raw: raw.toString(), display: formatUnits(raw, decimals) })
export const nearValue = (raw: bigint): AmountValue => amountValue(raw, NEAR_DECIMALS)
export const nearText = (raw: bigint): string => formatUnits(raw, NEAR_DECIMALS, { maxFraction: 5 })

export const sumRaw = (values: readonly bigint[]): bigint => values.reduce((a, b) => a + b, 0n)

export function newPlanId(now: number): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10)
  return `plan-${now.toString(36)}-${random}`
}

/**
 * Token reference from the chain: NEP-141 metadata for contracts, fixed for native NEAR.
 * `fresh` (used when building a plan) re-reads decimals instead of trusting a cache.
 */
export async function resolveToken(ctx: NearContext, tokenId: string, { fresh = false }: { fresh?: boolean } = {}): Promise<TokenRef> {
  if (tokenId === NATIVE_TOKEN_ID) return NEAR_REF
  const meta = await ctx.reader.metadata(tokenId, { fresh })
  return { id: tokenId, symbol: meta.symbol, decimals: meta.decimals, contract: tokenId }
}

/** Exact raw amount from the decimal string the user entered. Never rounds. */
export function parseAmount(text: string, token: TokenRef, who: string): bigint {
  const parsed = tryParseUnits(text, token.decimals)
  if (!parsed.ok) throw new NearKitError('INVALID_AMOUNT', `${who}: ${parsed.error.message}`)
  if (parsed.value <= 0n) throw new NearKitError('INVALID_AMOUNT', `${who}: the amount must be greater than 0`)
  return parsed.value
}

/** The connected session, or a readable error when execution can't be prepared. */
export function requireSession(session: Session | null, networkLabel: string): Session {
  if (!session) throw new NearKitError('WALLET_UNAVAILABLE', 'Connect a wallet first')
  if (session.issue === 'network-mismatch')
    throw new NearKitError('NETWORK_MISMATCH', `${session.accountId} belongs to the other network. Connect a ${networkLabel.toLowerCase()} account.`)
  if (session.issue === 'account-missing') throw new NearKitError('INVALID_ACCOUNT', `${session.accountId} does not exist on ${networkLabel.toLowerCase()} yet. Fund it first.`)
  return session
}

export function walletOf(wallets: readonly Wallet[], walletId: string): Wallet {
  const wallet = wallets.find((w) => w.id === walletId)
  if (!wallet) throw new NearKitError('INVALID_ACCOUNT', 'That wallet is not in your account list')
  return wallet
}

/**
 * A wallet that may act here, or NOT_EXECUTABLE before anything is quoted, planned or signed.
 * `browser`: signed in this browser (a connected account; the demo's wallets). `any`: also a
 * NearKit wallet (executed by NearKit's server). Watch-only wallets never act.
 */
export function executableWallet(wallets: readonly Wallet[], walletId: string, how: 'browser' | 'any' = 'browser'): Wallet {
  const wallet = walletOf(wallets, walletId)
  if (!canExecute(wallet))
    throw new NearKitError('NOT_EXECUTABLE', `${wallet.label} is watch-only: it shows balances and activity, but can't trade or send. Connect it in your wallet to use it.`)
  if (how === 'browser' && !signsInBrowser(wallet))
    throw new NearKitError('NOT_EXECUTABLE', `${wallet.label} is a NearKit wallet: NearKit's server executes its trades and sends, not a browser wallet.`)
  return wallet
}
