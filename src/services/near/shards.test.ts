import { describe, expect, it, vi } from 'vitest'
import { createShardLookup, parseShardLayout, shardOf } from './shards'

// Mainnet's layout on 2026-09-30 (EXPERIMENTAL_protocol_config → shard_layout).
const MAINNET = {
  V3: {
    boundary_accounts: ['650', 'aurora', 'aurora-0', 'earn.kaiching', 'game.hot.tg', 'game.hot.tg-0', 'kkuuue2akv_1630967379.near', 'tge-lockup.sweat', 'wallet.ka'],
    id_to_index_map: { '1': 2, '4': 7, '6': 5, '7': 6, '8': 3, '9': 4, '10': 0, '11': 1, '12': 8, '13': 9 },
    last_split: 5,
    shard_ids: [10, 11, 1, 8, 9, 6, 7, 4, 12, 13],
    shards_split_map: { '0': [10, 11], '2': [8, 9], '3': [6, 7], '5': [12, 13] },
  },
}

describe('shardOf', () => {
  const layout = parseShardLayout(MAINNET)
  if (!layout) throw new Error('layout did not parse')

  it('places accounts the way mainnet does (checked against real receipts)', () => {
    expect(shardOf(layout, 'wrap.near')).toBe(13)
    expect(shardOf(layout, 'bottest.near')).toBe(8)
    expect(shardOf(layout, 'aggregatedex.near')).toBe(11)
    expect(shardOf(layout, 'dclv2.ref-labs.near')).toBe(8)
    expect(shardOf(layout, 'v2.ref-finance.near')).toBe(12)
    expect(shardOf(layout, 'nearly-993927.nearlytrade.near')).toBe(4)
  })

  it('puts a boundary account in the shard above it, and the lowest accounts in the first shard', () => {
    expect(shardOf(layout, 'wallet.ka')).toBe(13)
    expect(shardOf(layout, 'wallet.k')).toBe(12)
    expect(shardOf(layout, '0000000000000000000000000000000000000000000000000000000000000000')).toBe(10)
  })

  it('numbers shards by position in a V1 layout', () => {
    const v1 = parseShardLayout({ V1: { boundary_accounts: ['m', 't'], version: 1 } })
    expect(v1 && shardOf(v1, 'alice.near')).toBe(0)
    expect(v1 && shardOf(v1, 'near')).toBe(1)
    expect(v1 && shardOf(v1, 'zed.near')).toBe(2)
  })

  it('refuses layouts it cannot read (no boundaries, mismatched ids)', () => {
    expect(parseShardLayout({ V0: { num_shards: 4, version: 0 } })).toBeNull()
    expect(parseShardLayout({ V2: { boundary_accounts: ['m'], shard_ids: [0] } })).toBeNull()
    expect(parseShardLayout(null)).toBeNull()
  })
})

describe('createShardLookup', () => {
  it('reads the layout from the chain once and reuses it', async () => {
    const call = vi.fn(async () => ({ shard_layout: MAINNET }))
    const shards = createShardLookup({ call: call as never })
    expect(await shards.shardOf('wrap.near')).toBe(13)
    expect(await shards.shardOf('bottest.near')).toBe(8)
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('EXPERIMENTAL_protocol_config', { finality: 'final' })
  })

  it('answers null when the layout can’t be read, and asks again next time', async () => {
    let fail = true
    const call = vi.fn(async () => {
      if (fail) throw new Error('rpc down')
      return { shard_layout: MAINNET }
    })
    const shards = createShardLookup({ call: call as never })
    expect(await shards.shardOf('wrap.near')).toBeNull()
    fail = false
    expect(await shards.shardOf('wrap.near')).toBe(13)
  })
})
