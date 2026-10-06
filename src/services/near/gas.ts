import type { PlannedAction } from '@/types/operations'

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

/** The lowest gas price the network charges (yocto per gas); mainnet has stayed at it. */
export const MIN_GAS_PRICE = 10n ** 8n

/**
 * Runtime fees in gas, from the live mainnet config (EXPERIMENTAL_protocol_config, protocol 86,
 * read 2026-09-30). `send` is burnt when a transaction becomes a receipt; `exec` is bought with it.
 */
export const FEES = Object.freeze({
  receipt: { send: 108_059_500_000n, exec: 108_059_500_000n },
  functionCall: { send: 200_000_000_000n, exec: 780_000_000_000n },
  /** Per byte of method name and args. Sending to another account costs far more per byte. */
  functionCallByte: { sendSir: 2_235_934n, sendNotSir: 47_683_715n, exec: 2_235_934n },
  transfer: { send: 115_123_062_500n, exec: 115_123_062_500n },
  createAccount: { send: 500_000_000_000n, exec: 7_200_000_000_000n },
  addFullAccessKey: { send: 101_765_125_000n, exec: 101_765_125_000n },
  deleteKey: { send: 94_946_625_000n, exec: 94_946_625_000n },
})

/** What NearKit plans: transfers and calls, and a NearKit wallet adding or deleting a full-access key. */
export type GasAction = PlannedAction | { kind: 'add-key'; publicKey: string } | { kind: 'delete-key'; publicKey: string }

export interface GasTx {
  /** A transfer to an implicit account (or to an unknown receiver) is priced as creating it. */
  receiverId?: string
  actions: readonly GasAction[]
}

const IMPLICIT = /^(?:[0-9a-f]{64}|0x[0-9a-f]{40}|0s[0-9a-f]{40})$/
const utf8 = new TextEncoder()
const byteLength = (s: string) => BigInt(utf8.encode(s).length)

/**
 * Gas of one transaction as nearcore's `tx_cost` counts it: `burnt` when it becomes a receipt
 * (send fees), `bought` for its receipts (attached gas and execution fees). It matches mainnet to
 * the unit on NearKit's real transactions (gas.test.ts). Args are counted as the signer encodes
 * them (JSON), and the signer is taken to be another account than the receiver (the dearer case).
 */
export function txGas(tx: GasTx): { burnt: bigint; bought: bigint } {
  let burnt = FEES.receipt.send
  let bought = FEES.receipt.exec
  for (const a of tx.actions) {
    switch (a.kind) {
      case 'call': {
        const bytes = byteLength(a.method) + byteLength(JSON.stringify(a.args))
        burnt += FEES.functionCall.send + bytes * FEES.functionCallByte.sendNotSir
        bought += BigInt(a.gas) + FEES.functionCall.exec + bytes * FEES.functionCallByte.exec
        break
      }
      case 'transfer':
        burnt += FEES.transfer.send
        bought += FEES.transfer.exec
        if (tx.receiverId === undefined || IMPLICIT.test(tx.receiverId)) {
          burnt += FEES.createAccount.send + FEES.addFullAccessKey.send
          bought += FEES.createAccount.exec + FEES.addFullAccessKey.exec
        }
        break
      case 'add-key':
        burnt += FEES.addFullAccessKey.send
        bought += FEES.addFullAccessKey.exec
        break
      case 'delete-key':
        burnt += FEES.deleteKey.send
        bought += FEES.deleteKey.exec
        break
    }
  }
  return { burnt, bought }
}

/**
 * Yocto the chain takes for a transaction's gas when it accepts it (NEP-642): the bought gas at the
 * purchase floor. The send part is burnt at the day's gas price (a tenth of that today); NearKit
 * prices it at the floor too, a margin under 0.001 NEAR. All but the burn comes back in seconds.
 */
export function gasPurchaseYocto(tx: GasTx): bigint {
  const g = txGas(tx)
  return (g.burnt + g.bought) * GAS_BUY_PRICE
}

/**
 * NEAR a plain NEAR transfer to `to` holds upfront for its gas: gasPurchaseYocto of exactly that
 * transfer. A 64-character address costs more (the transfer creates that account); with no address
 * yet it is priced as that dearer case.
 */
export function nearSendUpfrontYocto(to?: string): bigint {
  return gasPurchaseYocto({ receiverId: to, actions: [{ kind: 'transfer', deposit: '1' }] })
}

/**
 * The most NEAR one wallet can send in all to these recipients, one transfer each: its spendable NEAR
 * less each transfer's own hold, nothing more (what stays after the refunds is dust). Enough for each
 * transfer even when they go one after another before any refund lands.
 */
export function maxNearSendYocto(available: bigint, recipients: readonly (string | undefined)[]): bigint {
  const hold = (recipients.length > 0 ? recipients : [undefined]).reduce((s, to) => s + nearSendUpfrontYocto(to), 0n)
  return available > hold ? available - hold : 0n
}

/**
 * The most a transaction's gas can cost once its refunds have landed: every unit it pays for, burnt,
 * at twice the minimum gas price. Real transactions burn a quarter of it or less at the minimum.
 */
export function gasCostBoundYocto(tx: GasTx): bigint {
  const g = txGas(tx)
  return (g.burnt + g.bought) * 2n * MIN_GAS_PRICE
}

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
