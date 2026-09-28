import { RpcError, type Finality, type RpcClient } from './rpc'

/** Protocol storage price: 1e19 yocto per byte (0.00001 NEAR). */
export const STORAGE_PRICE_PER_BYTE = 10n ** 19n
/** NEP-448 zero-balance allowance: accounts at or under this many bytes stake nothing. */
export const ZERO_BALANCE_ACCOUNT_BYTES = 770

const NO_LOCAL_CODE = '11111111111111111111111111111111'

/**
 * Spendable NEAR under the protocol rule (nearcore verifier.rs):
 * required stake = storage_usage × price above 770 bytes (else 0);
 * spendable = amount − max(0, required − locked).
 */
export function spendableYocto({ amount, locked, storageUsage }: { amount: bigint; locked: bigint; storageUsage: number }, pricePerByte = STORAGE_PRICE_PER_BYTE): bigint {
  const required = storageUsage <= ZERO_BALANCE_ACCOUNT_BYTES ? 0n : BigInt(storageUsage) * pricePerByte
  const stake = required > locked ? required - locked : 0n
  return amount > stake ? amount - stake : 0n
}

export interface AccountState {
  accountId: string
  exists: boolean
  /** Liquid balance (`amount`). */
  totalYocto: bigint
  /** Validator stake. */
  lockedYocto: bigint
  storageUsage: number
  /** NEAR that storage keeps unspendable. */
  storageYocto: bigint
  /** What can actually be spent. */
  availableYocto: bigint
  /** A local or global contract is deployed. */
  hasContract: boolean
  blockHeight: number | null
}

export async function accountState(rpc: RpcClient, accountId: string, finality: Finality = 'optimistic'): Promise<AccountState> {
  try {
    const view = await rpc.viewAccount(accountId, finality)
    const totalYocto = BigInt(view.amount)
    const lockedYocto = BigInt(view.locked)
    const availableYocto = spendableYocto({ amount: totalYocto, locked: lockedYocto, storageUsage: view.storage_usage })
    return {
      accountId,
      exists: true,
      totalYocto,
      lockedYocto,
      storageUsage: view.storage_usage,
      storageYocto: totalYocto - availableYocto,
      availableYocto,
      hasContract: view.code_hash !== NO_LOCAL_CODE || Boolean(view.global_contract_hash || view.global_contract_account_id),
      blockHeight: view.block_height,
    }
  } catch (e) {
    if (e instanceof RpcError && e.causeName === 'UNKNOWN_ACCOUNT') {
      return { accountId, exists: false, totalYocto: 0n, lockedYocto: 0n, storageUsage: 0, storageYocto: 0n, availableYocto: 0n, hasContract: false, blockHeight: null }
    }
    throw e
  }
}
