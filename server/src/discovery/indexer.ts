import type { Logger } from '../log'
import { actionsOf, type TokenAction } from './accounting'
import { IntearError, type Intear } from './intear'
import { concentration, MIN_LAUNCHES } from './sources'
import { parentOf, type DiscoveryStore } from './store'

/**
 * The discovery indexer (DISCOVERY.md, Architecture): one loop, on one instance (a role lease), that
 *  - every minute reads the tokens created in the last week with their market figures (one request),
 *    records new ones and checks their parent accounts for a contract;
 *  - follows every swap on NEAR from the configured start (oldest first, 200 a page) into the wallet
 *    tables, each page with its cursor in one transaction;
 *  - reads the largest holders of recent launches with a market, a few at a time.
 * Everything is incremental and restartable; nothing is fetched because someone opened a page.
 */

/** Launch Radar lists launches from this far back. */
export const LAUNCH_WINDOW_MS = 7 * 86_400_000
/** Trades in tokens launched this recently are kept as rows (launch-to-wallet evidence). */
export const LAUNCH_TRADES_MS = 8 * 86_400_000
const PAGE = 200
const LAUNCHES_EVERY_MS = 60_000
const HOLDERS_EVERY_MS = 120_000
const HOLDERS_STALE_MS = 2 * 3_600_000
const HOLDERS_WINDOW_MS = 48 * 3_600_000
const HOLDERS_MIN_LIQUIDITY = 1_000
const HOLDERS_PER_STEP = 5
const HOLDERS_READ = 25
const PRUNE_EVERY_MS = 3_600_000
/** A swap this recent is "live" (alerts); older ones are history being caught up. */
export const LIVE_MS = 15 * 60_000
/** The trade index is stale when its newest swap is older than this. */
export const STALE_MS = 10 * 60_000

export interface TradeCursor {
  /** `after_millis` the current page chain started from. */
  after: number
  cursor: string | null
  lastId: number
}

export interface IndexerStatus {
  running: boolean
  indexStart: number
  /** The newest swap applied, and when. */
  tradesTo: number | null
  tradesAt: number | null
  backfilling: boolean
  launchesAt: number | null
  holdersAt: number | null
  error: string | null
}

export interface DiscoveryIndexer {
  start(): void
  stop(): Promise<void>
  status(): IndexerStatus
  /** One round of every step (tests, and the first round at start). */
  step(): Promise<number>
}

