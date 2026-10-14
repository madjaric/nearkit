import { describe, expect, it } from 'vitest'
import { NETWORKS } from '@/config/networks'
import { openTestDatabase, type TestEngine } from '../db/testing'
import { migrate } from '../db/schema'
import { silentLogger } from '../log'
import { createPoolFeed, IDLE_RESET_MS, PoolStore, WATCH_MAX_MS } from './pools'

/**
 * Sniper's pool feed against fake exchanges that answer the way Ref DCL, Ref v2 and Nearly answered on
 * mainnet (2026-10-14): DCL's `get_metadata.pool_count` (a string), `list_pools` in insertion order and
 * `get_pool`; Ref v2's `get_number_of_pools`, `get_pools` and `get_pool` by index; Nearly's
 * `get_launch_by_token`. Run on the production dialect too (NEARKIT_TEST_BOT_DB=pglite).
 */

const NET = NETWORKS.mainnet
const WRAP = NET.wrapContract
const DCL = NET.dex.dcl.contract
const REF = NET.rhea.classic.exchange
const NEARLY = 'nearlytrade.near'
const NEAR = 10n ** 24n

function exchanges() {
  const dcl: Record<string, unknown>[] = []
  const ref: { token_account_ids: string[]; amounts: string[]; total_fee: number; pool_kind: string }[] = []
  const launches = new Map<string, Record<string, unknown>>()
  const calls: string[] = []
  const view = async (contract: string, method: string, args: Record<string, unknown>): Promise<unknown> => {
    calls.push(`${contract}.${method}`)
    if (contract === DCL && method === 'get_metadata') return { version: '2.3.15', pool_count: String(dcl.length) }
    if (contract === DCL && method === 'list_pools') return dcl.slice(Number(args.from_index), Number(args.from_index) + Number(args.limit))
    if (contract === DCL && method === 'get_pool') return dcl.find((p) => p.pool_id === args.pool_id) ?? null
    if (contract === REF && method === 'get_number_of_pools') return ref.length
    if (contract === REF && method === 'get_pools') return ref.slice(Number(args.from_index), Number(args.from_index) + Number(args.limit))
    if (contract === REF && method === 'get_pool') {
      const p = ref[Number(args.pool_id)]
      if (!p) throw new Error('E85: invalid pool id')
      return p
    }
    if (contract === NEARLY && method === 'get_launch_by_token') return launches.get(String(args.token)) ?? null
    throw new Error(`unexpected view ${contract}.${method}`)
  }
  /** A DCL pool of `token` against wNEAR, created empty (as a new pool is). */
  const addDcl = (token: string, other = WRAP) => {
    const [x, y] = token < other ? [token, other] : [other, token]
    const pool = { pool_id: `${x}|${y}|10000`, token_x: x, token_y: y, fee: 10000, liquidity: '0', total_x: '0', total_y: '0', state: 'Running' }
    dcl.push(pool)
    return pool
  }
  /** Liquidity arrives: `near` NEAR on the pool's wNEAR side. */
  const fund = (pool: Record<string, unknown>, near: bigint) => {
    pool.liquidity = '1000000'
    if (pool.token_y === WRAP) pool.total_y = near.toString()
    else pool.total_x = near.toString()
  }
  const addRef = (token: string, amounts: [string, string] = ['0', '0']) => {
    ref.push({ token_account_ids: [token, WRAP], amounts: [...amounts], total_fee: 10, pool_kind: 'SIMPLE_POOL' })
    return ref.length - 1
  }
  return { dcl, ref, launches, calls, view, addDcl, fund, addRef }
}

async function setup(opts: { nearly?: string | null } = {}) {
  const db = await openTestDatabase((process.env.NEARKIT_TEST_BOT_DB as TestEngine | undefined) ?? 'sqlite')
  await migrate(db)
  const clock = { t: 1_800_000_000_000 }
  const now = () => clock.t
  const store = new PoolStore(db, now)
  const ex = exchanges()
  const ready: string[] = []
  const feed = () =>
    createPoolFeed({
      store,
      view: ex.view,
      network: NET,
      nearly: opts.nearly === undefined ? NEARLY : opts.nearly,
      log: silentLogger,
      now,
      onReady: async (token) => void ready.push(token),
    })
  const pools = async () => (await db.all<{ pool_id: string; status: string; source: string }>('SELECT pool_id, status, source FROM auto_pools ORDER BY id')).map((r) => r)
  return { db, store, ex, clock, feed, pools, ready, advance: (ms: number) => void (clock.t += ms) }
}

