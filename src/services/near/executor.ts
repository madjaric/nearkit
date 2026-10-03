import type { NetworkName, OperationPlan, OperationProgress, PlannedTransaction, TxProgress } from '@/types/operations'
import { errorInfo, NearKitError, toNearKitError } from './errors'
import { keysMoved, readKeys, type KeySnapshot, type TxLocator } from './locate'
import { classifyOutcome, extractHash, sameActions, swapDelivered, type DeliveryExpectation, type OutcomeContext } from './outcome'
import { toConnectorTransaction } from './plans'
import type { RpcClient, RpcTxResult } from './rpc'
import type { WalletAdapter } from './wallet'

/**
 * The one place value-moving operations run. For each signing group it checks
 * the execution policy, makes sure the signer is in the wallet session, asks the
 * wallet to sign, then follows every transaction on chain through our own RPC.
 *
 * - Nothing is SUCCESS until the chain says so. A swap is a success when its tokens
 *   arrived (the aggregator's `withdraw_succeeded`); the chain's last settlement
 *   callbacks, minutes later under congestion, are followed in the background.
 * - The wallet's own wait is never the verdict. While it works, and after it errors or
 *   times out, the chain is watched for what it sent (key nonces, then the signer's
 *   shard); what's found is followed to the end. Slower than usual is PROCESSING.
 * - Nothing is FAILED without the chain saying so. A rejected approval with nothing on
 *   chain is NOT_SENT; what can't be told either way is UNKNOWN.
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

/**
 * What proves a swap transaction delivered before it settles: its output token reaching the
 * signer. Only for routes through Rhea's aggregator (its events say so) to a token; native NEAR
 * output and everything else is judged when final.
 */
function deliveryOf(plan: OperationPlan, planned: PlannedTransaction): DeliveryExpectation | null {
  const swap = plan.swap
  if (!swap) return null
  const last = planned.actions.at(-1)
  if (last?.kind !== 'call' || last.method !== 'ft_transfer_call') return null
  // Rhea's aggregator reports a token withdrawal; a direct DCL swap delivers the token, or the unwrapped NEAR, itself.
  if (swap.router === 'aggregator') return swap.tokenOut.contract === null ? null : { token: swap.tokenOut.contract, recipient: planned.signerId }
  if (swap.router === 'dcl') return { token: swap.tokenOut.contract ?? 'near', recipient: planned.signerId }
  return null
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
  // Not settled on chain yet is not a failure.
  if (txs.some((t) => t.phase === 'processing')) return 'processing'
  return txs.some((t) => t.phase === 'success') ? 'partial' : 'failed'
}

export interface ExecutorDeps {
  /** `call` reads the signer's access keys: to tell a clean rejection from one that was sent anyway, and to watch the chain. */
  rpc: Pick<RpcClient, 'txStatus'> & Partial<Pick<RpcClient, 'call'>>
  wallet: () => Promise<WalletAdapter>
  policy: ExecutionPolicy
  explorerTxUrl: (hash: string) => string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** How long to follow a submitted transaction before leaving it to Activity (30 min). */
  confirmDeadlineMs?: number
  /**
   * Finds what the wallet sent in the signer's shard (needs `rpc.call`), while the wallet still
   * waits and after it errored or timed out. Without it, a wallet error leaves the step unknown.
   */
  locator?: Pick<TxLocator, 'signedSince'>
  /** Persistence hook (activity records) on every change, including final settlement after the run returned. */
  onUpdate?: (plan: OperationPlan, progress: OperationProgress) => void
}

export type ProgressListener = (progress: OperationProgress) => void

export interface Executor {
  /** Run from the start (`prior` null) or continue a paused run. */
  run(plan: OperationPlan, prior: OperationProgress | null, onProgress: ProgressListener): Promise<OperationProgress>
}

/** How long to let a transaction the wallet may have broadcast land before reading nonces again. */
const REJECTION_SETTLE_MS = 3000
/** Normal swaps land in ~5 s; past this, a step shows as processing. */
export const SLOW_AFTER_MS = 20_000
/** How often the chain is checked for what the wallet sent, while it works or after it failed. */
const WATCH_MS = 2000
/** After the wallet answered without a transaction, how long to look for it on chain. */
const LOCATE_MS = 120_000
/** Following a transaction (and a delivered swap's settlement): congestion has held one for 25 minutes. */
const FOLLOW_MS = 30 * 60_000
const MAX_POLLS = 2000

export const PROCESSING_NOTE = 'Processing — NEAR network is taking longer than usual. NearKit keeps checking the chain; don’t send this again.'
const STILL_PROCESSING_NOTE = 'Still processing on chain. NearKit keeps checking it in Activity; don’t send this again until it settles.'

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

