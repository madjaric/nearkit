import type { PlannedAction, PlannedTransaction, TokenRef } from '@/types/operations'
import { GAS, gasCostBoundYocto, gasPurchaseYocto, type GasAction, type GasTx } from './gas'
import type { ConnectorTransaction } from './wallet'

/**
 * Transaction builders for transfers. Amounts are raw bigint in, raw strings out.
 * Limits come from the live protocol config (1 PGas and 100 actions per
 * transaction); chunks are kept far below them so one bad recipient only reverts
 * a small batch and the upfront gas purchase stays affordable.
 */

/** Recipients per NEP-141 transaction: ≤ 40 actions (with storage) and ≤ 400 TGas. */
export const FT_RECIPIENTS_PER_TX = 20
/** Transactions per wallet approval. */
export const MAX_TXS_PER_APPROVAL = 10

export interface TransferLineInput {
  id: string
  accountId: string
  raw: bigint
  /** Yocto to attach for NEP-145 registration, or null when already registered. */
  storageDeposit: bigint | null
}

const sumBig = (values: bigint[]) => values.reduce((a, b) => a + b, 0n)

function finalize(txs: Omit<PlannedTransaction, 'index' | 'label' | 'gas' | 'deposit'>[], noun: (n: number) => string): PlannedTransaction[] {
  return txs.map((tx, index) => ({
    ...tx,
    index,
    label: txs.length > 1 ? `Transaction ${index + 1} of ${txs.length} · ${noun(tx.lineIds.length)}` : noun(tx.lineIds.length),
    gas: sumBig(tx.actions.map((a) => (a.kind === 'call' ? BigInt(a.gas) : 0n))).toString(),
    deposit: sumBig(tx.actions.map((a) => BigInt(a.deposit))).toString(),
  }))
}

const recipients = (n: number) => `${n} ${n === 1 ? 'recipient' : 'recipients'}`

export function ftTransferAction(receiverId: string, raw: bigint): PlannedAction {
  return { kind: 'call', method: 'ft_transfer', args: { receiver_id: receiverId, amount: raw.toString() }, gas: GAS.FT_TRANSFER.toString(), deposit: '1' }
}

export function storageDepositAction(accountId: string, yocto: bigint): PlannedAction {
  return { kind: 'call', method: 'storage_deposit', args: { account_id: accountId, registration_only: true }, gas: GAS.STORAGE_DEPOSIT.toString(), deposit: yocto.toString() }
}

/** NEP-141 transfers from one signer: chunks of ≤ 20 recipients, registration before each transfer that needs it. */
export function buildFtTransferTransactions(signerId: string, token: TokenRef, lines: TransferLineInput[]): PlannedTransaction[] {
  const contract = token.contract
  if (!contract) throw new Error('Native NEAR is sent with Transfer actions, not ft_transfer')
  const chunks: TransferLineInput[][] = []
  for (let i = 0; i < lines.length; i += FT_RECIPIENTS_PER_TX) chunks.push(lines.slice(i, i + FT_RECIPIENTS_PER_TX))
  return finalize(
    chunks.map((chunk) => ({
      signerId,
      receiverId: contract,
      lineIds: chunk.map((l) => l.id),
      actions: chunk.flatMap((l) => [...(l.storageDeposit !== null ? [storageDepositAction(l.accountId, l.storageDeposit)] : []), ftTransferAction(l.accountId, l.raw)]),
    })),
    recipients,
  )
}

/** Native NEAR: one transaction per recipient (a transaction has exactly one receiver). */
export function buildNearTransferTransactions(signerId: string, lines: TransferLineInput[]): PlannedTransaction[] {
  return finalize(
    lines.map((l) => ({ signerId, receiverId: l.accountId, lineIds: [l.id], actions: [{ kind: 'transfer', deposit: l.raw.toString() } satisfies PlannedAction] })),
    recipients,
  )
}

