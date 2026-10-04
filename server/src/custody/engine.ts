import { NEAR_DECIMALS } from '@/config/networks'
import { formatUnits, formatUnitsUp } from '@/lib/amounts'
import { toNearKitError } from '@/services/near/errors'
import { gasPurchaseYocto } from '@/services/near/gas'
import { txDepositYocto } from '@/services/near/plans'
import type { RpcTxResult } from '@/services/near/rpc'
import { randomToken } from '../ids'
import type { Logger } from '../log'
import type { ChainAccess } from './chain'
import type { WalletOperation, WalletTxPlan } from './policy'
import type { TradingSigner } from './signer'
import {
  EXECUTION_LEASE_MS,
  LeaseLostError,
  type ConfirmRefusal,
  type CustodyStore,
  type Intent,
  type IntentKind,
  type IntentResult,
  type TradingWallet,
  type WalletTx,
} from './store'

/**
 * Runs confirmed intents: one Confirm in Telegram, at most one transaction per step.
 *
 * 1. `confirmIntent` moves the intent from quoted to confirmed atomically; a second
 *    press, a replayed callback or a duplicate update changes nothing.
 * 2. The intent's handler re-checks everything against the chain right now and
 *    returns the exact plan (or a new quote when the price moved; then nothing is sent).
 * 3. For each transaction: sign (policy inside the signer, which also signs each
 *    (intent, step) as one transaction only, ever), save the signed bytes and hash to
 *    disk, THEN send. A step is never signed twice.
 * 4. An unclear send is never re-signed or blindly re-sent: the chain is asked for
 *    the hash until it is final, or provably can't land: past its expiry height AND
 *    NearKit's key never reached its nonce. When the key's nonce moved but the chain
 *    doesn't return the hash, nobody can tell, and NearKit never says "nothing was
 *    sent" then. After a restart the resolver does the same, without sending anything.
 * 5. Many server instances may share the database. The instance whose Confirm won
 *    holds the intent's execution lease; it renews it before every signature and
 *    records a signed transaction only while it still holds it. The resolver takes
 *    over only intents whose lease expired (the instance died or stalled), claiming
 *    each with a compare-and-set, so exactly one instance works on an intent at a time.
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
  /**
   * What happened, from a last step that may still be running (`last.result` has its receipts
   * so far): a result as soon as the user's side is done (a buy's tokens arrived), before the
   * chain's settlement callbacks finish; its final record is filed later. Null until then.
   * Without it, the intent settles when final.
   */
  delivered?(intent: Intent, wallet: TradingWallet, earlier: ConfirmedTx[], last: ConfirmedTx): IntentResult | null
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
  /**
   * An intent that just became done, live or in the background: called once, by the
   * instance whose update moved it (referral accounting listens here).
   */
  onDone?: (intent: Intent) => Promise<void>
  /**
   * The kill switches (ops/switches.ts): why this intent may not run now, or null. Checked
   * at Confirm, before anything is planned or signed.
   */
  gate?: (intent: Intent, wallet: TradingWallet) => Promise<string | null>
  /** This server instance's name in execution leases (unique per process). */
  instanceId?: string
  /** How long an execution lease lasts without renewal. */
  leaseMs?: number
  /** How long a later step waits for the wallet to be able to pay for it (REFUND_WAIT_MS). */
  refundWaitMs?: number
}

/** What a caller of `execute` hears while it runs. */
export interface ExecuteHooks {
  /** A transaction is signed and recorded and goes out to the network now (once per step). */
  onSend?: () => void
}

/**
 * A later step waits at most this long for the step before to refund its gas. Refunds land a
 * block or two after the receipts that make them, so this only runs out when something is wrong.
 */
export const REFUND_WAIT_MS = 20_000

/** Past expiry with the key's nonce moved but no such transaction on chain: wait this long before calling it unconfirmed. */
export const AMBIGUOUS_GRACE_BLOCKS = 3_000

const succeeded = (r: RpcTxResult) => {
  const s = r.status as Record<string, unknown> | null
  return Boolean(s && typeof s === 'object' && 'SuccessValue' in s)
}

