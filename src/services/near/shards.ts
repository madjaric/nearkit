import type { RpcClient } from './rpc'

/**
 * Which shard holds an account, from the chain's own shard layout
 * (`EXPERIMENTAL_protocol_config` → `shard_layout`). Accounts are split into ranges by
 * boundary accounts in byte order: an account belongs to the range of the last boundary
 * at or below it. V2/V3 layouts name each range's shard in `shard_ids`; V1 numbers them
 * by position. Read from the chain, never hard-coded: resharding moves accounts.
 */

export interface ShardLayout {
  boundaries: readonly string[]
  ids: readonly number[]
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string')
const ints = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => Number.isSafeInteger(n) && (n as number) >= 0)

export function parseShardLayout(raw: unknown): ShardLayout | null {
  if (!raw || typeof raw !== 'object') return null
  const versions = raw as Record<string, unknown>
  const body = (versions.V3 ?? versions.V2 ?? versions.V1) as { boundary_accounts?: unknown; shard_ids?: unknown } | undefined
  if (!body || !strings(body.boundary_accounts)) return null
  const boundaries = body.boundary_accounts
  const ids = versions.V1 && !versions.V2 && !versions.V3 ? boundaries.map((_, i) => i).concat(boundaries.length) : body.shard_ids
  if (!ints(ids) || ids.length !== boundaries.length + 1) return null
  return { boundaries, ids }
}

export function shardOf(layout: ShardLayout, accountId: string): number {
  let i = 0
  while (i < layout.boundaries.length && accountId >= (layout.boundaries[i] as string)) i++
  return layout.ids[i] as number
}

/** The live layout, read once per lookup (a failed read is asked again next time). */
export function createShardLookup(rpc: Pick<RpcClient, 'call'>) {
  let layout: Promise<ShardLayout | null> | null = null
  const read = () => {
    layout ??= rpc
      .call<{ shard_layout?: unknown }>('EXPERIMENTAL_protocol_config', { finality: 'final' })
      .then((c) => parseShardLayout(c?.shard_layout))
      .then((l) => {
        if (!l) layout = null
        return l
      })
      .catch(() => {
        layout = null
        return null
      })
    return layout
  }
  return {
    /** Shard id holding `accountId`, or null when the layout can't be read. */
    async shardOf(accountId: string): Promise<number | null> {
      const l = await read()
      return l ? shardOf(l, accountId) : null
    },
  }
}

export type ShardLookup = ReturnType<typeof createShardLookup>
