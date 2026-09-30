import { mapLimit } from '@/lib/async'
import { RpcError, type RpcClient } from './rpc'
import { createShardLookup, type ShardLookup } from './shards'

/**
 * Finding what an account signed, from the chain alone, for when the wallet can't say:
 * its own wait timed out, or it is still waiting while the chain has moved on. An access
 * key's nonce rises when a transaction it signed is included; that transaction sits in a
 * chunk of the signer's own shard. Reads only; never signs or sends.
 */

export interface KeySnapshot {
  /** Block the view is from; null when the RPC didn't say. */
  height: number | null
  /** public key → nonce */
  nonces: Map<string, bigint>
}

export interface SignedTx {
  hash: string
  publicKey: string
  nonce: bigint
  receiverId: string
  /** As in `EXPERIMENTAL_tx_status` (`FunctionCall` with base64 args, `Transfer`…). */
  actions: unknown[]
  /** Block whose chunk included it. */
  height: number
}

/** Every access key's nonce, and the block the view is from. Null when it can't be read. */
export async function readKeys(rpc: Pick<RpcClient, 'call'>, accountId: string): Promise<KeySnapshot | null> {
  try {
    const r = await rpc.call<{ keys?: { public_key?: unknown; access_key?: { nonce?: unknown } }[]; block_height?: unknown }>('query', {
      request_type: 'view_access_key_list',
      finality: 'optimistic',
      account_id: accountId,
    })
    if (!r || !Array.isArray(r.keys)) return null
    const nonces = new Map<string, bigint>()
    for (const k of r.keys) {
      const nonce = k.access_key?.nonce
      if (typeof k.public_key !== 'string' || (typeof nonce !== 'number' && typeof nonce !== 'string')) return null
      nonces.set(k.public_key, BigInt(nonce))
    }
    return { height: typeof r.block_height === 'number' ? r.block_height : null, nonces }
  } catch {
    return null
  }
}

/** How many transactions the account's keys signed between two views (keys added or removed count as moved). */
export function keysMoved(before: KeySnapshot, after: KeySnapshot): number {
  let n = 0
  for (const [key, nonce] of after.nonces) {
    const was = before.nonces.get(key)
    if (was === undefined) n += 1
    else if (nonce > was) n += Number(nonce - was)
  }
  for (const key of before.nonces.keys()) if (!after.nonces.has(key)) n += 1
  return n
}

interface ChunkView {
  header?: { height_included?: unknown }
  transactions?: { hash?: unknown; signer_id?: unknown; public_key?: unknown; nonce?: unknown; receiver_id?: unknown; actions?: unknown }[]
}

/** Heights with no block (skipped) or no chunk there: nothing to find, not an error. */
const nothingThere = (e: unknown) => e instanceof RpcError && (e.causeName === 'UNKNOWN_BLOCK' || e.causeName === 'UNKNOWN_CHUNK')

export function createTxLocator(rpc: Pick<RpcClient, 'call'>, shards: ShardLookup = createShardLookup(rpc), opts: { maxBlocks?: number; concurrency?: number } = {}) {
  const maxBlocks = opts.maxBlocks ?? 900
  return {
    /**
     * Transactions `accountId` signed with a key nonce above `baseline`, included in blocks after
     * `fromHeight` up to `toHeight` (at most the latest `maxBlocks`). Throws when a block couldn't be
     * read, so the caller asks again rather than skipping it.
     */
    async signedSince(accountId: string, baseline: KeySnapshot, fromHeight: number, toHeight: number): Promise<SignedTx[]> {
      const shard = await shards.shardOf(accountId)
      if (shard === null) throw new Error('The shard layout could not be read')
      const start = Math.max(fromHeight + 1, toHeight - maxBlocks + 1)
      const heights = Array.from({ length: Math.max(0, toHeight - start + 1) }, (_, i) => start + i)
      const perBlock = await mapLimit(heights, opts.concurrency ?? 4, async (height): Promise<SignedTx[]> => {
        let chunk: ChunkView
        try {
          chunk = await rpc.call<ChunkView>('chunk', { block_id: height, shard_id: shard })
        } catch (e) {
          if (nothingThere(e)) return []
          throw e
        }
        // No new chunk at this height: the block repeats an older one, already read at its own height.
        if (chunk?.header?.height_included !== height) return []
        return (chunk.transactions ?? []).flatMap((t) => {
          if (t.signer_id !== accountId || typeof t.hash !== 'string' || typeof t.public_key !== 'string' || typeof t.receiver_id !== 'string') return []
          if (typeof t.nonce !== 'number' && typeof t.nonce !== 'string') return []
          const nonce = BigInt(t.nonce)
          const base = baseline.nonces.get(t.public_key)
          if (base !== undefined && nonce <= base) return []
          return [{ hash: t.hash, publicKey: t.public_key, nonce, receiverId: t.receiver_id, actions: Array.isArray(t.actions) ? t.actions : [], height }]
        })
      })
      return perBlock.flat()
    },
  }
}

export type TxLocator = ReturnType<typeof createTxLocator>
