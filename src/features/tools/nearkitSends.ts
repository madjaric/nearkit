import { createLimiter } from '@/lib/async'
import { describeError } from '@/services/errors'
import type { NearKitWeb, SendApproval, WebLegStatus, WebSendReview } from '@/services/nearkitWeb'
import { LinkRequestError } from '@/services/telegramLink'

/**
 * Split and Batch Send from a NearKit wallet, and Consolidate from several. NearKit's server signs
 * for these wallets, so every line is an ordinary web send: the server reviews it (the custody rule:
 * the wallet's owner, or an address approved for it; the signer enforces it again), then runs it.
 * Nothing here decides who may receive: a line the server refuses says why, and how its address gets
 * approved.
 *
 * Lines are reviewed a few at a time, and sent strictly one after another: the next starts only
 * once the one before it is done, so one wallet's sends never race for its key's nonce. A failed
 * send is reported, never retried; a review that expired meanwhile is reviewed again (the same
 * destination and amount) before it is sent.
 */

export interface SendLine {
  /** The destination's full account id. */
  to: string
  /** An exact decimal amount in the token's units. */
  amount: string
  label?: string
  /** The NearKit wallet this line is sent from, when the lines come from several (Consolidate); otherwise the batch's wallet. */
  from?: { walletId: string; label: string; accountId: string }
}

export type SendsApi = Pick<NearKitWeb, 'reviewSend' | 'executeSend' | 'sendStatus'>

export type LineState =
  | { kind: 'reviewing' }
  | { kind: 'ready'; intentId: string; expiresAt: number; review: WebSendReview }
  | { kind: 'approval'; approval: SendApproval | null; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'sending' }
  | { kind: 'sent'; hashes: string[] }
  | { kind: 'failed'; message: string }

const REVIEW_CONCURRENCY = 3
/** A review this close to expiring is reviewed again before it is sent. */
const REVIEW_MARGIN_MS = 20_000
const POLL_MS = 1_500
/** How long one send is followed; past it the batch starts nothing more (it may still be running). */
const SEND_WAIT_MS = 3 * 60_000
export const NOT_SENT = 'Not sent: the batch stopped before this line.'
const STILL_RUNNING = 'Still running on NEARKITS’ server: check this wallet’s activity before sending again. Nothing after it was started.'

const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message : describeError(e).message)
const finished = (s: WebLegStatus) => s === 'done' || s === 'failed' || s === 'cancelled' || s === 'expired'

async function reviewOne(api: SendsApi, walletId: string, asset: string, line: SendLine): Promise<LineState> {
  try {
    const r = await api.reviewSend({ walletId, token: asset, amount: line.amount, to: line.to })
    return { kind: 'ready', intentId: r.intentId, expiresAt: r.expiresAt, review: r.review }
  } catch (e) {
    if (e instanceof LinkRequestError && e.code === 'needs-approval') return { kind: 'approval', approval: (e.detail as SendApproval | null) ?? null, message: e.message }
    return { kind: 'error', message: messageOf(e) }
  }
}

/** Reviews every line (a few at a time): each becomes ready, needs approval (and how), or can't be sent (and why). */
export async function reviewLines(api: SendsApi, walletId: string, asset: string, lines: readonly SendLine[], onLine: (i: number, s: LineState) => void): Promise<LineState[]> {
  const states: LineState[] = lines.map(() => ({ kind: 'reviewing' }))
  const places = createLimiter(REVIEW_CONCURRENCY)
  await Promise.all(
    lines.map(async (line, i) => {
      const release = await places.acquire()
      try {
        states[i] = await reviewOne(api, line.from?.walletId ?? walletId, asset, line)
        onLine(i, states[i] as LineState)
      } finally {
        release()
      }
    }),
  )
  return states
}

/**
 * Follows one running send until it is done or failed; null when it isn't finished in time;
 * 'requoted' when the engine replaced it (what it reviewed changed, e.g. an earlier line created or
 * registered its destination): nothing was sent for it, and it needs a new review.
 */
async function follow(api: SendsApi, intentId: string, opts: { now: () => number; sleep: (ms: number) => Promise<void> }): Promise<LineState | 'requoted' | null> {
  const until = opts.now() + SEND_WAIT_MS
  while (opts.now() < until) {
    await opts.sleep(POLL_MS)
    const s = await api.sendStatus(intentId).catch(() => null)
    if (s?.status === 'requoted') return 'requoted'
    if (!s || !finished(s.status)) continue
    if (s.status === 'done') return { kind: 'sent', hashes: s.hashes }
    return {
      kind: 'failed',
      message: s.message ?? (s.status === 'expired' ? 'The send expired before it ran.' : s.status === 'cancelled' ? 'The send was cancelled.' : 'The send failed.'),
    }
  }
  return null
}

/**
 * Sends the reviewed lines, one after another. Every line must be ready: a batch with a line that
 * needs approval (or can't be sent) is never started. `shouldStop` is asked before each next line:
 * the send under way finishes, nothing after it starts. Withdrawals paused, or a send still running
 * past the wait, stop the batch the same way.
 */
export async function sendLines(
  api: SendsApi,
  walletId: string,
  asset: string,
  lines: readonly SendLine[],
  reviewed: readonly LineState[],
  onLine: (i: number, s: LineState) => void,
  opts: { now: () => number; sleep: (ms: number) => Promise<void>; shouldStop: () => boolean },
): Promise<LineState[]> {
  if (reviewed.length !== lines.length || reviewed.some((s) => s.kind !== 'ready')) throw new Error('Every line must be ready before the batch is sent')
  const states = [...reviewed]
  const set = (i: number, s: LineState) => {
    states[i] = s
    onLine(i, s)
  }
  let stopped = false
  for (const [i, line] of lines.entries()) {
    if (stopped || opts.shouldStop()) {
      stopped = true
      set(i, { kind: 'failed', message: NOT_SENT })
      continue
    }
    let current = states[i] as Extract<LineState, { kind: 'ready' }>
    set(i, { kind: 'sending' })
    if (current.expiresAt - opts.now() < REVIEW_MARGIN_MS) {
      const again = await reviewOne(api, line.from?.walletId ?? walletId, asset, line)
      if (again.kind !== 'ready') {
        set(i, { kind: 'failed', message: again.kind === 'approval' || again.kind === 'error' ? again.message : 'This send couldn’t be reviewed again.' })
        continue
      }
      current = again
    }
    // A send the engine re-quoted is reviewed again (same destination and amount) and sent, at most twice.
    for (let requotes = 0; ; requotes++) {
      try {
        await api.executeSend(current.intentId)
      } catch (e) {
        set(i, { kind: 'failed', message: messageOf(e) })
        if (e instanceof LinkRequestError && e.code === 'paused') stopped = true
        break
      }
      const end = await follow(api, current.intentId, opts)
      if (end === 'requoted' && requotes < 2) {
        const again = await reviewOne(api, line.from?.walletId ?? walletId, asset, line)
        if (again.kind !== 'ready') {
          set(i, { kind: 'failed', message: again.kind === 'approval' || again.kind === 'error' ? again.message : 'This send couldn’t be reviewed again.' })
          break
        }
        current = again
        continue
      }
      if (end && end !== 'requoted') set(i, end)
      else if (end === 'requoted') set(i, { kind: 'failed', message: 'Its review kept changing while it ran: nothing was sent. Review it again.' })
      else {
        set(i, { kind: 'failed', message: STILL_RUNNING })
        stopped = true
      }
      break
    }
  }
  return states
}