describe('the round-2 migration', () => {
  it('a database migrated before it (SQLite 18 / Postgres 9) gains the request keys, the cancel request and the pool feed', async () => {
    const engine = (process.env.NEARKIT_TEST_BOT_DB as TestEngine | undefined) ?? 'sqlite'
    const db = await openTestDatabase(engine, { migrateTo: engine === 'sqlite' ? 18 : 9 })
    await expect(db.get('SELECT COUNT(*) AS c FROM auto_pools')).rejects.toThrow()
    await migrate(db)
    for (const table of ['auto_pools', 'auto_feed_cursors', 'auto_create_requests']) expect(await db.get(`SELECT COUNT(*) AS c FROM ${table}`)).toBeTruthy()
    expect(await db.get('SELECT cancel_requested_at FROM auto_strategies LIMIT 1')).toBeFalsy()
  })
})

describe('the pool feed', () => {
  it('starts at the counters: pools made before it ran are never reported as new; pools made after are, each once', async () => {
    const { ex, feed, pools, advance } = await setup()
    ex.addDcl('old.nearlytrade.near')
    ex.addRef('old.meme-cooking.near')
    const f = feed()
    await f.step()
    expect(await pools()).toEqual([])
    ex.addDcl('fogo-2.nearlytrade.near')
    ex.addDcl('usdc.near', 'usdt.near') // no wNEAR: recorded, not watched
    ex.addRef('chill-2257.meme-cooking.near')
    advance(5_000)
    await f.step()
    expect(await pools()).toEqual([
      { pool_id: `fogo-2.nearlytrade.near|${WRAP}|10000`, status: 'watching', source: 'dcl' },
      { pool_id: 'usdc.near|usdt.near|10000', status: 'unpaired', source: 'dcl' },
      { pool_id: '1', status: 'watching', source: 'ref' },
    ])
    advance(5_000)
    await f.step()
    expect(await pools()).toHaveLength(3)
  })

  it('a restart goes on from the cursor: a new feed on the same database records only what is new, and a replayed batch adds nothing', async () => {
    const { ex, store, feed, pools, advance } = await setup()
    await feed().step()
    ex.addDcl('a.nearlytrade.near')
    advance(5_000)
    await feed().step()
    // A second instance (after a restart) with one more pool.
    ex.addDcl('b.nearlytrade.near')
    advance(5_000)
    await feed().step()
    expect((await pools()).map((p) => p.pool_id)).toEqual([`a.nearlytrade.near|${WRAP}|10000`, `b.nearlytrade.near|${WRAP}|10000`])
    // As if the process stopped after writing the batch and before moving the cursor.
    const cur = await store.cursor(NET.id, 'dcl')
    await store.setCursor(NET.id, 'dcl', (cur?.nextIndex ?? 0) - 1, `a.nearlytrade.near|${WRAP}|10000`)
    advance(5_000)
    await feed().step()
    expect(await pools()).toHaveLength(2)
  })

  it('a new pool is watched until NEAR liquidity is in it, then ready once (its token’s snipers woken); one that stays empty is dropped', async () => {
    const { ex, feed, pools, ready, advance } = await setup({ nearly: null })
    const f = feed()
    await f.step()
    const live = ex.addDcl('fresh.near')
    ex.addDcl('empty.near')
    const refId = ex.addRef('chill-2257.meme-cooking.near')
    advance(5_000)
    await f.step()
    expect((await pools()).map((p) => p.status)).toEqual(['watching', 'watching', 'watching'])
    ex.fund(live, 5n * NEAR)
    ;(ex.ref[refId] as { amounts: string[] }).amounts = ['1000000', (10n * NEAR).toString()]
    advance(5_000)
    await f.step()
    expect((await pools()).map((p) => p.status)).toEqual(['ready', 'watching', 'ready'])
    expect(ready).toEqual(['fresh.near', 'chill-2257.meme-cooking.near'])
    advance(WATCH_MAX_MS)
    await f.step()
    expect((await pools()).map((p) => p.status)).toEqual(['ready', 'dropped', 'ready'])
    expect(ready).toHaveLength(2)
  })

  it('records where a pool comes from (a Nearly launch, a meme.cooking graduation) and its NEAR side', async () => {
    const { ex, store, feed, advance } = await setup()
    const f = feed()
    await f.step()
    const p = ex.addDcl('fogo-2.nearlytrade.near')
    ex.launches.set('fogo-2.nearlytrade.near', { id: 3012, step: 'Done', creator: 'narrownook4299.near', dev_buy_near: (20n * NEAR).toString() })
    ex.fund(p, 53n * NEAR)
    ex.addRef('chill-2257.meme-cooking.near', ['1', '1'])
    advance(5_000)
    await f.step()
    advance(5_000)
    await f.step()
    const nearly = await store.get(NET.id, 'dcl', `fogo-2.nearlytrade.near|${WRAP}|10000`)
    expect(nearly).toMatchObject({ launchpad: 'nearly', status: 'ready', nearRaw: (53n * NEAR).toString(), detail: { launch: { id: 3012, creator: 'narrownook4299.near' } } })
    expect(await store.get(NET.id, 'ref', '0')).toMatchObject({ launchpad: 'meme-cooking', status: 'ready' })
  })

  it('a Nearly launch is ready only once Nearly says it is done; a failed launch is dropped', async () => {
    const { ex, store, feed, advance } = await setup()
    const f = feed()
    await f.step()
    const a = ex.addDcl('going.nearlytrade.near')
    const b = ex.addDcl('broken.nearlytrade.near')
    ex.fund(a, 2n * NEAR)
    ex.fund(b, 2n * NEAR)
    ex.launches.set('going.nearlytrade.near', { id: 1, step: 'DevBuy' })
    ex.launches.set('broken.nearlytrade.near', { id: 2, step: 'Failed' })
    advance(5_000)
    await f.step()
    advance(5_000)
    await f.step()
    expect(await store.get(NET.id, 'dcl', `going.nearlytrade.near|${WRAP}|10000`)).toMatchObject({ status: 'watching', detail: { waiting: expect.stringMatching(/DevBuy/) } })
    expect(await store.get(NET.id, 'dcl', `broken.nearlytrade.near|${WRAP}|10000`)).toMatchObject({ status: 'dropped' })
    ex.launches.set('going.nearlytrade.near', { id: 1, step: 'Done' })
    advance(5_000)
    await f.step()
    expect(await store.get(NET.id, 'dcl', `going.nearlytrade.near|${WRAP}|10000`)).toMatchObject({ status: 'ready' })
  })

  it('the DCL list changing order under the cursor, or the feed idle for long: anchored again, nothing old reported as new', async () => {
    const { ex, feed, pools, advance } = await setup()
    const f = feed()
    ex.addDcl('one.near')
    await f.step()
    ex.addDcl('two.near')
    // Another pool moved into the cursor's place (as a removal from an unordered map would).
    ex.dcl.unshift(ex.dcl.splice(1, 1)[0] as Record<string, unknown>)
    ex.addDcl('three.near')
    advance(5_000)
    await f.step()
    expect(await pools()).toEqual([])
    // Idle (no new-pools sniper, or the server down) for longer than IDLE_RESET_MS: the gap is skipped.
    ex.addDcl('during-the-gap.near')
    advance(IDLE_RESET_MS + 1_000)
    await f.step()
    ex.addDcl('after.near')
    advance(5_000)
    await f.step()
    expect((await pools()).map((p) => p.pool_id)).toEqual([`after.near|${WRAP}|10000`])
  })

  it('reads counters at their pace: two view calls per scan when nothing is new', async () => {
    const { ex, feed, advance } = await setup()
    const f = feed()
    await f.step()
    ex.calls.length = 0
    advance(5_000)
    await f.step()
    expect(ex.calls.sort()).toEqual([`${DCL}.get_metadata`, `${REF}.get_number_of_pools`])
  })
})
