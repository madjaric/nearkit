import type { NetworkName, OperationPlan, OperationProgress, TxProgress } from '@/types/operations'
import { errorInfo, NearKitError, toNearKitError } from './errors'
import { classifyOutcome, extractHash, type OutcomeContext } from './outcome'
import { toConnectorTransaction } from './plans'
import type { RpcClient, RpcTxResult } from './rpc'
import type { WalletAdapter } from './wallet'

/**
 * The one place value-moving operations run. For each signing group it checks
 * the execution policy, makes sure the signer is in the wallet session, asks the
 * wallet to sign, then confirms every transaction on chain through our own RPC.
 *
 * - Nothing is SUCCESS until the chain says so.
 * - A rejected approval is NOT_SENT; an ambiguous wallet error is UNKNOWN.
 * - After a group with a failure it pauses; continuing is the user's decision.
 * - It never retries or re-sends a transaction on its own.
 */

export interface ExecutionPolicy {
  network: NetworkName
  /** Value-moving operations may run on this network in this build. */
  enabled: boolean
  reason: string | null
  /** Configured NearKit fee account; fee-bearing plans require it. */
  feeRecipient: string | null
}

/** The mainnet safety switch and every other pre-signing guard, in one place. */
export function assertExecutionAllowed(plan: OperationPlan, policy: ExecutionPolicy, now: number, { checkExpiry = true }: { checkExpiry?: boolean } = {}): void {
  if (plan.mode !== 'near') throw new NearKitError('EXECUTION_DISABLED', 'This plan is a simulation and cannot be signed')
  if (plan.network !== policy.network) throw new NearKitError('NETWORK_MISMATCH', `This plan was built for ${plan.network}, but NearKit is running on ${policy.network}`)
  if (!policy.enabled) throw new NearKitError('EXECUTION_DISABLED', policy.reason ?? 'Execution is disabled in this build')
  if (plan.fee?.charged) {
    if (!policy.feeRecipient) throw new NearKitError('EXECUTION_DISABLED', 'The NearKit fee account is not configured, so fee-bearing trades are blocked')
    if (plan.fee.recipient !== policy.feeRecipient) throw new NearKitError('EXECUTION_DISABLED', 'The plan’s fee account does not match the configured NearKit fee account')
  }
  if (checkExpiry && isExpired(plan, now)) throw new NearKitError('QUOTE_EXPIRED', 'This quote expired. Refresh it before signing.')
}

const isExpired = (plan: OperationPlan, now: number) => plan.expiresAt !== null && now > plan.expiresAt

/** Readable token names for outcome notes, from the plan's own swap details. */
function outcomeContext(plan: OperationPlan): OutcomeContext {
  const swap = plan.swap
  if (!swap?.routeTokens) return {}
  const tokens = swap.routeTokens
  const finalToken = tokens.at(-1)?.contract
  return {
    describeToken: (id, role) => {
      if (role === 'received' && swap.tokenOut.contract === null && id === finalToken) return { symbol: 'NEAR', decimals: 24 }
      const t = tokens.find((x) => x.contract === id)
      return t ? { symbol: t.symbol, decimals: t.decimals } : null
    },
  }
}

export function initialProgress(plan: OperationPlan, simulated = false, now = Date.now()): OperationProgress {
  return {
    planId: plan.id,
    phase: 'idle',
    txs: plan.transactions.map((t) => ({ index: t.index, phase: 'queued', hash: null, explorerUrl: null, error: null, note: null })),
    groupIndex: 0,
    pause: null,
    simulated,
    startedAt: now,
    finishedAt: null,
  }
}

export function settledPhase(txs: TxProgress[]): OperationProgress['phase'] {
  if (txs.length > 0 && txs.every((t) => t.phase === 'success')) return 'success'
  return txs.some((t) => t.phase === 'success') ? 'partial' : 'failed'
}

export interface ExecutorDeps {
  /** `call` reads the signer's access keys to tell a clean rejection from one that was sent anyway. */
  rpc: Pick<RpcClient, 'txStatus'> & Partial<Pick<RpcClient, 'call'>>
  wallet: () => Promise<WalletAdapter>
  policy: ExecutionPolicy
  explorerTxUrl: (hash: string) => string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** How long to keep asking the chain for a submitted transaction. */
  confirmDeadlineMs?: number
  /** Persistence hook (activity records) on every change. */
  onUpdate?: (plan: OperationPlan, progress: OperationProgress) => void
}

export type ProgressListener = (progress: OperationProgress) => void

export interface Executor {
  /** Run from the start (`prior` null) or continue a paused run. */
  run(plan: OperationPlan, prior: OperationProgress | null, onProgress: ProgressListener): Promise<OperationProgress>
}

/** How long to let a transaction the wallet may have broadcast land before reading nonces again. */
const REJECTION_SETTLE_MS = 3000

