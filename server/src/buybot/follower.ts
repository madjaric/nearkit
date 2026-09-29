import type { RpcClient } from '@/services/near/rpc'
import type { Logger } from '../log'
import type { BuybotStore } from './store'

/**
 * Watches each followed token through FastNEAR's transaction index: the token
 * contract's account history, newest first, about two blocks behind the chain.
 * Every transaction that touched the contract becomes a candidate, read in full
 * later (pipeline.ts). Requests scale with activity, not with block count, which
 * keeps the bot inside free-tier limits (neardata's block feed allows 180 blocks
 * a minute; mainnet makes about 107, so two shards would already be too many).
 *
 * Each token has its own cursor: the height up to which its history was read. It
 * trails the final head by a margin, so a transaction the index adds a moment late
 * is still picked up; seeing one twice is harmless (candidates and buys are keyed).
 */

export interface IndexedTx {
  hash: string
  blockHeight: number
}

export class TxIndexError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TxIndexError'
  }
}

export function createTxIndex(baseUrl: string, fetchImpl: typeof fetch, options: { minIntervalMs?: number; timeoutMs?: number; now?: () => number } = {}) {
  const minInterval = options.minIntervalMs ?? 350
  const now = options.now ?? Date.now
  let next = 0
  let chain: Promise<void> = Promise.resolve()

  // One request at a time, spaced: the index is a free public service.
  function pace(): Promise<void> {
    const run = chain.then(async () => {
      const wait = next - now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      next = now() + minInterval
    })
    chain = run.catch(() => undefined)
    return run
  }

  async function post<T>(path: string, body: unknown): Promise<T> {
    await pace()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000)
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal })
      if (res.status === 429) {
        next = now() + 5_000
        throw new TxIndexError('transaction index rate-limited')
      }
      if (!res.ok) throw new TxIndexError(`transaction index answered ${res.status}`)
      return (await res.json()) as T
    } catch (e) {
      if (e instanceof TxIndexError) throw e
      throw new TxIndexError(`transaction index unreachable (${e instanceof Error ? e.name : 'error'})`)
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    /** Newest transactions that touched `account`, newest first. */
    async recent(account: string, opts: { limit: number; resumeToken?: string }): Promise<{ txs: IndexedTx[]; resumeToken: string | null }> {
      const body = await post<{ account_txs?: { transaction_hash?: string; tx_block_height?: number }[]; resume_token?: unknown }>('/v0/account', {
        account_id: account,
        limit: opts.limit,
        ...(opts.resumeToken ? { resume_token: opts.resumeToken } : {}),
      })
      const txs = (body.account_txs ?? []).flatMap((t) =>
        typeof t.transaction_hash === 'string' && typeof t.tx_block_height === 'number' ? [{ hash: t.transaction_hash, blockHeight: t.tx_block_height }] : [],
      )
      return { txs, resumeToken: typeof body.resume_token === 'string' || typeof body.resume_token === 'number' ? String(body.resume_token) : null }
    },
    /** Full transactions (receipts and outcomes) by hash; missing ones are left out. */
    async transactions(hashes: string[]): Promise<Map<string, unknown>> {
      const out = new Map<string, unknown>()
      for (let i = 0; i < hashes.length; i += 20) {
        const body = await post<{ transactions?: { transaction?: { hash?: string } }[] }>('/v0/transactions', { tx_hashes: hashes.slice(i, i + 20) })
        for (const t of body.transactions ?? []) if (t.transaction?.hash) out.set(t.transaction.hash, t)
      }
      return out
    },
  }
}

export type TxIndex = ReturnType<typeof createTxIndex>

/** How far below the final head a token's cursor stays, so late-indexed transactions aren't missed. */
export const TRAIL = 10
/** Blocks to catch up after downtime before skipping ahead (about 10 minutes at ~1.8 blocks/s). */
export const MAX_BACKLOG = 1000
const PAGE = 50
const MAX_PAGES = 6

export function createFollower(deps: { network: string; rpc: RpcClient; index: TxIndex; store: BuybotStore; log: Logger }) {
  async function finalHeight(): Promise<number> {
    const block = await deps.rpc.call<{ header?: { height?: number } }>('block', { finality: 'final' })
    const h = block?.header?.height
    if (typeof h !== 'number') throw new Error('The RPC returned no final block height')
    return h
  }

  async function followToken(token: string, head: number): Promise<number> {
    const target = head - TRAIL
    const cursor = deps.store.tokenCursor(deps.network, token)
    // First time: start from now. Never backfill old buys into a chat.
    if (cursor === null) {
      deps.store.advanceToken(deps.network, token, target, [])
      return 0
    }
    let from = cursor
    if (head - cursor > MAX_BACKLOG) {
      deps.log.warn('buybot fell behind; skipping old history', { token, from: cursor, to: head - MAX_BACKLOG })
      from = head - MAX_BACKLOG
    }
    const found: IndexedTx[] = []
    let resumeToken: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await deps.index.recent(token, { limit: PAGE, ...(resumeToken ? { resumeToken } : {}) })
      for (const t of r.txs) if (t.blockHeight > from && t.blockHeight <= head) found.push(t)
      const oldest = r.txs.at(-1)?.blockHeight
      if (!r.resumeToken || oldest === undefined || oldest <= from) break
      resumeToken = r.resumeToken
    }
    deps.store.advanceToken(
      deps.network,
      token,
      Math.max(from, target),
      found.map((t) => ({ txHash: t.hash, blockHeight: t.blockHeight })),
    )
    return found.length
  }

  return {
    /** One pass over every followed token. `idle`: nothing followed; `caught-up`: all read to the head. */
    async step(): Promise<'idle' | 'caught-up'> {
      const tokens = deps.store.activeTokens(deps.network)
      if (!tokens.length) return 'idle'
      const head = await finalHeight()
      let total = 0
      for (const token of tokens) total += await followToken(token, head)
      if (total) deps.log.info('buybot candidates', { network: deps.network, txs: total })
      return 'caught-up'
    },
    finalHeight,
  }
}

export type Follower = ReturnType<typeof createFollower>
