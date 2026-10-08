import { KIT_LAUNCHPAD, KITS_CONTRACT } from '@/config/kit'
import type { NetworkConfig } from '@/config/networks'
import { fromFastnear, isComplete, type NormalizedTx } from '@/services/near/flows'
import type { RpcClient } from '@/services/near/rpc'
import type { KitsHolderPayout, KitsRewardsView } from '@/services/kitsRewards'
import type { Logger } from '../log'

/**
 * $KITS' holder rewards, read from NEAR mainnet the way Nearly accounts them, and checked.
 *
 * How it works on chain (read from the launchpad and its transactions, 2026-10-08): the holders' share
 * of the trading tax is sold for the launch's quote asset (NEAR for $KITS, whose pool is KITS/wNEAR) and
 * credited to the launch's holder bucket. Nearly's launchpad, nearlytrade.near, then pays it out in
 * batches it signs itself: `pay_tax_holders({ launch_id, payouts: [[account, amount], ...] })`, one
 * native NEAR transfer per holder (an `on_paid` callback, bucket "tax_holders"), and one
 * `tax_holders_paid { id, amount }` event (nearpad standard) for the batch.
 *
 * What is served, from where:
 * - totals from chain state: the launchpad's `get_tax({ launch_id })`: `paid_holders` (NEAR paid out,
 *   all time) and `holders_bucket` (NEAR allocated to holders and not paid yet). Allocated in all is
 *   their sum. Nothing here calls a bucket amount "paid".
 * - the payouts themselves: NearBlocks lists the launchpad's `pay_tax_holders` calls (every Nearly launch
 *   shares the method, so only this launch's are kept), and each one is checked on its transaction
 *   (FastNEAR): signed by the launchpad, for this launch, its `tax_holders_paid` event emitted by the
 *   launchpad in a receipt that succeeded, of exactly the sum of the payouts it lists. The verified
 *   payouts must add up to `paid_holders` for the history to count as complete.
 * - Scanning every launch's payouts is a lot of calls, so how far it got is kept (the `meta` table): a
 *   restart goes on from there. The first pass walks back to the launch a few pages at a time.
 */

const DIGITS = /^\d{1,40}$/
const HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/
/** Payouts served, newest first. */
export const MAX_PAYOUTS = 50
const PAGE = 25
/**
 * NearBlocks pages read per step, and the wait after it says to slow down: its free API is shared with
 * the burn tracker, so the first pass back to the launch is spread over many steps (see warm()).
 */
const PAGES_PER_STEP = 2
const SLOW_DOWN_MS = 60_000

/** One `pay_tax_holders` call as NearBlocks lists it. */
export interface PayoutCandidate {
  tx: string
  at: number
  /** The launch id its arguments name, when NearBlocks gave them whole; null: read it from the transaction. */
  launchId: string | null
}

/** NearBlocks' list of the launchpad's `pay_tax_holders` calls (successful ones), with the next cursor. */
export function nearblocksPayouts(json: unknown, launchpad: string): { list: PayoutCandidate[]; cursor: string | null } {
  const j = (json ?? {}) as { txns?: unknown; cursor?: unknown }
  if (!Array.isArray(j.txns)) throw new Error('NearBlocks answered without a transaction list')
  const list: PayoutCandidate[] = []
  for (const raw of j.txns) {
    const t = (raw ?? {}) as {
      transaction_hash?: unknown
      receiver_account_id?: unknown
      predecessor_account_id?: unknown
      outcomes?: { status?: unknown }
      actions?: { method?: unknown; args?: unknown }[]
      receipt_block?: { block_timestamp?: unknown }
      block_timestamp?: unknown
    }
    if (typeof t.transaction_hash !== 'string' || !HASH.test(t.transaction_hash)) continue
    const ns = t.receipt_block?.block_timestamp ?? t.block_timestamp
    const at = typeof ns === 'string' && /^\d+$/.test(ns) ? Number(BigInt(ns) / 1_000_000n) : typeof ns === 'number' && Number.isFinite(ns) ? Math.floor(ns / 1e6) : 0
    if (at <= 0) continue
    // A failed call paid nothing; one on another contract isn't the launchpad's.
    if (t.receiver_account_id !== launchpad || t.outcomes?.status !== true) {
      list.push({ tx: t.transaction_hash, at, launchId: 'none' })
      continue
    }
    const call = Array.isArray(t.actions) ? t.actions.find((a) => a?.method === 'pay_tax_holders') : undefined
    let launchId: string | null = null
    if (call && typeof call.args === 'string') {
      try {
        const id = (JSON.parse(call.args) as { launch_id?: unknown }).launch_id
        if (typeof id === 'string' || typeof id === 'number') launchId = String(id)
      } catch {
        // cut short: read it from the transaction itself
      }
    }
    list.push({ tx: t.transaction_hash, at, launchId: call ? launchId : 'none' })
  }
  const cursor = typeof j.cursor === 'string' || typeof j.cursor === 'number' ? String(j.cursor) : null
  return { list, cursor }
}

