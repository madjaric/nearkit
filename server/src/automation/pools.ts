import type { NetworkConfig } from '@/config/networks'
import { isUniqueViolation, type Database, type SqlValue } from '../db/database'
import type { Logger } from '../log'

/**
 * Sniper's discovery: new liquidity pools, read from the exchanges themselves. Both of NEARKITS'
 * exchanges keep an append-only pool list with a counter (verified on mainnet 2026-10-14):
 *
 * - Ref DCL (`dclv2.ref-labs.near`): `get_metadata().pool_count` (a string) and `list_pools {from_index,
 *   limit}` in insertion order; a pool's id names its tokens (`tokenX|tokenY|fee`). Every Nearly launch
 *   creates its DCL pool in its own launch transaction (a `*.nearlytrade.near` token against wNEAR).
 * - Ref v2 (`v2.ref-finance.near`): `get_number_of_pools()` and `get_pools {from_index, limit}`; a pool's
 *   id is its index. meme.cooking graduations add their pool here (a `*.meme-cooking.near` token).
 *
 * The feed reads each counter every few seconds, records every new pool once (unique per source and
 * pool id) and only then moves its cursor, so a restart replays one batch at most. A new pool is
 * usually empty: pools paired with wNEAR are watched until they hold NEAR liquidity (and, for a Nearly
 * launch, until Nearly says the launch is done), then 'ready'; dropped after WATCH_MAX_MS. The feed
 * starts at the counters' current values: pools made before it ran (or while it was idle for long)
 * are never reported as new. No index, no paid API, no event stream: two view calls per scan.
 */

export type PoolSource = 'dcl' | 'ref'
export type PoolStatus = 'watching' | 'ready' | 'dropped' | 'unpaired'
export type Launchpad = 'nearly' | 'meme-cooking'

export interface NewPool {
  id: number
  network: string
  source: PoolSource
  poolId: string
  /** The token paired with wNEAR; null for a pool without wNEAR. */
  token: string | null
  launchpad: Launchpad | null
  status: PoolStatus
  /** The pool's NEAR side (raw yocto) when last read. */
  nearRaw: string | null
  firstSeenAt: number
  checkedAt: number | null
  readyAt: number | null
  detail: Record<string, unknown>
}

type PoolRow = {
  id: number
  network: string
  source: string
  pool_id: string
  token: string | null
  launchpad: string | null
  status: string
  near_raw: string | null
  first_seen_at: number
  checked_at: number | null
  ready_at: number | null
  detail: string | null
}

const toPool = (r: PoolRow): NewPool => ({
  id: Number(r.id),
  network: r.network,
  source: r.source as PoolSource,
  poolId: r.pool_id,
  token: r.token,
  launchpad: r.launchpad as Launchpad | null,
  status: r.status as PoolStatus,
  nearRaw: r.near_raw,
  firstSeenAt: Number(r.first_seen_at),
  checkedAt: r.checked_at === null ? null : Number(r.checked_at),
  readyAt: r.ready_at === null ? null : Number(r.ready_at),
  detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : {},
})