/** Consecutive transactions of one signer share an approval, at most MAX_TXS_PER_APPROVAL each. */
export function groupTransactions(txs: readonly Pick<PlannedTransaction, 'index' | 'signerId'>[], walletBatches: boolean): number[][] {
  const size = walletBatches ? MAX_TXS_PER_APPROVAL : 1
  const groups: number[][] = []
  let current: number[] = []
  let signer: string | null = null
  for (const tx of txs) {
    if (current.length > 0 && (tx.signerId !== signer || current.length >= size)) {
      groups.push(current)
      current = []
    }
    signer = tx.signerId
    current.push(tx.index)
  }
  if (current.length) groups.push(current)
  return groups
}

// ─── costs ──────────────────────────────────────────────────────────────────

/** Registration deposits: NEP-145 `storage_deposit` and Rhea's `tokens_storage_deposit`. */
const STORAGE_METHODS = new Set(['storage_deposit', 'tokens_storage_deposit'])

/** Yocto a transaction attaches for storage registrations. */
export function txStorageYocto(tx: Pick<PlannedTransaction, 'actions'>): bigint {
  return sumBig(tx.actions.map((a) => (a.kind === 'call' && STORAGE_METHODS.has(a.method) ? BigInt(a.deposit) : 0n)))
}

/** Yocto a transaction attaches in all: registrations, NEAR it moves or wraps, 1-yocto security deposits. */
export function txDepositYocto(tx: { actions: readonly GasAction[] }): bigint {
  return sumBig(tx.actions.map((a) => ('deposit' in a ? BigInt(a.deposit) : 0n)))
}

/**
 * Yocto a transaction needs beyond the amount it moves and its storage: the NEP-642
 * gas purchase (mostly refunded) and 1-yocto security deposits.
 */
export function txUpfrontYocto(tx: GasTx): bigint {
  const security = sumBig(tx.actions.map((a) => (a.kind === 'call' && a.deposit === '1' ? 1n : 0n)))
  return gasPurchaseYocto(tx) + security
}

/**
 * The most NEAR a plan needs available at once when its transactions go one after another, each
 * sent only once the one before is final and its gas refund has landed (the custody engine checks
 * that before every later step). A transaction needs its deposits and its gas purchase when the
 * chain accepts it; each one before it has spent its deposits and at most `gasCostBoundYocto`.
 */
export function peakNeedYocto(txs: readonly GasTx[]): bigint {
  let spent = 0n
  let peak = 0n
  for (const tx of txs) {
    const deposits = txDepositYocto(tx)
    const need = spent + deposits + gasPurchaseYocto(tx)
    if (need > peak) peak = need
    spent += deposits + gasCostBoundYocto(tx)
  }
  return peak
}

/** Plan warnings for registrations that cost more than usual, naming the contract and the account. */
export function registrationWarnings(txs: readonly Pick<PlannedTransaction, 'receiverId' | 'actions'>[], high: bigint): string[] {
  const out: string[] = []
  for (const tx of txs) {
    for (const a of tx.actions) {
      if (a.kind !== 'call' || a.method !== 'storage_deposit' || BigInt(a.deposit) <= high) continue
      const near = Number(BigInt(a.deposit)) / 1e24
      out.push(`${tx.receiverId} charges ${near} NEAR to register ${String(a.args.account_id)}, more than usual (most tokens charge 0.00125 NEAR).`)
    }
  }
  return [...new Set(out)]
}

/** Planned transaction → the exact wallet payload. No value is transformed. */
export function toConnectorTransaction(tx: PlannedTransaction): ConnectorTransaction {
  return {
    receiverId: tx.receiverId,
    actions: tx.actions.map((a) =>
      a.kind === 'transfer'
        ? { type: 'Transfer', params: { deposit: a.deposit } }
        : { type: 'FunctionCall', params: { methodName: a.method, args: a.args, gas: a.gas, deposit: a.deposit } },
    ),
  }
}
