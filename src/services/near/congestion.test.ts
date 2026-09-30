import { describe, expect, it, vi } from 'vitest'
import { BUSY_BACKLOG_GAS, createCongestionProbe } from './congestion'

const LAYOUT = {
  V3: {
    boundary_accounts: ['650', 'aurora', 'aurora-0', 'earn.kaiching', 'game.hot.tg', 'game.hot.tg-0', 'kkuuue2akv_1630967379.near', 'tge-lockup.sweat', 'wallet.ka'],
    shard_ids: [10, 11, 1, 8, 9, 6, 7, 4, 12, 13],
  },
}
const PGAS = 10n ** 15n

/** A chain whose shards carry these delayed-receipt backlogs (gas) at the final block. */
function rpcWith(backlog: Record<number, bigint | 'missing' | 'error'>) {
  const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'EXPERIMENTAL_protocol_config') return { shard_layout: LAYOUT }
    if (method === 'block') return { header: { height: 217920980 } }
    if (method === 'chunk') {
      const b = backlog[Number(params.shard_id)] ?? 0n
      if (b === 'error') throw new Error('chunk unavailable')
      return { header: { height_included: params.block_id, ...(b === 'missing' ? {} : { congestion_info: { delayed_receipts_gas: b.toString(), buffered_receipts_gas: '0' } }) } }
    }
    throw new Error(`unexpected ${method}`)
  })
  return { call: call as never, calls: call }
}

describe('congestion probe', () => {
  it('flags wrap.near’s shard as busy when its delayed-receipt backlog is large (the 13:06 UTC backlog: 36 PGas)', async () => {
    const rpc = rpcWith({ 13: 36n * PGAS })
    const probe = createCongestionProbe(rpc)
    expect(await probe.backlog('wrap.near')).toBe(36n * PGAS)
    expect(await probe.busy('wrap.near')).toBe(true)
    expect(rpc.calls).toHaveBeenCalledWith('chunk', { block_id: 217920980, shard_id: 13 })
  })

  it('reads the account’s own shard, not another', async () => {
    const probe = createCongestionProbe(rpcWith({ 12: 300n * PGAS, 13: 0n }))
    expect(await probe.busy('wrap.near')).toBe(false)
    expect(await probe.busy('v2.ref-finance.near')).toBe(true)
  })

  it('is quiet below the threshold', async () => {
    const probe = createCongestionProbe(rpcWith({ 13: BUSY_BACKLOG_GAS - 1n }))
    expect(await probe.busy('wrap.near')).toBe(false)
    expect(await createCongestionProbe(rpcWith({ 13: BUSY_BACKLOG_GAS })).busy('wrap.near')).toBe(true)
  })

  it('never warns on what it can’t read: an RPC error or a chunk without congestion info', async () => {
    for (const b of ['error', 'missing'] as const) {
      const probe = createCongestionProbe(rpcWith({ 13: b }))
      expect(await probe.backlog('wrap.near')).toBeNull()
      expect(await probe.busy('wrap.near')).toBe(false)
    }
  })
})
