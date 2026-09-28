/**
 * Gas and upfront-cost constants. Figures are from live mainnet receipts and the
 * protocol config read on 2026-09-28 (PHASE2_IMPLEMENTATION.md §10):
 * - max prepaid gas per transaction is 1 PGas and max actions per transaction 100;
 * - NEP-642: attached gas is bought upfront at 1e9 yocto/gas (0.001 NEAR per TGas)
 *   and the unburnt part is refunded, so a batch needs that much spendable NEAR
 *   when it is signed even though its real cost is small.
 */

export const TGAS = 10n ** 12n

/** Attached gas per action: roughly 4× the observed burn, never the 1 PGas maximum. */
export const GAS = Object.freeze({
  FT_TRANSFER: 10n * TGAS,
  STORAGE_DEPOSIT: 10n * TGAS,
  NEAR_DEPOSIT: 10n * TGAS,
  NEAR_WITHDRAW: 30n * TGAS,
  /** Rhea aggregator `tokens_storage_deposit` (the Rhea app attaches 30 TGas). */
  AGGREGATOR_STORAGE: 30n * TGAS,
  /** ft_transfer_call into a DEX: wrap.near forwards (attached − 30 TGas) to the receiver. */
  SWAP_CALL: 300n * TGAS,
})

export const MAX_TX_GAS = 1000n * TGAS
export const MAX_ACTIONS_PER_TX = 100

/** NEP-642 `min_gas_purchase_price`, yocto per gas unit. */
export const GAS_BUY_PRICE = 10n ** 9n

/** Send/exec fees charged per action and per transaction on top of attached gas (conservative). */
const ACTION_OVERHEAD_GAS = 800_000_000_000n // 0.8 TGas
const TX_OVERHEAD_GAS = 500_000_000_000n // 0.5 TGas

export interface UpfrontInput {
  transactions: number
  actions: number
  attachedGas: bigint
  /** Σ attached deposits (yocto): storage deposits, 1-yocto calls, NEAR transfers. */
  deposits: bigint
}

/** NEAR the signer must hold when signing; most of the gas part is refunded after execution. */
export function estimateUpfrontYocto({ transactions, actions, attachedGas, deposits }: UpfrontInput): bigint {
  const gas = attachedGas + BigInt(actions) * ACTION_OVERHEAD_GAS + BigInt(transactions) * TX_OVERHEAD_GAS
  return gas * GAS_BUY_PRICE + deposits
}
