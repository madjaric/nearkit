import { formatUnits, tryParseUnits } from '@/lib/amounts'
import { buildFtTransferTransactions, buildNearTransferTransactions, groupTransactions, type TransferLineInput } from '@/services/near/plans'
import type { Token } from '@/types/domain'
import type { AmountValue, OperationKind, OperationPlan, PlanLine, PlannedTransaction, TokenRef } from '@/types/operations'
import { ServiceError, nextId, type MockState } from './state'

/**
 * Demo plans are built with the same transaction builders as real ones, so the
 * review screen shows exactly what a real run would contain; they are marked
 * `mode: 'demo'` and the demo executor only simulates them.
 */

export const tokenRef = (token: Token): TokenRef => ({ id: token.id, symbol: token.symbol, decimals: token.decimals, contract: token.isNative ? null : token.contract })

export const amountValue = (raw: bigint, decimals: number): AmountValue => ({ raw: raw.toString(), display: formatUnits(raw, decimals) })

/** Exact raw amount from a user decimal string; ServiceError with the reason otherwise. */
export function rawAmount(text: string, token: Pick<Token, 'decimals' | 'symbol'>, who: string): bigint {
  const parsed = tryParseUnits(text, token.decimals)
  if (!parsed.ok) throw new ServiceError('invalid-amount', `${who}: ${parsed.error.message}`)
  if (parsed.value <= 0n) throw new ServiceError('invalid-amount', `${who}: amount must be greater than 0`)
  return parsed.value
}

/** Demo balances are floats, so the demo compares at display precision. Real mode compares raw bigints. */
export function coversRaw(balance: number, raw: bigint, decimals: number): boolean {
  return Number(formatUnits(raw, decimals)) <= balance * (1 + 1e-12) + 1e-9
}

interface DemoPlanInput {
  kind: OperationKind
  title: string
  token: Token
  signerLines: { signerId: string; lines: (TransferLineInput & { label: string; notes?: string[] })[] }[]
  warnings?: string[]
}

export function demoTransferPlan(state: MockState, input: DemoPlanInput): OperationPlan {
  const ref = tokenRef(input.token)
  const transactions: PlannedTransaction[] = []
  const lines: PlanLine[] = []
  for (const group of input.signerLines) {
    // Pre-launch demo tokens have no contract; the simulation says so instead of inventing one.
    const built = input.token.isNative
      ? buildNearTransferTransactions(group.signerId, group.lines)
      : buildFtTransferTransactions(group.signerId, { ...ref, contract: ref.contract ?? 'contract-not-deployed' }, group.lines)
    for (const tx of built) {
      const index = transactions.length
      transactions.push({ ...tx, index, label: `${group.signerId} · ${tx.label}` })
      for (const id of tx.lineIds) {
        const line = group.lines.find((l) => l.id === id)
        if (line)
          lines.push({
            id,
            label: line.label,
            accountId: line.accountId,
            amount: amountValue(line.raw, ref.decimals),
            storageDeposit: null,
            notes: line.notes ?? [],
            txIndex: index,
          })
      }
    }
  }
  const total = lines.reduce((s, l) => s + BigInt(l.amount.raw), 0n)
  return {
    id: nextId(state, 'plan'),
    kind: input.kind,
    mode: 'demo',
    network: 'demo',
    title: input.title,
    token: ref,
    signers: input.signerLines.map((g) => g.signerId),
    lines,
    transactions,
    groups: groupTransactions(transactions, true),
    totals: { amount: amountValue(total, ref.decimals), storage: amountValue(0n, 24), upfrontNear: amountValue(0n, 24) },
    fee: null,
    swap: null,
    warnings: input.warnings ?? [],
    expiresAt: null,
    createdAt: Date.now(),
  }
}
