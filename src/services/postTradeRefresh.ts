import { NATIVE_TOKEN_ID } from '@/config/networks'
import type { Holding } from '@/types/domain'
import type { OperationPlan, OperationProgress } from '@/types/operations'

/**
 * Balances after a trade, without a page reload. The trade is confirmed on chain before
 * the result shows; the balances readers (RPC, the token indexer) can still answer with
 * the old picture for a few seconds. So after a confirmed operation NearKit refreshes the
 * affected accounts in the background on a bounded schedule, and stops as soon as the
 * traded tokens' balances differ from what they were before (or after the last try).
 * The confirmation never waits for this: the UI says "Updating balances…" meanwhile.
 */

/** When to ask again, from the moment the operation settled: five tries over about half a minute. */
export const REFRESH_DELAYS_MS: readonly number[] = [0, 1_500, 4_000, 8_000, 15_000]

export interface RefreshTargets {
  accounts: string[]
  tokens: string[]
}

/** The accounts and tokens a plan changes. */
export function refreshTargets(plan: Pick<OperationPlan, 'signers' | 'lines' | 'swap' | 'token'>): RefreshTargets {
  const accounts = [...new Set([...plan.signers, ...plan.lines.map((l) => l.accountId)])]
  const tokens = plan.swap ? [plan.swap.tokenIn.id, plan.swap.tokenOut.id] : [plan.token.id]
  // Paying NEAR for gas moves NEAR on every operation; a token trade is judged by its tokens.
  return { accounts, tokens: [...new Set(tokens.length ? tokens : [NATIVE_TOKEN_ID])] }
}

/** Raw balance per `account|token`, from the holdings the app already shows. */
export type BalanceSnapshot = ReadonlyMap<string, string>

export function snapshotOf(holdings: readonly Holding[] | undefined, targets: RefreshTargets): BalanceSnapshot {
  const out = new Map<string, string>()
  for (const h of holdings ?? []) if (targets.accounts.includes(h.walletId) && targets.tokens.includes(h.tokenId)) out.set(`${h.walletId}|${h.tokenId}`, h.raw ?? String(h.amount))
  return out
}

/** True when any traded token's balance on any affected account is not what it was (appeared, moved or went to zero). */
export function balancesMoved(before: BalanceSnapshot, after: BalanceSnapshot): boolean {
  for (const [k, v] of after) if (before.get(k) !== v) return true
  for (const k of before.keys()) if (!after.has(k)) return true
  return false
}

/** Worth refreshing for: something may have changed on chain. */
export const settledWithChanges = (p: Pick<OperationProgress, 'phase'> | null) => p !== null && (p.phase === 'success' || p.phase === 'partial')

export type RefreshOutcome = 'updated' | 'unchanged' | 'cancelled'

/**
 * Refreshes on `delays` until `read` shows the balances moved from `before`. Each try
 * refreshes first (invalidate caches, refetch), then reads. Bounded: it never runs
 * past the last delay, and a newer refresh cancels an older one.
 */
export async function refreshUntilMoved(o: {
  before: BalanceSnapshot
  refresh: () => Promise<void>
  read: () => BalanceSnapshot
  delays?: readonly number[]
  sleep?: (ms: number) => Promise<void>
  cancelled?: () => boolean
}): Promise<RefreshOutcome> {
  const delays = o.delays ?? REFRESH_DELAYS_MS
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let waited = 0
  for (const at of delays) {
    if (at > waited) await sleep(at - waited)
    waited = at
    if (o.cancelled?.()) return 'cancelled'
    try {
      await o.refresh()
    } catch {
      // A failed refresh is just another try; the next one may work.
      continue
    }
    if (balancesMoved(o.before, o.read())) return 'updated'
  }
  return 'unchanged'
}

// ─── status for the UI ──────────────────────────────────────────────────────

export type RefreshStatus = { state: 'idle' } | { state: 'updating'; since: number } | { state: 'updated'; at: number } | { state: 'stale'; at: number }

/** A tiny store the top bar and the operation dialog read ("Updating balances…"). */
export function createRefreshStatus(now: () => number = Date.now) {
  let status: RefreshStatus = { state: 'idle' }
  let run = 0
  const listeners = new Set<() => void>()
  const set = (s: RefreshStatus) => {
    status = s
    for (const l of listeners) l()
  }
  return {
    get: () => status,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    /** Starts a refresh run; the previous one (if any) stops at its next try. */
    async track(work: (cancelled: () => boolean) => Promise<RefreshOutcome>): Promise<RefreshOutcome> {
      const mine = ++run
      set({ state: 'updating', since: now() })
      const outcome = await work(() => run !== mine)
      if (run === mine) set(outcome === 'updated' ? { state: 'updated', at: now() } : { state: 'stale', at: now() })
      return outcome
    },
    clear: () => set({ state: 'idle' }),
  }
}

export type RefreshStatusStore = ReturnType<typeof createRefreshStatus>