/** The `pay_tax_holders` call of a FastNEAR transaction record, its arguments decoded. */
function payCall(raw: unknown): { launchId: string; payouts: [string, string][] } | null {
  const actions = (raw as { transaction?: { actions?: unknown[] } })?.transaction?.actions
  if (!Array.isArray(actions)) return null
  for (const a of actions) {
    const fc = (a as { FunctionCall?: { method_name?: unknown; args?: unknown } })?.FunctionCall
    if (fc?.method_name !== 'pay_tax_holders' || typeof fc.args !== 'string') continue
    try {
      const args = JSON.parse(Buffer.from(fc.args, 'base64').toString('utf8')) as { launch_id?: unknown; payouts?: unknown }
      if ((typeof args.launch_id !== 'string' && typeof args.launch_id !== 'number') || !Array.isArray(args.payouts)) return null
      const payouts = args.payouts.filter(
        (p): p is [string, string] => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'string' && DIGITS.test(p[1]),
      )
      if (payouts.length !== args.payouts.length) return null
      return { launchId: String(args.launch_id), payouts }
    } catch {
      return null
    }
  }
  return null
}

const events = (tx: NormalizedTx, executor: string) =>
  tx.receipts
    .filter((r) => r.executorId === executor && r.success)
    .flatMap((r) => r.logs)
    .flatMap((line) => {
      if (!line.startsWith('EVENT_JSON:')) return []
      try {
        return [JSON.parse(line.slice('EVENT_JSON:'.length)) as { standard?: unknown; event?: unknown; data?: unknown }]
      } catch {
        return []
      }
    })

/**
 * A payout, checked on its transaction: the launchpad signed it, for this launch, and its own
 * `tax_holders_paid` event (in a receipt that succeeded) is exactly the sum of the payouts it lists.
 * Null: not this launch's, or not proven, so not served.
 */
export function verifyPayout(raw: unknown, tx: NormalizedTx, c: Pick<PayoutCandidate, 'tx' | 'at'>, ids: { launchpad: string; launchId: string }): KitsHolderPayout | null {
  if (tx.hash !== c.tx || !isComplete(tx) || tx.signerId !== ids.launchpad || tx.receiverId !== ids.launchpad) return null
  const call = payCall(raw)
  if (!call || call.launchId !== ids.launchId || !call.payouts.length) return null
  const listed = call.payouts.reduce((s, p) => s + BigInt(p[1]), 0n)
  const paid = events(tx, ids.launchpad)
    .filter((e) => e.standard === 'nearpad' && e.event === 'tax_holders_paid' && Array.isArray(e.data))
    .flatMap((e) => e.data as Record<string, unknown>[])
    .filter((d) => d && String(d.id) === ids.launchId && typeof d.amount === 'string' && DIGITS.test(d.amount))
  if (paid.length !== 1 || BigInt(paid[0]?.amount as string) !== listed || listed === 0n) return null
  return { tx: c.tx, at: c.at, amount: listed.toString(), payments: call.payouts.length }
}

/** How far the scan of the launchpad's payouts got: kept between restarts. */
export interface RewardsScan {
  v: 1
  launchId: string
  /** Every payout call up to this time (ms) has been looked at, back to the launch. */
  scannedTo: number
  /** A pass under way from the newest call back to `scannedTo`: where to go on. */
  pass: { cursor: string | null; newest: number | null } | null
  /** Verified payouts of this launch, newest first. */
  payouts: KitsHolderPayout[]
}

export interface KitsRewardsTrackerDeps {
  rpc: Pick<RpcClient, 'viewFunction'>
  fetch: typeof fetch
  network: Pick<NetworkConfig, 'id' | 'kitsContract' | 'discovery' | 'wrapContract'>
  /** Where the scan's progress is kept (the server's `meta` table). */
  kv: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> }
  now?: () => number
  log?: Pick<Logger, 'warn' | 'info'>
  stateTtlMs?: number
  historyTtlMs?: number
}

interface ChainState {
  launchId: string
  createdAt: number
  paid: string
  waiting: string
  holdersBps: number
  readAt: number
}

const digits = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !DIGITS.test(v)) throw new Error(`${what} is not a whole number`)
  return v
}