export class PoolStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  async cursor(network: string, source: PoolSource): Promise<{ nextIndex: number; guard: string | null; updatedAt: number } | null> {
    const r = await this.db.get<{ next_index: number; guard: string | null; updated_at: number }>(
      'SELECT next_index, guard, updated_at FROM auto_feed_cursors WHERE network = ? AND source = ?',
      [network, source],
    )
    return r ? { nextIndex: Number(r.next_index), guard: r.guard, updatedAt: Number(r.updated_at) } : null
  }

  async setCursor(network: string, source: PoolSource, nextIndex: number, guard: string | null): Promise<void> {
    await this.db.run(
      `INSERT INTO auto_feed_cursors (network, source, next_index, guard, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (network, source) DO UPDATE SET next_index = excluded.next_index, guard = excluded.guard, updated_at = excluded.updated_at`,
      [network, source, nextIndex, guard, this.now()],
    )
  }

  /** A pool seen for the first time; false when it was recorded already (a replayed batch). */
  async add(p: { network: string; source: PoolSource; poolId: string; token: string | null; launchpad: Launchpad | null; detail: Record<string, unknown> }): Promise<boolean> {
    try {
      await this.db.attempt(() =>
        this.db.run('INSERT INTO auto_pools (network, source, pool_id, token, launchpad, status, first_seen_at, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
          p.network,
          p.source,
          p.poolId,
          p.token,
          p.launchpad,
          p.token ? 'watching' : 'unpaired',
          this.now(),
          JSON.stringify(p.detail),
        ]),
      )
      return true
    } catch (err) {
      if (isUniqueViolation(err)) return false
      throw err
    }
  }

  /** Pools still waiting for liquidity, the ones looked at longest ago first. */
  async watching(network: string, limit: number): Promise<NewPool[]> {
    return (await this.db.all<PoolRow>(`SELECT * FROM auto_pools WHERE network = ? AND status = 'watching' ORDER BY COALESCE(checked_at, 0), id LIMIT ?`, [network, limit])).map(
      toPool,
    )
  }

  /** A watched pool's new reading (compare-and-set on 'watching'). */
  async update(id: number, patch: { status: PoolStatus; nearRaw: string | null; detail: Record<string, unknown>; ready?: boolean }): Promise<boolean> {
    const t = this.now()
    const sets = ['status = ?', 'near_raw = ?', 'detail = ?', 'checked_at = ?']
    const args: SqlValue[] = [patch.status, patch.nearRaw, JSON.stringify(patch.detail), t]
    if (patch.ready) {
      sets.push('ready_at = ?')
      args.push(t)
    }
    return (await this.db.run(`UPDATE auto_pools SET ${sets.join(', ')} WHERE id = ? AND status = 'watching'`, [...args, id])) === 1
  }

  /** Ready pools first seen at or after `seenSince`, ready at or after `readyFrom`, oldest ready first. */
  async readySince(network: string, seenSince: number, readyFrom: number, limit: number): Promise<NewPool[]> {
    return (
      await this.db.all<PoolRow>(`SELECT * FROM auto_pools WHERE network = ? AND status = 'ready' AND first_seen_at >= ? AND ready_at >= ? ORDER BY ready_at, id LIMIT ?`, [
        network,
        seenSince,
        readyFrom,
        limit,
      ])
    ).map(toPool)
  }

  async get(network: string, source: PoolSource, poolId: string): Promise<NewPool | null> {
    const r = await this.db.get<PoolRow>('SELECT * FROM auto_pools WHERE network = ? AND source = ? AND pool_id = ?', [network, source, poolId])
    return r ? toPool(r) : null
  }

  /** Pools are kept a week (new is new for minutes; the rest is history). */
  async prune(): Promise<void> {
    await this.db.run('DELETE FROM auto_pools WHERE first_seen_at < ?', [this.now() - 7 * 86_400_000])
  }
}

/** How often each counter is read, and the watched pools looked at again. */
export const DCL_SCAN_MS = 3_000
export const REF_SCAN_MS = 5_000
export const WATCH_MS = 4_000
/** A new pool without NEAR liquidity after this long is dropped. */
export const WATCH_MAX_MS = 30 * 60_000
/** Cursors not moved for this long (the feed off, the server down): set to the counters again, the gap not reported as new. */
export const IDLE_RESET_MS = 10 * 60_000
const PAGE = 200
const WATCH_PER_STEP = 12
/** A cursor that hasn't moved is touched this often (so a running feed never looks idle). */
const TOUCH_MS = 60_000

export interface PoolFeedDeps {
  store: PoolStore
  /** A contract's view method (NEAR RPC, final): its JSON, or null. */
  view: (contract: string, method: string, args: Record<string, unknown>) => Promise<unknown>
  network: NetworkConfig
  /** Nearly's launch factory on this network (nearlytrade.near on mainnet), or null. */
  nearly: string | null
  log: Logger
  now: () => number
  /** A token whose pool just became ready: snipers on that token look again at once. */
  onReady?: (token: string) => Promise<void>
}

const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const big = (v: unknown): bigint | null => (typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null)

