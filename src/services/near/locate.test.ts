import { describe, expect, it, vi } from 'vitest'
import { createTxLocator, keysMoved, readKeys } from './locate'
import { RpcError } from './rpc'

const LAYOUT = {
  V3: {
    boundary_accounts: ['650', 'aurora', 'aurora-0', 'earn.kaiching', 'game.hot.tg', 'game.hot.tg-0', 'kkuuue2akv_1630967379.near', 'tge-lockup.sweat', 'wallet.ka'],
    shard_ids: [10, 11, 1, 8, 9, 6, 7, 4, 12, 13],
  },
}
const KEY = 'ed25519:7Y3n1aBoMY6b2dGwHuMe3QNKsEjCbyycUbaD9MstxrVQ'
const OTHER_KEY = 'ed25519:5DAGrKEnKZyaGT1ooxwJ3GGsFZF6CNEeGVJhMyt1pjCb'

interface ChunkTx {
  hash: string
  signer_id: string
  public_key: string
  nonce: number
  receiver_id: string
  actions: unknown[]
}

/**
 * bottest.near lives on shard 8. `chunks[h]` is the chunk produced at height h; a height
 * with no new chunk repeats the previous one (height_included below it), a height with
 * no block answers UNKNOWN_BLOCK, and `transport` heights fail like an unreachable node.
 */
function chain(opts: { chunks?: Record<number, ChunkTx[]>; noChunk?: number[]; noBlock?: number[]; transport?: number[]; nonce?: number; height?: number }) {
  const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'EXPERIMENTAL_protocol_config') return { shard_layout: LAYOUT }
    if (method === 'query' && params.request_type === 'view_access_key_list')
      return {
        keys: [
          { public_key: KEY, access_key: { nonce: opts.nonce ?? 100, permission: 'FullAccess' } },
          { public_key: OTHER_KEY, access_key: { nonce: 5, permission: 'FullAccess' } },
        ],
        block_height: opts.height ?? 1000,
        block_hash: 'h',
      }
    if (method === 'chunk') {
      const h = Number(params.block_id)
      if (params.shard_id !== 8) throw new Error(`scanned shard ${String(params.shard_id)}`)
      if (opts.noBlock?.includes(h)) throw new RpcError('handler', 'DB Not Found Error', 'UNKNOWN_BLOCK')
      if (opts.transport?.includes(h)) throw new RpcError('transport', 'fetch failed')
      if (opts.noChunk?.includes(h)) return { header: { height_included: h - 1 }, transactions: opts.chunks?.[h - 1] ?? [] }
      return { header: { height_included: h }, transactions: opts.chunks?.[h] ?? [] }
    }
    throw new Error(`unexpected ${method}`)
  })
  return { call: call as never, calls: call }
}

const tx = (hash: string, nonce: number, over: Partial<ChunkTx> = {}): ChunkTx => ({
  hash,
  signer_id: 'bottest.near',
  public_key: KEY,
  nonce,
  receiver_id: 'wrap.near',
  actions: [{ FunctionCall: { method_name: 'near_deposit', args: 'e30=', gas: 10000000000000, deposit: '1' } }],
  ...over,
})

describe('readKeys', () => {
  it('reads every access key’s nonce and the block the view is from', async () => {
    const snap = await readKeys(chain({ nonce: 101, height: 1234 }), 'bottest.near')
    expect(snap?.height).toBe(1234)
    expect(snap?.nonces.get(KEY)).toBe(101n)
    expect(snap?.nonces.get(OTHER_KEY)).toBe(5n)
  })

  it('answers null when the keys can’t be read', async () => {
    expect(await readKeys({ call: (async () => Promise.reject(new Error('down'))) as never }, 'bottest.near')).toBeNull()
  })

  it('counts how many transactions the keys signed in between', () => {
    const at = (a: bigint, b: bigint) => ({
      height: 1,
      nonces: new Map([
        [KEY, a],
        [OTHER_KEY, b],
      ]),
    })
    expect(keysMoved(at(100n, 5n), at(100n, 5n))).toBe(0)
    expect(keysMoved(at(100n, 5n), at(102n, 6n))).toBe(3)
    // Adding or deleting a key is one transaction each.
    const one = { height: 1, nonces: new Map([[KEY, 100n]]) }
    expect(keysMoved(one, at(100n, 5n))).toBe(1)
    expect(keysMoved(at(100n, 5n), one)).toBe(1)
  })
})

describe('signedSince', () => {
  const baseline = {
    height: 1000,
    nonces: new Map([
      [KEY, 100n],
      [OTHER_KEY, 5n],
    ]),
  }

  it('finds the account’s transactions signed after the baseline, from its own shard’s chunks', async () => {
    const c = chain({
      chunks: {
        1002: [tx('OLD', 100), tx('SOMEONE', 7, { signer_id: 'alice.near' })],
        1004: [tx('MINE', 101)],
        1006: [tx('MINE2', 102, { receiver_id: 'aggregatedex.near' })],
      },
      noChunk: [1005],
      noBlock: [1003],
    })
    const found = await createTxLocator(c).signedSince('bottest.near', baseline, 1000, 1006)
    expect(found.map((t) => t.hash)).toEqual(['MINE', 'MINE2'])
    expect(found[0]).toMatchObject({ publicKey: KEY, nonce: 101n, receiverId: 'wrap.near', height: 1004 })
    // Only the heights after the baseline, each once.
    expect(c.calls.mock.calls.filter(([m]) => m === 'chunk').map(([, p]) => (p as { block_id: number }).block_id)).toEqual([1001, 1002, 1003, 1004, 1005, 1006])
  })

  it('fails on an unreachable node, so the caller asks again instead of skipping blocks', async () => {
    await expect(createTxLocator(chain({ transport: [1002] })).signedSince('bottest.near', baseline, 1000, 1003)).rejects.toThrow()
  })

  it('scans at most the most recent blocks it is allowed to', async () => {
    const c = chain({ chunks: { 1010: [tx('LATE', 101)] } })
    const found = await createTxLocator(c, undefined, { maxBlocks: 3 }).signedSince('bottest.near', baseline, 1000, 1010)
    expect(found.map((t) => t.hash)).toEqual(['LATE'])
    expect(c.calls.mock.calls.filter(([m]) => m === 'chunk')).toHaveLength(3)
  })
})