export function createDiscoveryIndexer(deps: {
  store: DiscoveryStore
  intear: Intear
  network: { id: string; wrapContract: string; stableTokens: readonly { contract: string }[] }
  /** Whether an account has a deployed contract (RPC view_account). */
  hasContract: (account: string) => Promise<boolean>
  lease: { hold(): Promise<boolean>; release(): Promise<void> }
  log: Logger
  now?: () => number
  /** Where the trade index starts (ms). */
  startAt: number
  /** Live swaps, after they are stored (alerts). */
  onLive?: (actions: readonly TokenAction[]) => Promise<void>
  sleep?: (ms: number) => Promise<void>
}): DiscoveryIndexer {
  const now = deps.now ?? Date.now
  const net = deps.network.id
  const currency = new Set([deps.network.wrapContract, ...deps.network.stableTokens.map((s) => s.contract)])
  const cursorKey = `disc_trades_cursor:${net}`
  // A pause that stop() cuts short (a 60 s back-off never holds up a shutdown).
  let wake: (() => void) | null = null
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = null
          resolve()
        }, ms)
        wake = () => {
          clearTimeout(timer)
          wake = null
          resolve()
        }
      }))
  const status: IndexerStatus = { running: false, indexStart: deps.startAt, tradesTo: null, tradesAt: null, backfilling: true, launchesAt: null, holdersAt: null, error: null }
  let launchSet = new Map<string, number>()
  let lastLaunches = 0
  let lastHolders = 0
  let lastPrune = 0
  let running = false
  let loop: Promise<void> | null = null

  async function readCursor(): Promise<TradeCursor> {
    const raw = await deps.store.getMeta(cursorKey)
    if (raw) {
      try {
        const c = JSON.parse(raw) as TradeCursor
        if (typeof c.after === 'number') return c
      } catch {
        // fall through: start again from the configured start
      }
    }
    return { after: deps.startAt, cursor: null, lastId: 0 }
  }

  async function stepLaunches(): Promise<void> {
    const t = now()
    const r = await deps.intear.launches({ createdAfter: t - LAUNCH_WINDOW_MS - 3_600_000, limit: 5_000 })
    const fresh = await deps.store.upsertTokens(net, r.tokens)
    await deps.store.countSources(net)
    // New parents: does each have a contract? (A few per round; a parent with too few tokens can wait.)
    const unchecked = (await deps.store.sources(net)).filter((s) => s.hasContract === null && s.launches >= MIN_LAUNCHES).slice(0, 5)
    for (const s of unchecked) await deps.store.setSourceContract(net, s.parent, await deps.hasContract(s.parent))
    launchSet = await deps.store.createdSince(net, t - LAUNCH_TRADES_MS)
    status.launchesAt = t
    if (fresh) deps.log.info('launch radar: new tokens', { count: fresh })
  }

  async function stepTrades(): Promise<number> {
    const c = await readCursor()
    const page = await deps.intear.trades({ order: 'oldest', afterMillis: c.after, cursor: c.cursor, limit: PAGE })
    const rows = page.rows.filter((r) => r.id > c.lastId)
    const last = rows.reduce<(typeof rows)[number] | null>((m, r) => (m === null || r.ts > m.ts || (r.ts === m.ts && r.id > m.id) ? r : m), null)
    const lastId = Math.max(c.lastId, ...page.rows.map((r) => r.id))
    const next: TradeCursor = page.nextCursor ? { after: c.after, cursor: page.nextCursor, lastId } : { after: last?.ts ?? c.after, cursor: null, lastId }
    const actions = actionsOf(rows, currency)
    await deps.store.applyPage(net, actions, { launches: launchSet, cursorKey, cursor: JSON.stringify(next) })
    const t = now()
    if (last) status.tradesTo = last.ts
    status.tradesAt = t
    status.backfilling = page.nextCursor !== null || (status.tradesTo !== null && t - status.tradesTo > LIVE_MS)
    const live = actions.filter((a) => t - a.ts <= LIVE_MS)
    if (live.length && deps.onLive) await deps.onLive(live).catch((e: unknown) => deps.log.warn('discovery alerts failed', { error: e }))
    return page.rows.length
  }

  async function stepHolders(): Promise<void> {
    const t = now()
    const due = (await deps.store.launches(net, t - HOLDERS_WINDOW_MS))
      .filter((x) => (x.market?.liquidityUsd ?? 0) >= HOLDERS_MIN_LIQUIDITY && (x.holdersAt === null || t - x.holdersAt > HOLDERS_STALE_MS))
      .sort((a, b) => (b.market?.liquidityUsd ?? 0) - (a.market?.liquidityUsd ?? 0))
      .slice(0, HOLDERS_PER_STEP)
    for (const x of due) {
      const h = await deps.intear.holders(x.token, HOLDERS_READ)
      await deps.store.setHolders(
        net,
        x.token,
        concentration(h.rows, x.market?.totalSupply ?? null, { token: x.token, parent: parentOf(x.token), dev: x.dev, total: h.total, listed: HOLDERS_READ }),
      )
    }
    status.holdersAt = t
  }

  async function step(): Promise<number> {
    const t = now()
    let n = 0
    if (t - lastLaunches >= LAUNCHES_EVERY_MS) {
      lastLaunches = t
      await stepLaunches()
    }
    n = await stepTrades()
    if (t - lastHolders >= HOLDERS_EVERY_MS) {
      lastHolders = t
      await stepHolders()
    }
    if (t - lastPrune >= PRUNE_EVERY_MS) {
      lastPrune = t
      await deps.store.prune(net)
    }
    status.error = null
    return n
  }

  async function run(): Promise<void> {
    while (running) {
      let pause = 5_000
      try {
        if (!(await deps.lease.hold())) {
          pause = 30_000
        } else {
          const n = await step()
          // Catching up: the next page at once (with Intear's own spacing); at the head: every few seconds.
          pause = n >= PAGE ? 300 : 5_000
        }
      } catch (e) {
        status.error = e instanceof Error ? e.message : String(e)
        pause = e instanceof IntearError && e.rateLimited ? 60_000 : 15_000
        deps.log.warn('discovery indexer step failed', { error: status.error })
      }
      if (running) await sleep(pause)
    }
  }

  return {
    start() {
      if (running) return
      running = true
      status.running = true
      void readCursor().then((c) => {
        status.backfilling = c.cursor !== null || now() - c.after > LIVE_MS
      })
      loop = run()
    },
    async stop() {
      running = false
      status.running = false
      wake?.()
      await loop?.catch(() => undefined)
      await deps.lease.release().catch(() => undefined)
    },
    status: () => ({ ...status }),
    step,
  }
}