/** An outcome we can read safely; anything else counts as "not final yet". */
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

/** Final: every receipt ran and every block is final (an RPC that doesn't say is taken at its word). */
const isFinal = (r: RpcTxResult) => isReadableOutcome(r) && (r.final_execution_status === undefined || r.final_execution_status === 'FINAL')

/** A transaction still running, with its receipts so far. */
function isRunning(r: unknown): r is RpcTxResult {
  if (!r || typeof r !== 'object') return false
  const o = r as Partial<RpcTxResult>
  return (
    typeof o.transaction?.signer_id === 'string' &&
    Array.isArray(o.receipts_outcome) &&
    o.receipts_outcome.every((x) => x && typeof x.outcome?.executor_id === 'string' && Array.isArray(x.outcome.logs))
  )
}

/** The node has the transaction (included or further along). */
const seenOnChain = (r: unknown) => {
  const s = (r as Partial<RpcTxResult> | null)?.final_execution_status
  return typeof s === 'string' && s !== 'NONE'
}

/** The wallet's error, worded for a step that may still go through. */
function walletErrorInfo(err: NearKitError) {
  const info = errorInfo(err)
  return err.code === 'UNKNOWN' ? { ...info, message: 'The wallet reported an error' } : info
}

type WalletAnswer = { ok: true; results: unknown } | { ok: false; error: NearKitError }

interface Located {
  index: number
  hash: string
}

/**
 * A group's transactions as the chain shows them. Once the signer's key nonces moved past what
 * they were before the wallet was asked, the chunks since the last look are searched for what
 * it signed; each must match a planned transaction exactly (receiver and every action).
 */
function chainFinder(
  locator: Pick<TxLocator, 'signedSince'>,
  keys: (accountId: string) => Promise<KeySnapshot | null>,
  signerId: string,
  before: KeySnapshot & { height: number },
  txs: { index: number; planned: PlannedTransaction }[],
) {
  let scanned = before.height
  const matched = new Set<number>()
  return async (): Promise<Located[]> => {
    const now = await keys(signerId)
    if (!now || now.height === null) return []
    if (keysMoved(before, now) === 0) {
      // Nothing it signed was included up to here.
      scanned = Math.max(scanned, now.height)
      return []
    }
    if (now.height <= scanned) return []
    const found = await locator.signedSince(signerId, before, scanned, now.height)
    scanned = now.height
    const out: Located[] = []
    for (const t of [...found].sort((a, b) => (a.nonce < b.nonce ? -1 : a.nonce > b.nonce ? 1 : 0))) {
      const m = txs.find((x) => !matched.has(x.index) && x.planned.receiverId === t.receiverId && sameActions(t.actions, x.planned.actions))
      if (!m) continue
      matched.add(m.index)
      out.push({ index: m.index, hash: t.hash })
    }
    return out
  }
}

