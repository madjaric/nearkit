import type { RpcClient } from './rpc'
import { createShardLookup, type ShardLookup } from './shards'

/**
 * How backed up a shard is right now: the gas of receipts waiting in its delayed queue,
 * from the chunk header at the latest final block. wrap.near's shard backs up in bursts
 * (e.g. batches of 300 TGas calls from another contract on it), and every NEAR → token
 * swap waits in that queue twice before the tokens arrive. Informational only: nothing
 * is ever blocked on it, and what can't be read never warns.
 */

/**
 * A backlog at which swaps through the shard take noticeably longer: a busy chunk runs
 * ~0.4 PGas, so 5 PGas is ~12 blocks of waiting per hop (observed 2026-09-30: 6 PGas →
 * 17 blocks, 36 PGas → 68–126 blocks, 330 PGas → ~700 blocks).
 */
export const BUSY_BACKLOG_GAS = 5_000_000_000_000_000n

export const NETWORK_BUSY_WARNING = 'NEAR network is currently busy. This swap may take longer than usual.'

export function createCongestionProbe(rpc: Pick<RpcClient, 'call'>, shards: ShardLookup = createShardLookup(rpc)) {
  async function backlog(accountId: string): Promise<bigint | null> {
    try {
      const shard = await shards.shardOf(accountId)
      if (shard === null) return null
      const head = await rpc.call<{ header?: { height?: unknown } }>('block', { finality: 'final' })
      const height = head?.header?.height
      if (typeof height !== 'number') return null
      const chunk = await rpc.call<{ header?: { congestion_info?: { delayed_receipts_gas?: unknown } } }>('chunk', { block_id: height, shard_id: shard })
      const gas = chunk?.header?.congestion_info?.delayed_receipts_gas
      return typeof gas === 'string' && /^\d+$/.test(gas) ? BigInt(gas) : null
    } catch {
      return null
    }
  }
  return {
    /** Gas waiting in the delayed queue of the shard that holds `accountId`; null when unreadable. */
    backlog,
    /** Whether receipts to `accountId` wait noticeably right now. False when unreadable. */
    async busy(accountId: string): Promise<boolean> {
      const b = await backlog(accountId)
      return b !== null && b >= BUSY_BACKLOG_GAS
    },
  }
}

export type CongestionProbe = ReturnType<typeof createCongestionProbe>