export function createPoolFeed(deps: PoolFeedDeps) {
  const { store, view, network, log, now } = deps
  const wrap = network.wrapContract
  const dcl = network.dex.dcl.contract
  const ref = network.rhea.classic.exchange
  const last: Record<'dcl' | 'ref' | 'watch', number> = { dcl: Number.NEGATIVE_INFINITY, ref: Number.NEGATIVE_INFINITY, watch: Number.NEGATIVE_INFINITY }

  const launchpadOf = (source: PoolSource, token: string | null): Launchpad | null =>
    !token
      ? null
      : source === 'dcl' && deps.nearly && token.endsWith(`.${deps.nearly}`)
        ? 'nearly'
        : source === 'ref' && token.endsWith('.meme-cooking.near')
          ? 'meme-cooking'
          : null

  /** The token paired with wNEAR in a two-token pool, or null. */
  const pairedToken = (tokens: readonly string[]): string | null =>
    tokens.length === 2 && tokens.includes(wrap) && tokens[0] !== tokens[1] ? ((tokens.find((t) => t !== wrap) as string) ?? null) : null

  async function dclList(from: number, limit: number): Promise<Record<string, unknown>[]> {
    const r = await view(dcl, 'list_pools', { from_index: from, limit })
    return Array.isArray(r) ? r.filter(obj) : []
  }

  /** Ref DCL: its pool count, then the pools after the cursor (the pool before it checked to be where it was). */
  async function scanDcl(): Promise<void> {
    const meta = await view(dcl, 'get_metadata', {})
    const count = obj(meta) ? Number(meta.pool_count) : Number.NaN
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('DCL pool count unreadable')
    const cur = await store.cursor(network.id, 'dcl')
    const anchor = async () => {
      const at = count > 0 ? ((await dclList(count - 1, 1))[0]?.pool_id ?? null) : null
      await store.setCursor(network.id, 'dcl', count, typeof at === 'string' ? at : null)
    }
    if (!cur || now() - cur.updatedAt > IDLE_RESET_MS) return anchor()
    if (count < cur.nextIndex) {
      log.warn('pool feed: the DCL pool count went down; anchored again (pools in the gap are not reported)', { count, cursor: cur.nextIndex })
      return anchor()
    }
    if (count === cur.nextIndex) {
      if (now() - cur.updatedAt > TOUCH_MS) await store.setCursor(network.id, 'dcl', cur.nextIndex, cur.guard)
      return
    }
    if (cur.guard && cur.nextIndex > 0) {
      const before = (await dclList(cur.nextIndex - 1, 1))[0]?.pool_id
      if (before !== cur.guard) {
        log.warn('pool feed: the DCL pool list changed order; anchored again (pools in the gap are not reported)', { cursor: cur.nextIndex })
        return anchor()
      }
    }
    const pools = await dclList(cur.nextIndex, Math.min(count - cur.nextIndex, PAGE))
    let guard = cur.guard
    for (const p of pools) {
      const id = typeof p.pool_id === 'string' ? p.pool_id : null
      if (!id) continue
      const token = pairedToken([p.token_x, p.token_y].filter((t): t is string => typeof t === 'string'))
      await store.add({ network: network.id, source: 'dcl', poolId: id, token, launchpad: launchpadOf('dcl', token), detail: { fee: typeof p.fee === 'number' ? p.fee : null } })
      guard = id
    }
    await store.setCursor(network.id, 'dcl', cur.nextIndex + pools.length, guard)
  }

  /** Ref v2: its pool count, then the pools after the cursor (a pool's id is its index; the list only grows). */
  async function scanRef(): Promise<void> {
    const raw = await view(ref, 'get_number_of_pools', {})
    const count = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Ref pool count unreadable')
    const cur = await store.cursor(network.id, 'ref')
    if (!cur || now() - cur.updatedAt > IDLE_RESET_MS || count < cur.nextIndex) return store.setCursor(network.id, 'ref', count, null)
    if (count === cur.nextIndex) {
      if (now() - cur.updatedAt > TOUCH_MS) await store.setCursor(network.id, 'ref', cur.nextIndex, null)
      return
    }
    const r = await view(ref, 'get_pools', { from_index: cur.nextIndex, limit: Math.min(count - cur.nextIndex, PAGE) })
    const pools = Array.isArray(r) ? r : []
    for (const [i, p] of pools.entries()) {
      const tokens = obj(p) && Array.isArray(p.token_account_ids) ? p.token_account_ids.filter((t): t is string => typeof t === 'string') : []
      const token = pairedToken(tokens)
      await store.add({
        network: network.id,
        source: 'ref',
        poolId: String(cur.nextIndex + i),
        token,
        launchpad: launchpadOf('ref', token),
        detail: { fee: obj(p) && typeof p.total_fee === 'number' ? p.total_fee : null, kind: obj(p) && typeof p.pool_kind === 'string' ? p.pool_kind : null },
      })
    }
    await store.setCursor(network.id, 'ref', cur.nextIndex + pools.length, null)
  }

  /** A watched pool read again: live with NEAR in it (and its Nearly launch done) is ready; long empty, dropped. */
  async function look(p: NewPool): Promise<void> {
    const detail = { ...p.detail }
    if (now() - p.firstSeenAt > WATCH_MAX_MS) {
      await store.update(p.id, { status: 'dropped', nearRaw: p.nearRaw, detail: { ...detail, reason: 'No NEAR liquidity within 30 minutes' } })
      return
    }
    let live = false
    let nearSide: bigint | null = null
    if (p.source === 'dcl') {
      const r = await view(dcl, 'get_pool', { pool_id: p.poolId })
      if (obj(r)) {
        nearSide = big(r.token_y === wrap ? r.total_y : r.total_x)
        live = r.state === 'Running' && (big(r.liquidity) ?? 0n) > 0n && (nearSide ?? 0n) > 0n
      }
    } else {
      const r = await view(ref, 'get_pool', { pool_id: Number(p.poolId) })
      if (obj(r) && Array.isArray(r.amounts) && Array.isArray(r.token_account_ids)) {
        const amounts = r.amounts.map(big)
        nearSide = amounts[r.token_account_ids.indexOf(wrap)] ?? null
        live = amounts.length > 0 && amounts.every((a) => a !== null && a > 0n)
      }
    }
    if (live && p.launchpad === 'nearly' && deps.nearly && p.token) {
      // A Nearly launch is tradable once Nearly says it is done (its pool, liquidity and dev buy in place).
      const launch = await view(deps.nearly, 'get_launch_by_token', { token: p.token })
      const step = obj(launch) && typeof launch.step === 'string' ? launch.step : null
      if (step === 'Failed') {
        await store.update(p.id, { status: 'dropped', nearRaw: nearSide?.toString() ?? null, detail: { ...detail, reason: 'Its Nearly launch failed' } })
        return
      }
      if (step !== 'Done') {
        live = false
        detail.waiting = `Its Nearly launch is at step ${step ?? 'unknown'}`
      } else if (obj(launch)) {
        detail.launch = {
          id: typeof launch.id === 'number' ? launch.id : null,
          creator: typeof launch.creator === 'string' ? launch.creator : null,
          devBuyNear: typeof launch.dev_buy_near === 'string' ? launch.dev_buy_near : null,
        }
        delete detail.waiting
      }
    }
    if (live && (await store.update(p.id, { status: 'ready', nearRaw: nearSide?.toString() ?? null, detail, ready: true }))) {
      if (p.token) await deps.onReady?.(p.token)
      return
    }
    if (!live) await store.update(p.id, { status: 'watching', nearRaw: nearSide?.toString() ?? null, detail })
  }

  async function watch(): Promise<void> {
    for (const p of await store.watching(network.id, WATCH_PER_STEP)) {
      await look(p).catch(async (e: unknown) => {
        log.warn('pool feed: reading a watched pool failed', { pool: p.poolId, error: e })
        await store.update(p.id, { status: 'watching', nearRaw: p.nearRaw, detail: p.detail }).catch(() => undefined)
      })
    }
  }

  return {
    /** One round: each counter and the watched pools, each when its interval has passed. */
    async step(): Promise<void> {
      const t = now()
      if (t - last.dcl >= DCL_SCAN_MS) {
        last.dcl = t
        await scanDcl().catch((e: unknown) => log.warn('pool feed: the DCL scan failed', { error: e }))
      }
      if (t - last.ref >= REF_SCAN_MS) {
        last.ref = t
        await scanRef().catch((e: unknown) => log.warn('pool feed: the Ref scan failed', { error: e }))
      }
      if (t - last.watch >= WATCH_MS) {
        last.watch = t
        await watch().catch((e: unknown) => log.warn('pool feed: watching pools failed', { error: e }))
      }
    },
    scanDcl,
    scanRef,
    watch,
  }
}

export type PoolFeed = ReturnType<typeof createPoolFeed>
