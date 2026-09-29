import { toNearKitError } from '@/services/near/errors'
import type { RpcTxResult } from '@/services/near/rpc'
import type { Logger } from '../log'
import type { ChainAccess } from './chain'
import type { WalletOperation, WalletTxPlan } from './policy'
import type { TradingSigner } from './signer'
import type { ConfirmRefusal, CustodyStore, Intent, IntentKind, IntentResult, TradingWallet, WalletTx } from './store'

/**
 * Runs confirmed intents: one Confirm in Telegram, at most one transaction per step.
 *
 * 1. `confirmIntent` moves the intent from quoted to confirmed atomically; a second
 *    press, a replayed callback or a duplicate update changes nothing.
 * 2. The intent's handler re-checks everything against the chain right now and
 *    returns the exact plan (or a new quote when the price moved; then nothing is sent).
 * 3. For each transaction: sign (policy inside the signer), save the signed bytes
 *    and hash to disk, THEN send. A step is never signed twice.
 * 4. An unclear send is never re-signed or blindly re-sent: the chain is asked for
 *    the hash until it is final, or provably can't land: past its expiry height AND
 *    NearKit's key never reached its nonce. When the key's nonce moved but the chain
 *    doesn't return the hash, nobody can tell, and NearKit never says "nothing was
 *    sent" then. After a restart the resolver does the same, without sending anything.
 */

export type PlanOutcome = { kind: 'plan'; op: WalletOperation; plan: WalletTxPlan[] } | { kind: 'requote'; quote: Record<string, unknown>; ttlMs: number }

export interface ConfirmedTx {
  plan: WalletTxPlan
  hash: string
  result: RpcTxResult
}

export interface IntentHandler {
  /** Fresh checks and the exact transactions, right before signing. Throws to refuse: nothing is sent. */
  plan(intent: Intent, wallet: TradingWallet): Promise<PlanOutcome>
  /** What happened, from the chain's own record of the transactions that landed. */
  summarize(intent: Intent, wallet: TradingWallet, confirmed: ConfirmedTx[]): Promise<IntentResult>
}

export type ExecuteResult =
  | { kind: 'refused'; reason: ConfirmRefusal; intent: Intent | null }
  | { kind: 'requoted'; intent: Intent; next: Intent }
  /** Done or failed: `intent.result` says what happened. */
  | { kind: 'finished'; intent: Intent }
  /** Sent but not final yet: the resolver finishes it and reports. */
  | { kind: 'pending'; intent: Intent }

/** Saved with each signed transaction, so a restart knows the whole plan. */
interface StoredStep {
  tx: WalletTxPlan
  total: number
}

export interface EngineDeps {
  store: CustodyStore
  signer: TradingSigner
  chain: ChainAccess
  handlers: Partial<Record<IntentKind, IntentHandler>>
  log: Logger
  /** A refusal or failure in a few plain words for the user. */
  explain?: (e: unknown) => string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** How long a live Confirm waits for finality before handing over to the resolver. */
  confirmMs?: number
  /** An intent the resolver settled in the background (after a timeout or a restart). */
  onSettled?: (intent: Intent) => Promise<void>
}

/** Past expiry with the key's nonce moved but no such transaction on chain: wait this long before calling it unconfirmed. */
export const AMBIGUOUS_GRACE_BLOCKS = 3_000

const succeeded = (r: RpcTxResult) => {
  const s = r.status as Record<string, unknown> | null
  return Boolean(s && typeof s === 'object' && 'SuccessValue' in s)
}

const stepOf = (t: WalletTx): StoredStep | null => {
  const p = t.plan as Partial<StoredStep> | null
  return p && p.tx && typeof p.total === 'number' ? (p as StoredStep) : null
}

