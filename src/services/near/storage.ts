import { formatUnits } from '@/lib/amounts'
import { mapLimit } from '@/lib/async'
import { NearKitError, toNearKitError } from './errors'
import { RpcError, type RpcClient } from './rpc'
import { parseU128 } from './tokens'

/**
 * NEP-145 storage management, shared by Batch Send, Split, Consolidate and swaps.
 * A recipient must be registered with a token contract before it can receive; the
 * plan adds `storage_deposit` right before that recipient's transfer. The deposit
 * is read from `storage_balance_bounds`, never assumed.
 */

/** A registration above this is refused: the contract sets the price, and a scam token can ask anything. */
export const MAX_REGISTRATION_YOCTO = 10n ** 23n // 0.1 NEAR
/** Most tokens charge 0.00125 NEAR; above this the plan says it costs more than usual. */
export const HIGH_REGISTRATION_YOCTO = 125n * 10n ** 20n // 0.0125 NEAR

const notImplemented = (e: unknown) => e instanceof RpcError && e.kind === 'contract' && /MethodNotFound/i.test(e.message)

/** Minimum registration deposit (yocto), or null when the contract has no NEP-145. */
export async function storageBoundsMin(rpc: RpcClient, contract: string): Promise<bigint | null> {
  let bounds: unknown
  try {
    bounds = await rpc.viewFunction<unknown>(contract, 'storage_balance_bounds', {}, 'final')
  } catch (e) {
    if (notImplemented(e)) return null
    throw toNearKitError(e)
  }
  const min = bounds && typeof bounds === 'object' ? (bounds as { min?: unknown }).min : undefined
  let value: bigint
  try {
    value = parseU128(min)
  } catch {
    throw new NearKitError('INVALID_TOKEN', `${contract} returned malformed storage bounds`, { detail: JSON.stringify(bounds) })
  }
  if (value > MAX_REGISTRATION_YOCTO) {
    throw new NearKitError(
      'INVALID_TOKEN',
      `${contract} asks ${formatUnits(value, 24, { maxFraction: 5 })} NEAR to register an account. NearKit refuses registrations above 0.1 NEAR.`,
    )
  }
  return value
}

/**
 * Registration per account: true registered, false not registered, null when the
 * contract does not implement NEP-145 (registration can't be checked).
 */
export async function storageStatus(rpc: RpcClient, contract: string, accountIds: readonly string[]): Promise<Map<string, boolean | null>> {
  const unique = [...new Set(accountIds)]
  let unsupported = false
  const results = await mapLimit(unique, 4, async (accountId) => {
    if (unsupported) return null
    try {
      const balance = await rpc.viewFunction<unknown>(contract, 'storage_balance_of', { account_id: accountId }, 'final')
      return balance !== null && typeof balance === 'object'
    } catch (e) {
      if (notImplemented(e)) {
        unsupported = true
        return null
      }
      throw toNearKitError(e)
    }
  })
  return new Map(unique.map((id, i) => [id, unsupported ? null : (results[i] ?? null)]))
}