export function createKitsRewardsTracker(deps: KitsRewardsTrackerDeps) {
  const { rpc, network } = deps
  if (network.id !== 'mainnet' || network.kitsContract !== KITS_CONTRACT) throw new Error(`$KITS holder rewards are read on NEAR mainnet, for ${KITS_CONTRACT} only`)
  const token = KITS_CONTRACT
  const launchpad = KIT_LAUNCHPAD
  const now = deps.now ?? Date.now
  const stateTtl = deps.stateTtlMs ?? 60_000
  const historyTtl = deps.historyTtlMs ?? 180_000
  const nearblocks = network.discovery.nearblocksUrl
  const fastnear = network.discovery.fastnearTxUrl

  let state: ChainState | null = null
  let scan: RewardsScan | null = null
  let historyAt: number | null = null
  let last: KitsRewardsView | null = null
  let inflight: Promise<KitsRewardsView> | null = null
  /** The history step running in the background, if one is. */
  let stepping: Promise<void> | null = null
  let slowUntil = 0
  const kvKey = (launchId: string) => `kits_holder_payouts:${network.id}:${launchId}`

  /** Chain state, validated: the launchpad is the token's tax admin, the launch is this token's, its holders are paid in NEAR. */
  async function readState(): Promise<ChainState> {
    const [tax, launch] = await Promise.all([
      rpc.viewFunction<{ tax?: { admin?: unknown } }>(token, 'get_tax', {}, 'final'),
      rpc.viewFunction<{ id?: unknown; token?: unknown; quote?: unknown; created_at_ms?: unknown }>(launchpad, 'get_launch_by_token', { token }, 'final'),
    ])
    if (tax?.tax?.admin !== launchpad) throw new Error(`${launchpad} is not ${token}'s tax admin`)
    if (!launch || launch.token !== token || (typeof launch.id !== 'number' && typeof launch.id !== 'string') || !/^\d+$/.test(String(launch.id)))
      throw new Error(`${launchpad} has no launch for ${token}`)
    // Holders are paid in the launch's quote asset: NEAR (wNEAR's pool) is what the figures are counted in.
    if (launch.quote !== network.wrapContract) throw new Error(`${token}'s holders aren't paid in NEAR`)
    const createdAt = typeof launch.created_at_ms === 'number' && Number.isFinite(launch.created_at_ms) ? launch.created_at_ms : null
    if (createdAt === null) throw new Error('the launch has no creation time')
    const launchId = String(launch.id)
    const accounts = await rpc.viewFunction<{ paid_holders?: unknown; holders_bucket?: unknown; holders_bps?: unknown }>(launchpad, 'get_tax', { launch_id: launchId }, 'final')
    const holdersBps = accounts?.holders_bps
    if (typeof holdersBps !== 'number' || !Number.isInteger(holdersBps) || holdersBps < 0 || holdersBps > 10_000) throw new Error('the holders share is not a share')
    return {
      launchId,
      createdAt,
      paid: digits(accounts?.paid_holders, 'the NEAR paid to holders'),
      waiting: digits(accounts?.holders_bucket, 'the holder bucket'),
      holdersBps,
      readAt: now(),
    }
  }

  async function loadScan(s: ChainState): Promise<RewardsScan> {
    if (scan?.launchId === s.launchId) return scan
    const fresh: RewardsScan = { v: 1, launchId: s.launchId, scannedTo: s.createdAt - 60_000, pass: null, payouts: [] }
    try {
      const raw = await deps.kv.get(kvKey(s.launchId))
      const saved = raw ? (JSON.parse(raw) as RewardsScan) : null
      if (
        saved?.v === 1 &&
        saved.launchId === s.launchId &&
        typeof saved.scannedTo === 'number' &&
        Array.isArray(saved.payouts) &&
        saved.payouts.every((p) => HASH.test(p.tx) && DIGITS.test(p.amount) && Number.isInteger(p.payments) && p.at > 0)
      )
        return (scan = saved)
    } catch {
      // nothing usable kept: start from the launch
    }
    return (scan = fresh)
  }

  /** The verified payouts among these calls (read on FastNEAR, 20 at a time); calls not served yet stay for next time. */
  async function verify(cands: readonly PayoutCandidate[], launchId: string): Promise<{ payouts: KitsHolderPayout[]; pending: boolean }> {
    const out: KitsHolderPayout[] = []
    let pending = false
    for (let i = 0; i < cands.length; i += 20) {
      const batch = cands.slice(i, i + 20)
      const res = await deps.fetch(`${fastnear}/v0/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tx_hashes: batch.map((c) => c.tx) }),
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) throw new Error(`FastNEAR answered ${res.status}`)
      const body = (await res.json()) as { transactions?: unknown[] }
      const records = new Map<string, { raw: unknown; tx: NormalizedTx }>()
      for (const raw of body.transactions ?? []) {
        try {
          const tx = fromFastnear(raw)
          records.set(tx.hash, { raw, tx })
        } catch {
          // a record this can't read
        }
      }
      for (const c of batch) {
        const r = records.get(c.tx)
        if (!r || !isComplete(r.tx)) {
          pending = true
          continue
        }
        const p = verifyPayout(r.raw, r.tx, c, { launchpad, launchId })
        if (p) out.push(p)
      }
    }
    return { payouts: out, pending }
  }

  /**
   * One step of the scan: from the newest payout call back to where the last pass ended, a few pages
   * at a time; a pass that runs out of pages goes on from its cursor next time.
   */
  async function step(s: ChainState, sc: RewardsScan): Promise<boolean> {
    const pass = sc.pass ?? { cursor: null, newest: null }
    let done = false
    const found: PayoutCandidate[] = []
    for (let page = 0; page < PAGES_PER_STEP && !done; page++) {
      const url = `${nearblocks}/v1/account/${launchpad}/txns?method=pay_tax_holders&per_page=${PAGE}&order=desc${pass.cursor ? `&cursor=${encodeURIComponent(pass.cursor)}` : ''}`
      const res = await deps.fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
      if (res.status === 429) {
        slowUntil = now() + SLOW_DOWN_MS
        break
      }
      if (!res.ok) throw new Error(`NearBlocks answered ${res.status}`)
      const { list, cursor } = nearblocksPayouts(await res.json(), launchpad)
      for (const c of list) {
        if (c.at <= sc.scannedTo) {
          done = true
          break
        }
        pass.newest = Math.max(pass.newest ?? 0, c.at)
        // Another launch's payout (its arguments say so) isn't fetched at all.
        if (c.launchId === null || c.launchId === s.launchId) found.push(c)
      }
      pass.cursor = cursor
      if (!cursor || list.length === 0) done = true
    }
    const { payouts, pending } = await verify(found, s.launchId)
    const known = new Set(sc.payouts.map((p) => p.tx))
    for (const p of payouts) if (!known.has(p.tx)) sc.payouts.push(p)
    sc.payouts.sort((a, b) => b.at - a.at)
    // A payout not readable on FastNEAR yet is asked again by the next pass: this one doesn't close over it.
    if (done && !pending) {
      sc.scannedTo = Math.max(sc.scannedTo, pass.newest ?? sc.scannedTo)
      sc.pass = null
    } else sc.pass = done ? null : pass
    await deps.kv.set(kvKey(s.launchId), JSON.stringify(sc))
    return done && !pending
  }

  /** Starts the next history step in the background when one is due (one at a time). */
  function maybeStep(s: ChainState, sc: RewardsScan) {
    const t = now()
    if (stepping || t < slowUntil) return
    // Until the first pass reached the launch, a step every time; afterwards at the history interval.
    const behind = sc.pass !== null || sc.scannedTo < s.createdAt
    if (!behind && historyAt !== null && t - historyAt < historyTtl) return
    stepping = step(s, sc)
      .then(() => {
        historyAt = now()
      })
      .catch((e: unknown) => {
        deps.log?.warn('kits rewards: payout history not read', { error: e instanceof Error ? e.message : String(e) })
      })
      .finally(() => {
        stepping = null
      })
  }

  async function refresh(): Promise<KitsRewardsView> {
    const t = now()
    if (!state || t - state.readAt >= stateTtl) state = await readState()
    const s = state
    const sc = await loadScan(s)
    maybeStep(s, sc)
    const verifiedSum = sc.payouts.reduce((sum, p) => sum + BigInt(p.amount), 0n)
    return {
      network: 'mainnet',
      token,
      launchpad,
      launchId: s.launchId,
      asset: 'near',
      decimals: 24,
      holdersBps: s.holdersBps,
      paid: s.paid,
      waiting: s.waiting,
      allocated: (BigInt(s.paid) + BigInt(s.waiting)).toString(),
      payouts: sc.payouts.slice(0, MAX_PAYOUTS),
      payoutCount: sc.payouts.length,
      paymentCount: sc.payouts.reduce((n, p) => n + p.payments, 0),
      historyComplete: sc.pass === null && sc.scannedTo >= s.createdAt && verifiedSum === BigInt(s.paid),
      readAt: s.readAt,
      historyReadAt: historyAt,
    }
  }

  return {
    /** Resolves once the history step under way (if any) has finished (tests, and the warm-up). */
    async settle(): Promise<void> {
      await stepping
    },
    /** The latest reading: read again once its interval has passed (one read at a time); the last good one while the chain doesn't answer. */
    async view(): Promise<KitsRewardsView> {
      inflight ??= refresh()
        .then((v) => (last = v))
        .catch((e: unknown) => {
          if (last) {
            deps.log?.warn('kits rewards: chain not read, serving the last reading', { error: e instanceof Error ? e.message : String(e) })
            return last
          }
          throw e
        })
        .finally(() => {
          inflight = null
        })
      return inflight
    },
  }
}

export type KitsRewardsTracker = ReturnType<typeof createKitsRewardsTracker>