const malformed = (why: string) => new NearKitError('TRANSACTION_FAILED', `This operation can't run: ${why}. Nothing was sent.`)

/** Every group names existing transactions of one signer, and together the groups cover the plan once. */
function assertWellFormed(plan: OperationPlan): void {
  const seen = new Set<number>()
  for (const group of plan.groups) {
    if (group.length === 0) throw malformed('an approval has no transactions')
    const signers = new Set<string>()
    for (const i of group) {
      const tx = plan.transactions[i]
      if (!tx || tx.index !== i || seen.has(i)) throw malformed('its transactions are out of order')
      seen.add(i)
      signers.add(tx.signerId)
    }
    if (signers.size !== 1) throw malformed('one approval mixes signers')
  }
  if (seen.size !== plan.transactions.length) throw malformed('some transactions are not in any approval')
}

/** A final outcome we can read safely; anything else counts as "not final yet". */
function isReadableOutcome(r: unknown): r is RpcTxResult {
  if (!r || typeof r !== 'object') return false
  const o = r as Partial<RpcTxResult>
  const status = o.status as Record<string, unknown> | undefined
  return (
    typeof status === 'object' &&
    status !== null &&
    ('SuccessValue' in status || 'Failure' in status) &&
    typeof o.transaction?.signer_id === 'string' &&
    typeof o.transaction?.receiver_id === 'string' &&
    Array.isArray(o.receipts_outcome) &&
    o.receipts_outcome.every((x) => x && typeof x.outcome?.executor_id === 'string' && Array.isArray(x.outcome.logs))
  )
}