export function createEngine(deps: EngineDeps) {
  const { store, signer, chain, log } = deps
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const explain = deps.explain ?? ((e: unknown) => toNearKitError(e).message)
  /** Wallets with a live run in this process; the resolver leaves them alone. */
  const running = new Set<string>()

  /** Moves an in-flight intent to failed. `moved` is false when something else settled it first (then nothing is logged or told twice). */
  const failIntent = (intent: Intent, message: string, hashes: string[] = [], facts?: Record<string, unknown>): { intent: Intent; moved: boolean } => {
    const moved = store.setStatus(intent.id, ['confirmed', 'signing', 'submitted'], 'failed', { result: { ok: false, message, hashes, ...(facts ? { facts } : {}) } })
    if (moved) store.audit({ userId: intent.userId, walletId: intent.walletId, action: 'intent-failed', detail: { intent: intent.id, message, hashes } })
    return { intent: store.intent(intent.id) as Intent, moved }
  }
  const fail = (intent: Intent, message: string, hashes: string[] = [], facts?: Record<string, unknown>): Intent => failIntent(intent, message, hashes, facts).intent

  async function finalStatus(hash: string, signerId: string, waitMs: number): Promise<RpcTxResult | null> {
    const stop = now() + waitMs
    let wait = 500
    for (;;) {
      const r = await chain.status(hash, signerId).catch(() => null)
      if (r) return r
      if (now() >= stop) return null
      await sleep(wait)
      wait = Math.min(wait * 2, 4000)
    }
  }

  async function settle(intent: Intent, wallet: TradingWallet, confirmed: ConfirmedTx[]): Promise<{ intent: Intent; moved: boolean }> {
    const handler = deps.handlers[intent.kind]
    const hashes = confirmed.map((c) => c.hash)
    let result: IntentResult
    try {
      result = handler ? await handler.summarize(intent, wallet, confirmed) : { ok: true, message: 'Confirmed on chain.', hashes }
    } catch (e) {
      log.warn('summarize failed', { intent: intent.id, error: e })
      result = { ok: confirmed.every((c) => succeeded(c.result)), message: 'Confirmed on chain. Open the transaction for the details.', hashes }
    }
    const moved = store.setStatus(intent.id, ['signing', 'submitted'], result.ok ? 'done' : 'failed', { result })
    if (moved)
      store.audit({
        userId: intent.userId,
        walletId: intent.walletId,
        action: result.ok ? 'intent-done' : 'intent-failed',
        detail: { intent: intent.id, hashes, facts: result.facts },
      })
    return { intent: store.intent(intent.id) as Intent, moved }
  }

  async function run(intent: Intent, wallet: TradingWallet, op: WalletOperation, plan: WalletTxPlan[]): Promise<ExecuteResult> {
    const confirmed: ConfirmedTx[] = []
    let lastNonce: bigint | null = null
    for (let step = 0; step < plan.length; step++) {
      const tx = plan[step] as WalletTxPlan
      let signed
      let expiresHeight: number
      let nonce: bigint
      try {
        const onChain = await chain.keyNonce(wallet.accountId, wallet.publicKey)
        if (onChain === null) {
          const msg =
            step === 0 ? 'Your NearKit wallet isn’t on chain yet: deposit NEAR to it first. Nothing was sent.' : 'NearKit’s key is no longer on this wallet. Nothing more was sent.'
          return {
            kind: 'finished',
            intent: fail(
              intent,
              msg,
              confirmed.map((c) => c.hash),
            ),
          }
        }
        nonce = (lastNonce !== null && lastNonce >= onChain ? lastNonce : onChain) + 1n
        const anchor = await chain.anchor()
        expiresHeight = anchor.expiresHeight
        signed = await signer.sign({ wallet, op, plan, index: step, nonce, blockHash: anchor.hash })
      } catch (e) {
        log.warn('signing refused', { intent: intent.id, step, error: e })
        const hashes = confirmed.map((c) => c.hash)
        const before = step > 0 ? ' Earlier steps went through; see the transactions.' : ' Nothing was sent.'
        return { kind: 'finished', intent: fail(intent, `${explain(e)}${before}`, hashes) }
      }
      // On disk before it leaves: after any crash, NearKit knows this hash and never signs the step again.
      store.recordSigned({
        intentId: intent.id,
        step,
        hash: signed.hash,
        signerId: wallet.accountId,
        receiverId: tx.receiverId,
        nonce,
        expiresHeight,
        signed: signed.base64,
        plan: { tx, total: plan.length } satisfies StoredStep,
      })
      store.audit({
        userId: intent.userId,
        walletId: wallet.id,
        action: 'tx-signed',
        detail: { intent: intent.id, step, hash: signed.hash, receiver: tx.receiverId, nonce: nonce.toString() },
      })
      lastNonce = nonce

      const sent = await chain.send(signed.base64)
      store.markTx(intent.id, step, 'submitted')
      let result: RpcTxResult | null = null
      if (sent.kind === 'rejected') {
        // Refused by the node. Ask the chain once anyway before calling it failed.
        result = await chain.status(signed.hash, wallet.accountId).catch(() => null)
        if (!result) {
          store.markTx(intent.id, step, 'failed', { reason: sent.reason })
          log.warn('transaction rejected', { intent: intent.id, step, hash: signed.hash, reason: sent.reason })
          const done = confirmed.length ? ' Earlier steps went through; see the transactions.' : ' Nothing was sent.'
          return {
            kind: 'finished',
            intent: fail(
              intent,
              `The network refused the transaction.${done}`,
              confirmed.map((c) => c.hash),
            ),
          }
        }
      } else if (sent.kind === 'unknown') {
        log.warn('send unclear; asking the chain', { intent: intent.id, step, hash: signed.hash, reason: sent.reason })
      }
      result = await finalStatus(signed.hash, wallet.accountId, deps.confirmMs ?? 60_000)
      if (!result) {
        store.setStatus(intent.id, ['signing'], 'submitted')
        store.audit({ userId: intent.userId, walletId: wallet.id, action: 'tx-unclear', detail: { intent: intent.id, step, hash: signed.hash } })
        return { kind: 'pending', intent: store.intent(intent.id) as Intent }
      }
      const ok = succeeded(result)
      store.markTx(intent.id, step, ok ? 'success' : 'failed', { success: ok })
      confirmed.push({ plan: tx, hash: signed.hash, result })
      // A registration that failed stops the plan; the last step is judged by its handler.
      if (!ok && step < plan.length - 1) {
        return {
          kind: 'finished',
          intent: fail(
            intent,
            'A preparation step failed on chain, so the rest was not sent.',
            confirmed.map((c) => c.hash),
          ),
        }
      }
    }
    return { kind: 'finished', intent: (await settle(intent, wallet, confirmed)).intent }
  }

  return {
    /** The Confirm button. Safe to call any number of times for the same intent. */
    async execute(intentId: string, userId: number): Promise<ExecuteResult> {
      const c = store.confirmIntent(intentId, userId)
      if (!c.ok) return { kind: 'refused', reason: c.reason, intent: c.intent }
      const intent = c.intent
      if (running.has(intent.walletId)) return { kind: 'refused', reason: 'busy', intent }
      running.add(intent.walletId)
      try {
        const wallet = store.wallet(intent.walletId) as TradingWallet
        const handler = deps.handlers[intent.kind]
        if (!handler) return { kind: 'finished', intent: fail(intent, 'NearKit can’t do that here. Nothing was sent.') }
        let outcome: PlanOutcome
        try {
          outcome = await handler.plan(intent, wallet)
        } catch (e) {
          log.info('intent refused before signing', { intent: intent.id, kind: intent.kind, error: e })
          return { kind: 'finished', intent: fail(intent, `${explain(e)} Nothing was sent.`) }
        }
        if (outcome.kind === 'requote') {
          const next = store.createIntent({
            walletId: intent.walletId,
            userId: intent.userId,
            chatId: intent.chatId,
            kind: intent.kind,
            params: intent.params,
            quote: outcome.quote,
            ttlMs: outcome.ttlMs,
          })
          store.setStatus(intent.id, ['confirmed'], 'replaced', { replacedBy: next.id, result: { ok: false, message: 'The quote changed. Review the new price.', hashes: [] } })
          return { kind: 'requoted', intent: store.intent(intent.id) as Intent, next }
        }
        return await run(intent, wallet, outcome.op, outcome.plan)
      } finally {
        running.delete(intent.walletId)
      }
    },

    /**
     * Settles whatever was in flight: after a restart, or after a live Confirm gave up
     * waiting. Only reads the chain; never signs or sends.
     */
    async resolvePending(): Promise<Intent[]> {
      store.expireQuotes()
      const settled: Intent[] = []
      for (const intent of store.allInFlight()) {
        if (running.has(intent.walletId)) continue
        const wallet = store.wallet(intent.walletId)
        if (!wallet) continue
        const txs = store.txsOf(intent.id)
        const keep = (r: { intent: Intent; moved: boolean }) => {
          if (r.moved) settled.push(r.intent)
        }
        if (!txs.length) {
          // Confirmed, then stopped before anything was signed: nothing can have been sent.
          keep(failIntent(intent, 'NearKit restarted before sending anything. Nothing was sent; try again.'))
          continue
        }
        let unresolved = false
        for (const t of txs) {
          if (t.status === 'success' || t.status === 'failed' || t.status === 'expired' || t.status === 'unconfirmed') continue
          let r: RpcTxResult | null
          let seen: boolean
          try {
            r = await chain.status(t.hash, t.signerId)
            // Not final: if the chain knows the hash at all, it landed; wait for its outcome.
            seen = r !== null || (await chain.seen(t.hash, t.signerId))
          } catch {
            unresolved = true
            continue
          }
          if (r) {
            store.markTx(intent.id, t.step, succeeded(r) ? 'success' : 'failed', { success: succeeded(r) })
            continue
          }
          if (seen) {
            unresolved = true
            continue
          }
          const [height, nonce] = await Promise.all([chain.finalHeight().catch(() => null), chain.keyNonce(t.signerId, wallet.publicKey).catch(() => undefined)])
          // Until its expiry height passes, it may still land.
          if (height === null || height <= t.expiresHeight) {
            unresolved = true
            continue
          }
          if (nonce !== undefined && nonce !== null && nonce < t.nonce) {
            // Nonces only go up, so the key never used this one, and past expiry it never can: provably not executed.
            store.markTx(intent.id, t.step, 'expired', { reason: 'past its expiry height; NearKit’s key never used its nonce' })
          } else if (nonce !== undefined && height > t.expiresHeight + AMBIGUOUS_GRACE_BLOCKS) {
            // The key's nonce moved (or the key is gone) but the chain returns no such transaction: nobody can tell.
            store.markTx(intent.id, t.step, 'unconfirmed', { reason: 'the key’s nonce moved but the chain does not return this transaction' })
          } else {
            unresolved = true
          }
        }
        if (unresolved) continue

        const all = store.txsOf(intent.id)
        const landed = all.filter((t) => t.status === 'success' || t.status === 'failed')
        const total = stepOf(all[0] as WalletTx)?.total ?? all.length
        const unknown = all.find((t) => t.status === 'unconfirmed')
        if (unknown) {
          // Never "nothing was sent" here: it may have gone through.
          keep(
            failIntent(
              intent,
              'NearKit couldn’t confirm whether a transaction went through: the chain doesn’t return it, though the wallet’s key was used. Check the wallet’s balance and history before trying again.',
              [...landed.map((t) => t.hash), unknown.hash],
            ),
          )
          continue
        }
        const lost = all.find((t) => t.status === 'expired' || (t.status === 'failed' && !(t.outcome && 'success' in t.outcome)))
        if (lost) {
          const msg = landed.length
            ? 'A transaction never reached the chain, so the rest was not sent. Earlier steps went through; see the transactions.'
            : 'The transaction never reached the chain. Nothing was sent.'
          keep(
            failIntent(
              intent,
              msg,
              landed.map((t) => t.hash),
            ),
          )
          continue
        }
        const confirmed: ConfirmedTx[] = []
        let readable = true
        for (const t of landed) {
          const r = await chain.status(t.hash, t.signerId).catch(() => null)
          const step = stepOf(t)
          if (!r || !step) {
            readable = false
            break
          }
          confirmed.push({ plan: step.tx, hash: t.hash, result: r })
        }
        if (!readable) continue
        const failedEarly = confirmed.slice(0, -1).some((c) => !succeeded(c.result))
        if (failedEarly)
          keep(
            failIntent(
              intent,
              'A preparation step failed on chain, so the rest was not sent.',
              confirmed.map((c) => c.hash),
            ),
          )
        else if (confirmed.length < total)
          keep(
            failIntent(
              intent,
              'NearKit restarted between steps, so the rest was not sent. Nothing was traded; try again.',
              confirmed.map((c) => c.hash),
            ),
          )
        else keep(await settle(intent, wallet, confirmed))
      }
      for (const i of settled) await deps.onSettled?.(i).catch((e: unknown) => log.warn('settled notice failed', { intent: i.id, error: e }))
      return settled
    },
  }
}

export type Engine = ReturnType<typeof createEngine>