export function createExecutor(deps: ExecutorDeps): Executor {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const followMs = deps.confirmDeadlineMs ?? FOLLOW_MS
  /** Plans that reached the wallet. Starting one again from scratch could pay twice. */
  const started = new Set<string>()
  const call = deps.rpc.call
  const keys = async (accountId: string): Promise<KeySnapshot | null> => (call ? readKeys({ call: call.bind(deps.rpc) as RpcClient['call'] }, accountId) : null)

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

      const patched = (txPatch: Record<number, Partial<TxProgress>>) => progress.txs.map((t) => (txPatch[t.index] ? { ...t, ...txPatch[t.index] } : t))
      const persist = () => {
        try {
          deps.onUpdate?.(plan, progress)
        } catch {
          // Persistence must never interrupt a run that has reached the wallet.
        }
      }
      const update = (patch: Partial<OperationProgress>, txPatch: Record<number, Partial<TxProgress>> = {}) => {
        progress = { ...progress, ...patch, txs: patched(txPatch) }
        onProgress(progress)
        persist()
      }
      /** A change after the steps finished (final settlement): kept and persisted, never reported as progress. */
      const record = (txPatch: Record<number, Partial<TxProgress>>) => {
        progress = { ...progress, txs: patched(txPatch) }
        persist()
      }
      const each = (indexes: number[], patch: Partial<TxProgress>) => Object.fromEntries(indexes.map((i) => [i, patch])) as Record<number, Partial<TxProgress>>
      const phaseOf = (i: number) => progress.txs.find((t) => t.index === i)?.phase
      const finish = () => {
        update({ phase: settledPhase(progress.txs), pause: null, groupIndex: plan.groups.length, finishedAt: now() })
        return progress
      }

      /** A delivered swap's final settlement, followed after the run moved on; the chain's final record is what stays. */
      const settleLater = (txIndex: number, hash: string, signerId: string, planned: PlannedTransaction) => {
        void (async () => {
          const start = now()
          let wait = 2000
          for (let poll = 0; poll < MAX_POLLS; poll++) {
            let r: RpcTxResult | null = null
            try {
              r = await deps.rpc.txStatus(hash, signerId, 'FINAL')
            } catch {
              // Not final yet (the node's wait timed out), or a transport hiccup.
            }
            if (r && isFinal(r)) {
              const verdict = classifyOutcome(r, planned, outcomeContext(plan))
              record({
                [txIndex]:
                  verdict.phase === 'success' ? { note: verdict.note, settling: false } : { phase: verdict.phase, error: verdict.error, note: verdict.note, settling: false },
              })
              return
            }
            if (now() - start >= followMs) return
            await sleep(wait)
            wait = Math.min(Math.round(wait * 1.5), 15_000)
          }
        })().catch(() => undefined)
      }

      /** Follows one submitted transaction to its outcome: a swap's delivery, or the chain's final record. Never throws. */
      const track = async (txIndex: number, hash: string, signerId: string): Promise<void> => {
        const planned = plan.transactions[txIndex] as PlannedTransaction
        try {
          const expect = deliveryOf(plan, planned)
          const context = outcomeContext(plan)
          const start = now()
          let wait = 1000
          let seen = false
          if (phaseOf(txIndex) !== 'processing') update({}, { [txIndex]: { phase: 'confirming' } })
          for (let poll = 0; poll < MAX_POLLS; poll++) {
            let r: unknown = null
            try {
              r = await deps.rpc.txStatus(hash, signerId, 'NONE')
            } catch {
              // Not visible yet, a node timeout, or a transport hiccup: ask again.
            }
            if (seenOnChain(r)) seen = true
            if (isReadableOutcome(r) && isFinal(r)) {
              const verdict = classifyOutcome(r, planned, context)
              update({}, { [txIndex]: { phase: verdict.phase, error: verdict.error, note: verdict.note, settling: false } })
              return
            }
            const delivered = expect && isRunning(r) ? swapDelivered(r, planned, expect, context) : null
            if (delivered) {
              update({}, { [txIndex]: { phase: 'success', error: null, note: delivered.note, settling: true } })
              settleLater(txIndex, hash, signerId, planned)
              return
            }
            if (phaseOf(txIndex) !== 'processing' && now() - start >= SLOW_AFTER_MS) update({}, { [txIndex]: { phase: 'processing', error: null, note: PROCESSING_NOTE } })
            if (now() - start >= followMs) break
            await sleep(wait)
            wait = Math.min(Math.round(wait * 1.5), 5000)
          }
          // Out of time: never "failed" without the chain saying so.
          update(
            {},
            {
              [txIndex]: seen
                ? { phase: 'processing', error: null, note: STILL_PROCESSING_NOTE }
                : { phase: 'unknown', note: 'Submitted, but not confirmed yet. Open it in the explorer to see its status.' },
            },
          )
        } catch (e) {
          update(
            {},
            {
              [txIndex]: {
                phase: 'unknown',
                error: errorInfo(toNearKitError(e)),
                note: 'NearKit lost track of this transaction after it reached the wallet. Check the explorer before trying again.',
              },
            },
          )
        }
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
        const before = await keys(signerId)
        update({ groupIndex: g }, each(group, { phase: 'awaiting_signature', error: null, note: null }))
        started.add(plan.id)

        // Each transaction is followed from the moment its hash is known, from the chain or the wallet.
        const hashes = new Map<number, string>()
        const following: Promise<void>[] = []
        let allFound: () => void = () => undefined
        const everyFound = new Promise<null>((resolve) => (allFound = () => resolve(null)))
        const follow = (found: Located[]) => {
          const fresh = found.filter((f) => !hashes.has(f.index))
          if (!fresh.length) return
          for (const f of fresh) hashes.set(f.index, f.hash)
          update(
            {},
            Object.fromEntries(
              fresh.map((f) => [f.index, { phase: phaseOf(f.index) === 'processing' ? 'processing' : 'submitted', hash: f.hash, explorerUrl: deps.explorerTxUrl(f.hash) }]),
            ) as Record<number, Partial<TxProgress>>,
          )
          for (const f of fresh) following.push(track(f.index, f.hash, signerId))
          if (hashes.size === group.length) allFound()
        }
        const missing = () => group.filter((i) => !hashes.has(i))

        const finder =
          deps.locator && before?.height != null
            ? chainFinder(
                deps.locator,
                keys,
                signerId,
                { ...before, height: before.height },
                group.map((i) => ({ index: i, planned: plan.transactions[i] as PlannedTransaction })),
              )
            : null
        const look = async () => {
          if (!finder) return
          try {
            follow(await finder())
          } catch {
            // The chain answers next time.
          }
        }

        let answered = false
        const answer: Promise<WalletAnswer> = adapter.signAndSendTransactions(signerId, txs.map(toConnectorTransaction)).then(
          (results) => ({ ok: true, results }),
          (e: unknown) => ({ ok: false, error: toNearKitError(e) }),
        )
        void answer.then(() => (answered = true))
        // Watch the chain while the wallet works: a wallet that waits for every callback can answer minutes after the tokens arrived.
        if (finder)
          void (async () => {
            while (!answered && missing().length) {
              await sleep(WATCH_MS)
              if (!answered) await look()
            }
          })()

        // The last approval needs no answer from the wallet once the chain shows everything it sent.
        const w = await (finder && g === plan.groups.length - 1 ? Promise.race([answer, everyFound]) : answer)

        if (w?.ok) {
          const list = Array.isArray(w.results) ? w.results : []
          follow(
            group.flatMap((index, i) => {
              const hash = extractHash(list[i])
              return hash ? [{ index, hash }] : []
            }),
          )
        } else if (w && !w.ok && hashes.size === 0) {
          const err = w.error
          // NearKit's own refusal happens before anything reaches the wallet. A wallet-side
          // rejection is only "not sent" if the account's transaction counter didn't move.
          let nothingSent = err.code === 'WALLET_UNAVAILABLE'
          if (!nothingSent && err.code === 'USER_REJECTED' && before) {
            await sleep(REJECTION_SETTLE_MS)
            const after = await keys(signerId)
            nothingSent = after !== null && keysMoved(before, after) === 0
          }
          if (nothingSent) {
            update({}, { ...each(later, { phase: 'not_sent' }), ...each(group, { phase: 'not_sent', error: errorInfo(err) }) })
            return finish()
          }
          if (!finder) {
            const note =
              err.code === 'USER_REJECTED'
                ? 'The wallet reported the request as rejected or closed, but it may still have been sent. Check the explorer or your wallet activity before trying again.'
                : 'The wallet reported an error. The transaction may or may not have been sent: check your wallet activity before trying again.'
            update({}, { ...each(later, { phase: 'not_sent' }), ...each(group, { phase: 'unknown', error: walletErrorInfo(err), note }) })
            return finish()
          }
        }

        if (missing().length) {
          if (finder) {
            // The wallet didn't say what it sent (it failed or timed out after broadcasting, or returned no hash): look on chain.
            update({}, each(missing(), { phase: 'processing', error: null, note: PROCESSING_NOTE }))
            const until = now() + LOCATE_MS
            while (missing().length && now() < until) {
              await look()
              if (missing().length) await sleep(WATCH_MS)
            }
            // A rejection after some were sent: the rest never left when the counter moved by exactly what was found.
            if (missing().length && w && !w.ok && w.error.code === 'USER_REJECTED' && before) {
              const after = await keys(signerId)
              if (after && keysMoved(before, after) === hashes.size) update({}, each(missing(), { phase: 'not_sent', error: errorInfo(w.error), note: null }))
            }
          }
          const lost = missing().filter((i) => phaseOf(i) !== 'not_sent')
          if (lost.length)
            update(
              {},
              each(lost, {
                phase: 'unknown',
                error: w && !w.ok ? walletErrorInfo(w.error) : null,
                note:
                  w && !w.ok
                    ? 'The wallet reported an error and NearKit couldn’t find the transaction on chain. Check your wallet activity before trying again.'
                    : 'The wallet did not return a transaction hash. Check your wallet activity before trying again.',
              }),
            )
        }

        await Promise.all(following)

        // After a wallet error nothing more is asked of it: the rest stays unsent.
        if (w && !w.ok) {
          update({}, each(later, { phase: 'not_sent' }))
          return finish()
        }

        const troubled = group.some((i) => phaseOf(i) !== 'success')
        if (troubled && g < plan.groups.length - 1) {
          const remaining = later.length
          const rest = `${remaining} ${remaining === 1 ? 'transaction has' : 'transactions have'} not been sent.`
          update({
            phase: 'paused',
            groupIndex: g + 1,
            pause: {
              reason: 'failure',
              signerId: null,
              message: group.some((i) => phaseOf(i) === 'processing')
                ? `A transaction is still processing on chain. ${rest} Continue once it has settled (see Activity).`
                : `A transaction did not succeed. ${rest} Review the results before you continue.`,
            },
          })
          return progress
        }
      }
      return finish()
    },
  }
}