export function createExecutor(deps: ExecutorDeps): Executor {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadlineMs = deps.confirmDeadlineMs ?? 120_000
  /** Plans that reached the wallet. Starting one again from scratch could pay twice. */
  const started = new Set<string>()

  async function confirm(hash: string, signerId: string): Promise<RpcTxResult | null> {
    const stop = now() + deadlineMs
    let wait = 1000
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const r = await deps.rpc.txStatus(hash, signerId, 'FINAL')
        if (isReadableOutcome(r)) return r
      } catch {
        // Not visible yet, a node timeout, or a transport hiccup: ask again until the deadline.
      }
      if (now() >= stop) break
      await sleep(wait)
      wait = Math.min(wait * 2, 8000)
    }
    return null
  }

  /** public key → nonce for every access key of the account, or null when it can't be read. */
  async function accessNonces(accountId: string): Promise<Map<string, string> | null> {
    if (!deps.rpc.call) return null
    try {
      const r = await deps.rpc.call<{ keys?: { public_key?: unknown; access_key?: { nonce?: unknown } }[] }>('query', {
        request_type: 'view_access_key_list',
        finality: 'optimistic',
        account_id: accountId,
      })
      if (!r || !Array.isArray(r.keys)) return null
      return new Map(r.keys.map((k) => [String(k.public_key), String(k.access_key?.nonce)]))
    } catch {
      return null
    }
  }

  const sameNonces = (a: Map<string, string>, b: Map<string, string>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v)

  return {
    async run(plan, prior, onProgress) {
      if (prior && prior.planId !== plan.id) throw malformed('its saved progress belongs to another operation')
      assertWellFormed(plan)
      if (!prior && started.has(plan.id)) {
        throw new NearKitError('TRANSACTION_FAILED', 'This operation already reached your wallet. Check its results; to send again, start a new one.')
      }
      // Nothing sent yet: an expired quote goes back to review. Mid-run it pauses instead (below).
      assertExecutionAllowed(plan, deps.policy, now(), { checkExpiry: prior === null })
      let progress: OperationProgress = prior ? { ...prior, phase: 'running', pause: null } : { ...initialProgress(plan, false, now()), phase: 'running' }

      const update = (patch: Partial<OperationProgress>, txPatch: Record<number, Partial<TxProgress>> = {}) => {
        progress = { ...progress, ...patch, txs: progress.txs.map((t) => (txPatch[t.index] ? { ...t, ...txPatch[t.index] } : t)) }
        onProgress(progress)
        try {
          deps.onUpdate?.(plan, progress)
        } catch {
          // Persistence must never interrupt a run that has reached the wallet.
        }
      }
      const each = (indexes: number[], patch: Partial<TxProgress>) => Object.fromEntries(indexes.map((i) => [i, patch])) as Record<number, Partial<TxProgress>>
      const finish = () => {
        update({ phase: settledPhase(progress.txs), pause: null, groupIndex: plan.groups.length, finishedAt: now() })
        return progress
      }

      update({})
      const adapter = await deps.wallet()

      for (let g = progress.groupIndex; g < plan.groups.length; g++) {
        const group = plan.groups[g] ?? []
        const txs = group.map((i) => plan.transactions[i]).filter((t): t is NonNullable<typeof t> => Boolean(t))
        const signerId = txs[0]?.signerId
        if (!signerId || txs.length !== group.length) throw malformed('an approval has no transactions')
        const later = plan.groups.slice(g + 1).flat()

        const session = await adapter.session().catch(() => null)
        if (!session || !session.accounts.includes(signerId)) {
          update({ phase: 'paused', groupIndex: g, pause: { reason: 'switch-account', signerId, message: `Connect ${signerId} in your wallet to sign the next step.` } })
          return progress
        }

        if (isExpired(plan, now())) {
          const remaining = plan.groups.slice(g).flat().length
          update({
            phase: 'paused',
            groupIndex: g,
            pause: {
              reason: 'requote',
              signerId: null,
              message: `The quote expired before this step, so ${remaining === 1 ? 'the last transaction was' : `the last ${remaining} transactions were`} not sent. Get a fresh quote to finish.`,
            },
          })
          return progress
        }
        assertExecutionAllowed(plan, deps.policy, now())
        const before = await accessNonces(signerId)
        update({ groupIndex: g }, each(group, { phase: 'awaiting_signature', error: null, note: null }))
        started.add(plan.id)

        let results: unknown
        try {
          results = await adapter.signAndSendTransactions(signerId, txs.map(toConnectorTransaction))
        } catch (e) {
          const err = toNearKitError(e)
          // NearKit's own refusal happens before anything reaches the wallet. A wallet-side
          // rejection is only "not sent" if the account's transaction counter didn't move.
          let nothingSent = err.code === 'WALLET_UNAVAILABLE'
          if (!nothingSent && err.code === 'USER_REJECTED' && before) {
            await sleep(REJECTION_SETTLE_MS)
            const after = await accessNonces(signerId)
            nothingSent = after !== null && sameNonces(before, after)
          }
          if (nothingSent) {
            update({}, { ...each(later, { phase: 'not_sent' }), ...each(group, { phase: 'not_sent', error: errorInfo(err) }) })
          } else {
            const note =
              err.code === 'USER_REJECTED'
                ? 'The wallet reported the request as rejected or closed, but it may still have been sent. Check the explorer or your wallet activity before trying again.'
                : 'The wallet reported an error. The transaction may or may not have been sent: check your wallet activity before trying again.'
            update({}, { ...each(later, { phase: 'not_sent' }), ...each(group, { phase: 'unknown', error: errorInfo(err), note }) })
          }
          return finish()
        }

        try {
          const list = Array.isArray(results) ? results : []
          const hashes = group.map((_, i) => extractHash(list[i]))
          update(
            {},
            Object.fromEntries(
              group.map((txIndex, i) => {
                const hash = hashes[i]
                return [
                  txIndex,
                  hash
                    ? { phase: 'submitted', hash, explorerUrl: deps.explorerTxUrl(hash) }
                    : { phase: 'unknown', note: 'The wallet did not return a transaction hash. Check your wallet activity before trying again.' },
                ]
              }),
            ) as Record<number, Partial<TxProgress>>,
          )

          for (const [i, txIndex] of group.entries()) {
            const hash = hashes[i]
            const planned = txs[i]
            if (!hash || !planned) continue
            update({}, { [txIndex]: { phase: 'confirming' } })
            const final = await confirm(hash, signerId)
            if (!final) {
              update({}, { [txIndex]: { phase: 'unknown', note: 'Submitted, but not confirmed yet. Open it in the explorer to see its status.' } })
              continue
            }
            const verdict = classifyOutcome(final, planned, outcomeContext(plan))
            update({}, { [txIndex]: { phase: verdict.phase, error: verdict.error, note: verdict.note } })
          }
        } catch (e) {
          // Whatever went wrong after the wallet answered, keep what may have been sent in view.
          const err = toNearKitError(e)
          const open = group.filter((i) => {
            const phase = progress.txs[i]?.phase
            return phase !== 'success' && phase !== 'failed'
          })
          update(
            {},
            {
              ...each(later, { phase: 'not_sent' }),
              ...each(open, {
                phase: 'unknown',
                error: errorInfo(err),
                note: 'NearKit lost track of this transaction after it reached the wallet. Check the explorer before trying again.',
              }),
            },
          )
          return finish()
        }

        const troubled = group.some((i) => progress.txs[i]?.phase !== 'success')
        if (troubled && g < plan.groups.length - 1) {
          const remaining = later.length
          update({
            phase: 'paused',
            groupIndex: g + 1,
            pause: {
              reason: 'failure',
              signerId: null,
              message: `A transaction did not succeed. ${remaining} ${remaining === 1 ? 'transaction has' : 'transactions have'} not been sent. Review the results before you continue.`,
            },
          })
          return progress
        }
      }
      return finish()
    },
  }
}