/** The chain's final record (every receipt ran, every block final), read from a status that may still be running. */
const isFinalRecord = (r: RpcTxResult) => {
  const s = r.status as Record<string, unknown> | null
  return r.final_execution_status === 'FINAL' && Boolean(s && typeof s === 'object' && ('SuccessValue' in s || 'Failure' in s))
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
  const instance = deps.instanceId ?? `local-${randomToken(6)}`
  const leaseMs = deps.leaseMs ?? EXECUTION_LEASE_MS

  /** The handler's delivery check; one that throws counts as "not yet": the final record decides. */
  const deliveredSafely = (handler: IntentHandler, intent: Intent, wallet: TradingWallet, earlier: ConfirmedTx[], last: ConfirmedTx): IntentResult | null => {
    try {
      return handler.delivered?.(intent, wallet, earlier, last) ?? null
    } catch (e) {
      log.warn('delivery check failed; waiting for the final record', { intent: intent.id, error: e })
      return null
    }
  }

  /** Moves an in-flight intent to failed. `moved` is false when something else settled it first (then nothing is logged or told twice). */
  const failIntent = async (intent: Intent, message: string, hashes: string[] = [], facts?: Record<string, unknown>): Promise<{ intent: Intent; moved: boolean }> => {
    const moved = await store.setStatus(intent.id, ['confirmed', 'signing', 'submitted'], 'failed', { result: { ok: false, message, hashes, ...(facts ? { facts } : {}) } })
    if (moved) await store.audit({ userId: intent.userId, walletId: intent.walletId, action: 'intent-failed', detail: { intent: intent.id, message, hashes } })
    return { intent: (await store.intent(intent.id)) as Intent, moved }
  }
  const fail = async (intent: Intent, message: string, hashes: string[] = [], facts?: Record<string, unknown>): Promise<Intent> =>
    (await failIntent(intent, message, hashes, facts)).intent

  /** Waits for a final outcome while keeping the lease; null when it's not final in time (or the lease passed on). */
  async function finalStatus(hash: string, signerId: string, waitMs: number, keep: () => Promise<boolean>): Promise<RpcTxResult | null> {
    const stop = now() + waitMs
    let wait = 500
    for (;;) {
      const r = await chain.status(hash, signerId).catch(() => null)
      if (r) return r
      if (now() >= stop || !(await keep())) return null
      await sleep(wait)
      wait = Math.min(wait * 2, 4000)
    }
  }

  /**
   * Waits for the last step's outcome while keeping the lease: the user's side done (`early`, e.g.
   * a buy's tokens arrived, while the chain's settlement still runs), or the final record. Null when
   * neither arrives in time (or the lease passed on): the resolver takes over.
   */
  async function awaitOutcome(
    hash: string,
    signerId: string,
    waitMs: number,
    keep: () => Promise<boolean>,
    early: (running: RpcTxResult) => IntentResult | null,
  ): Promise<{ kind: 'final'; result: RpcTxResult } | { kind: 'delivered'; result: IntentResult } | null> {
    const stop = now() + waitMs
    let wait = 500
    for (;;) {
      const r = await chain.progress(hash, signerId).catch(() => null)
      if (r && isFinalRecord(r)) return { kind: 'final', result: r }
      const done = r ? early(r) : null
      if (done) return { kind: 'delivered', result: done }
      if (now() >= stop || !(await keep())) return null
      await sleep(wait)
      wait = Math.min(wait * 2, 4000)
    }
  }

  /**
   * Waits until the wallet can pay for a later step: its deposits and the gas the chain holds when
   * it accepts it (NEP-642). Right after the step before, part of that gas may still be on its way
   * back. Null when the step can go, or when the balance can't be read (the chain itself refuses
   * what can't be paid for); otherwise why it can't.
   */
  async function fundsFor(intent: Intent, accountId: string, tx: WalletTxPlan, keep: () => Promise<boolean>): Promise<string | null> {
    const need = txDepositYocto(tx) + gasPurchaseYocto(tx)
    const stop = now() + (deps.refundWaitMs ?? REFUND_WAIT_MS)
    let wait = 500
    for (;;) {
      let available: bigint | null
      try {
        available = await chain.available(accountId)
      } catch (e) {
        log.warn('balance unreadable before a later step; the chain checks it', { intent: intent.id, error: e })
        return null
      }
      if (available !== null && available >= need) return null
      if (now() >= stop) {
        const has = available === null ? 'no NEAR' : `${formatUnits(available, NEAR_DECIMALS, { maxFraction: 4 })} NEAR`
        return `The next step needs ${formatUnitsUp(need, NEAR_DECIMALS, 4)} NEAR available and your NearKit wallet has ${has}, so it wasn’t sent.`
      }
      if (!(await keep())) throw new LeaseLostError(intent.id)
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
    return settleWith(intent, result)
  }

  /** Moves an in-flight intent to its result: once, by whichever run or resolver gets there first. */
  async function settleWith(intent: Intent, result: IntentResult): Promise<{ intent: Intent; moved: boolean }> {
    const hashes = result.hashes
    const moved = await store.setStatus(intent.id, ['signing', 'submitted'], result.ok ? 'done' : 'failed', { result })
    if (moved)
      await store.audit({
        userId: intent.userId,
        walletId: intent.walletId,
        action: result.ok ? 'intent-done' : 'intent-failed',
        detail: { intent: intent.id, hashes, facts: result.facts },
      })
    const after = (await store.intent(intent.id)) as Intent
    if (moved && result.ok) await deps.onDone?.(after).catch((e: unknown) => log.warn('done hook failed', { intent: intent.id, error: e }))
    return { intent: after, moved }
  }

  async function run(intent: Intent, wallet: TradingWallet, op: WalletOperation, plan: WalletTxPlan[], owner: string, hooks: ExecuteHooks): Promise<ExecuteResult> {
    const confirmed: ConfirmedTx[] = []
    let lastNonce: bigint | null = null
    const keep = () => store.renewLease(intent.id, owner, leaseMs)
    for (let step = 0; step < plan.length; step++) {
      // Only the lease holder signs: if another instance took the intent over, stop here.
      if (!(await keep())) throw new LeaseLostError(intent.id)
      const tx = plan[step] as WalletTxPlan
      // The plan's funds were checked before the first step, counting on each step's gas refund.
      if (step > 0) {
        const short = await fundsFor(intent, wallet.accountId, tx, keep)
        if (short) {
          log.warn('a later step can’t be paid for; stopping', { intent: intent.id, step })
          return {
            kind: 'finished',
            intent: await fail(
              intent,
              `${short} Earlier steps went through; see the transactions.`,
              confirmed.map((c) => c.hash),
            ),
          }
        }
      }
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
            intent: await fail(
              intent,
              msg,
              confirmed.map((c) => c.hash),
            ),
          }
        }
        nonce = (lastNonce !== null && lastNonce >= onChain ? lastNonce : onChain) + 1n
        const anchor = await chain.anchor()
        expiresHeight = anchor.expiresHeight
        signed = await signer.sign({ wallet, intentId: intent.id, step, op, plan, nonce, blockHash: anchor.hash })
      } catch (e) {
        log.warn('signing refused', { intent: intent.id, step, error: e })
        const hashes = confirmed.map((c) => c.hash)
        const before = step > 0 ? ' Earlier steps went through; see the transactions.' : ' Nothing was sent.'
        return { kind: 'finished', intent: await fail(intent, `${explain(e)}${before}`, hashes) }
      }
      // On disk before it leaves: after any crash, NearKit knows this hash and never signs the step again.
      // Recorded only while this instance holds the lease; otherwise LeaseLostError and nothing is sent.
      await store.recordSigned({
        owner,
        leaseMs,
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
      await store.audit({
        userId: intent.userId,
        walletId: wallet.id,
        action: 'tx-signed',
        detail: { intent: intent.id, step, hash: signed.hash, receiver: tx.receiverId, nonce: nonce.toString() },
      })
      lastNonce = nonce

      hooks.onSend?.()
      const sent = await chain.send(signed.base64)
      await store.markTx(intent.id, step, 'submitted')
      await store.audit({ userId: intent.userId, walletId: wallet.id, action: 'tx-sent', detail: { intent: intent.id, step, hash: signed.hash, answer: sent.kind } })
      let result: RpcTxResult | null = null
      if (sent.kind === 'rejected') {
        // Refused by the node. Ask the chain once anyway before calling it failed.
        result = await chain.status(signed.hash, wallet.accountId).catch(() => null)
        if (!result) {
          await store.markTx(intent.id, step, 'failed', { reason: sent.reason })
          log.warn('transaction rejected', { intent: intent.id, step, hash: signed.hash, reason: sent.reason })
          const done = confirmed.length ? ' Earlier steps went through; see the transactions.' : ' Nothing was sent.'
          return {
            kind: 'finished',
            intent: await fail(
              intent,
              `The network refused the transaction.${done}`,
              confirmed.map((c) => c.hash),
            ),
          }
        }
      } else if (sent.kind === 'unknown') {
        log.warn('send unclear; asking the chain', { intent: intent.id, step, hash: signed.hash, reason: sent.reason })
      }
      // The last step of an intent that can be done before it settles (a buy's tokens arrived) is reported then.
      const handler = deps.handlers[intent.kind]
      if (step === plan.length - 1 && handler?.delivered) {
        const outcome = await awaitOutcome(signed.hash, wallet.accountId, deps.confirmMs ?? 60_000, keep, (running) =>
          deliveredSafely(handler, intent, wallet, confirmed, { plan: tx, hash: signed.hash, result: running }),
        )
        if (outcome?.kind === 'delivered') {
          await store.audit({ userId: intent.userId, walletId: wallet.id, action: 'tx-delivered', detail: { intent: intent.id, step, hash: signed.hash } })
          return { kind: 'finished', intent: (await settleWith(intent, outcome.result)).intent }
        }
        result = outcome?.result ?? null
      } else {
        result = await finalStatus(signed.hash, wallet.accountId, deps.confirmMs ?? 60_000, keep)
      }
      if (!result) {
        await store.setStatus(intent.id, ['signing'], 'submitted')
        await store.audit({ userId: intent.userId, walletId: wallet.id, action: 'tx-unclear', detail: { intent: intent.id, step, hash: signed.hash } })
        return { kind: 'pending', intent: (await store.intent(intent.id)) as Intent }
      }
      const ok = succeeded(result)
      await store.markTx(intent.id, step, ok ? 'success' : 'failed', { success: ok })
      confirmed.push({ plan: tx, hash: signed.hash, result })
      // A registration that failed stops the plan; the last step is judged by its handler.
      if (!ok && step < plan.length - 1) {
        return {
          kind: 'finished',
          intent: await fail(
            intent,
            'A preparation step failed on chain, so the rest was not sent.',
            confirmed.map((c) => c.hash),
          ),
        }
      }
    }
    return { kind: 'finished', intent: (await settle(intent, wallet, confirmed)).intent }
  }

  const api = {
    /** The Confirm button. Safe to call any number of times for the same intent. */
    async execute(intentId: string, userId: number, hooks: ExecuteHooks = {}): Promise<ExecuteResult> {
      // This execution's name in the lease: the resolver (even in this process) can't take it while it lives.
      const owner = `${instance}/x/${randomToken(6)}`
      const c = await store.confirmIntent(intentId, userId, { owner, ms: leaseMs })
      if (!c.ok) return { kind: 'refused', reason: c.reason, intent: c.intent }
      const intent = c.intent
      try {
        const wallet = (await store.wallet(intent.walletId)) as TradingWallet
        const handler = deps.handlers[intent.kind]
        if (!handler) return { kind: 'finished', intent: await fail(intent, 'NearKit can’t do that here. Nothing was sent.') }
        const blocked = deps.gate ? await deps.gate(intent, wallet).catch(() => 'NearKit can’t confirm that this is allowed right now. Try again in a moment.') : null
        if (blocked) {
          await store.audit({ userId: intent.userId, walletId: intent.walletId, action: 'intent-blocked', detail: { intent: intent.id, kind: intent.kind, reason: blocked } })
          return { kind: 'finished', intent: await fail(intent, `${blocked} Nothing was sent.`) }
        }
        let outcome: PlanOutcome
        try {
          outcome = await handler.plan(intent, wallet)
        } catch (e) {
          log.info('intent refused before signing', { intent: intent.id, kind: intent.kind, error: e })
          return { kind: 'finished', intent: await fail(intent, `${explain(e)} Nothing was sent.`) }
        }
        if (outcome.kind === 'requote') {
          const next = await store.createIntent({
            walletId: intent.walletId,
            userId: intent.userId,
            chatId: intent.chatId,
            kind: intent.kind,
            params: intent.params,
            quote: outcome.quote,
            ttlMs: outcome.ttlMs,
          })
          await store.setStatus(intent.id, ['confirmed'], 'replaced', {
            replacedBy: next.id,
            result: { ok: false, message: 'The quote changed. Review the new price.', hashes: [] },
          })
          return { kind: 'requoted', intent: (await store.intent(intent.id)) as Intent, next }
        }
        return await run(intent, wallet, outcome.op, outcome.plan, owner, hooks)
      } catch (e) {
        if (!(e instanceof LeaseLostError)) throw e
        // Another instance took the intent over (this one stalled past its lease): it reports the outcome.
        log.warn('execution lease lost; the resolver finishes this intent', { intent: intent.id })
        return { kind: 'pending', intent: (await store.intent(intent.id)) as Intent }
      } finally {
        // Settled, or handed to the resolver: either way this execution is over.
        await store.releaseLease(intent.id, owner).catch(() => undefined)
      }
    },

    /**
     * Settles whatever was in flight: after a restart, or after a live Confirm gave up
     * waiting. Only reads the chain; never signs or sends.
     */
    async resolvePending(): Promise<Intent[]> {
      await store.expireQuotes()
      const settled: Intent[] = []
      const owner = `${instance}/r/${randomToken(6)}`
      const keep = (r: { intent: Intent; moved: boolean }) => {
        if (r.moved) settled.push(r.intent)
      }
      for (const listed of await store.unattended()) {
        // Exactly one resolver (on any instance) takes each intent; one that is being run is not listed.
        if (!(await store.claimIntent(listed.id, owner, leaseMs))) continue
        try {
          const intent = await store.intent(listed.id)
          if (intent) await resolveOne(intent, keep)
        } finally {
          await store.releaseLease(listed.id, owner).catch(() => undefined)
        }
      }
      for (const i of settled) await deps.onSettled?.(i).catch((e: unknown) => log.warn('settled notice failed', { intent: i.id, error: e }))
      await fileSettlements()
      return settled
    },
  }

  /**
   * Files the final record of trades already reported (their tokens arrived before the chain's
   * settlement finished). Reads only; the user was told already and hears nothing more.
   */
  async function fileSettlements(): Promise<void> {
    for (const t of await store.settlingTxs().catch(() => [])) {
      try {
        const r = await chain.status(t.hash, t.signerId).catch(() => null)
        if (!r) continue
        const ok = succeeded(r)
        if (!(await store.settleTx(t.intentId, t.step, ok ? 'success' : 'failed', { success: ok }))) continue
        await store.audit({ userId: t.userId, walletId: t.walletId, action: 'tx-settled', detail: { intent: t.intentId, step: t.step, hash: t.hash, success: ok } })
        if (!ok) log.warn('a trade reported on delivery settled as failed on chain', { intent: t.intentId, step: t.step, hash: t.hash })
      } catch (e) {
        log.warn('filing a settlement failed; next pass', { intent: t.intentId, step: t.step, error: e })
      }
    }
  }

  /** Settles one claimed intent from the chain's record, if it can be settled yet. Reads only. */
  async function resolveOne(intent: Intent, keep: (r: { intent: Intent; moved: boolean }) => void): Promise<void> {
    const wallet = await store.wallet(intent.walletId)
    if (!wallet) return
    // Read after the claim: an executor that lost its lease can no longer add to these.
    const txs = await store.txsOf(intent.id)
    if (!txs.length) {
      // Confirmed, then stopped before anything was signed: nothing can have been sent.
      keep(await failIntent(intent, 'NearKit restarted before sending anything. Nothing was sent; try again.'))
      return
    }
    let unresolved = false
    /** The last step still running on chain: its user side may already be done (a buy's tokens arrived). */
    let running: { t: WalletTx; step: StoredStep } | null = null
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
        await store.markTx(intent.id, t.step, succeeded(r) ? 'success' : 'failed', { success: succeeded(r) })
        await store.audit({
          userId: intent.userId,
          walletId: intent.walletId,
          action: 'tx-resolved',
          detail: { intent: intent.id, step: t.step, hash: t.hash, success: succeeded(r) },
        })
        continue
      }
      if (seen) {
        const step = stepOf(t)
        if (step && t.step === step.total - 1) running = { t, step }
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
        await store.markTx(intent.id, t.step, 'expired', { reason: 'past its expiry height; NearKit’s key never used its nonce' })
      } else if (nonce !== undefined && height > t.expiresHeight + AMBIGUOUS_GRACE_BLOCKS) {
        // The key's nonce moved (or the key is gone) but the chain returns no such transaction: nobody can tell.
        await store.markTx(intent.id, t.step, 'unconfirmed', { reason: 'the key’s nonce moved but the chain does not return this transaction' })
      } else {
        unresolved = true
      }
    }
    if (unresolved) {
      if (running) await settleIfDelivered(intent, wallet, running, keep)
      return
    }

    const all = await store.txsOf(intent.id)
    const landed = all.filter((t) => t.status === 'success' || t.status === 'failed')
    const total = stepOf(all[0] as WalletTx)?.total ?? all.length
    const unknown = all.find((t) => t.status === 'unconfirmed')
    if (unknown) {
      // Never "nothing was sent" here: it may have gone through.
      keep(
        await failIntent(
          intent,
          'NearKit couldn’t confirm whether a transaction went through: the chain doesn’t return it, though the wallet’s key was used. Check the wallet’s balance and history before trying again.',
          [...landed.map((t) => t.hash), unknown.hash],
        ),
      )
      return
    }
    const lost = all.find((t) => t.status === 'expired' || (t.status === 'failed' && !(t.outcome && 'success' in t.outcome)))
    if (lost) {
      const msg = landed.length
        ? 'A transaction never reached the chain, so the rest was not sent. Earlier steps went through; see the transactions.'
        : 'The transaction never reached the chain. Nothing was sent.'
      keep(
        await failIntent(
          intent,
          msg,
          landed.map((t) => t.hash),
        ),
      )
      return
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
    if (!readable) return
    const failedEarly = confirmed.slice(0, -1).some((c) => !succeeded(c.result))
    if (failedEarly)
      keep(
        await failIntent(
          intent,
          'A preparation step failed on chain, so the rest was not sent.',
          confirmed.map((c) => c.hash),
        ),
      )
    else if (confirmed.length < total)
      keep(
        await failIntent(
          intent,
          'NearKit restarted between steps, so the rest was not sent. Nothing was traded; try again.',
          confirmed.map((c) => c.hash),
        ),
      )
    else keep(await settle(intent, wallet, confirmed))
  }

  /**
   * An intent whose last step is still running on chain: reported now if its user side is done
   * (earlier steps all succeeded, and the handler says so from the receipts so far).
   */
  async function settleIfDelivered(
    intent: Intent,
    wallet: TradingWallet,
    running: { t: WalletTx; step: StoredStep },
    keep: (r: { intent: Intent; moved: boolean }) => void,
  ): Promise<void> {
    const handler = deps.handlers[intent.kind]
    if (!handler?.delivered) return
    const all = await store.txsOf(intent.id)
    const earlierTxs = all.filter((x) => x.step < running.t.step)
    if (earlierTxs.length !== running.t.step || earlierTxs.some((x) => x.status !== 'success')) return
    const earlier: ConfirmedTx[] = []
    for (const x of earlierTxs) {
      const r = await chain.status(x.hash, x.signerId).catch(() => null)
      const step = stepOf(x)
      if (!r || !step) return
      earlier.push({ plan: step.tx, hash: x.hash, result: r })
    }
    const partial = await chain.progress(running.t.hash, running.t.signerId).catch(() => null)
    if (!partial) return
    const result = deliveredSafely(handler, intent, wallet, earlier, { plan: running.step.tx, hash: running.t.hash, result: partial })
    if (!result) return
    await store.audit({ userId: intent.userId, walletId: wallet.id, action: 'tx-delivered', detail: { intent: intent.id, step: running.t.step, hash: running.t.hash } })
    keep(await settleWith(intent, result))
  }

  return api
}

export type Engine = ReturnType<typeof createEngine>
