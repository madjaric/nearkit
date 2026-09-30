import { describe, expect, it } from 'vitest'
import { createRpcClient } from '@/services/near/rpc'
import { createFakeChain } from '@/services/real/testing/fakeChain'
import { blockHashOf } from '@/services/real/testing/fakeRuntime'
import { createChainAccess } from './chain'

type Answer = { error: { name?: string; cause?: { name: string } } } | { result: unknown } | 'down'

/** An RPC endpoint per URL answering send_tx (and block/genesis) as told. */
function endpoints(answers: Record<string, Answer>, blocks: { head: number; oldest: number }) {
  const hits: string[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> }
    hits.push(`${url} ${body.method}`)
    const reply = (x: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...(x as object) }), { status: 200 })
    if (body.method === 'EXPERIMENTAL_genesis_config') return reply({ result: { transaction_validity_period: 86_400 } })
    if (body.method === 'block') {
      const h = typeof body.params.block_id === 'number' ? body.params.block_id : blocks.head
      if (h < blocks.oldest) return reply({ error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_BLOCK' } } })
      return reply({ result: { header: { height: h, hash: blockHashOf(h) } } })
    }
    const a = answers[url]
    if (!a || a === 'down') return new Response('bad gateway', { status: 502 })
    return reply(a)
  }) as typeof fetch
  return { fetchImpl, hits }
}

const access = (urls: string[], fetchImpl: typeof fetch) => createChainAccess({ rpc: createRpcClient({ urls, fetch: fetchImpl }), fetch: fetchImpl })
const invalid = { error: { name: 'HANDLER_ERROR', cause: { name: 'INVALID_TRANSACTION' } } }
const timeout = { error: { name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR' } } }

describe('sending signed bytes', () => {
  it('refused outright by the first node: can never land', async () => {
    const e = endpoints({ 'https://a': invalid }, { head: 100_000, oldest: 1 })
    expect((await access(['https://a', 'https://b'], e.fetchImpl).send('AAAA')).kind).toBe('rejected')
    const parse = endpoints({ 'https://a': { error: { name: 'REQUEST_VALIDATION_ERROR', cause: { name: 'PARSE_ERROR' } } } }, { head: 100_000, oldest: 1 })
    expect((await access(['https://a'], parse.fetchImpl).send('AAAA')).kind).toBe('rejected')
  })

  it('a node that timed out may have forwarded it: a later "invalid" (nonce used) is unclear, not a refusal', async () => {
    const e = endpoints({ 'https://a': 'down', 'https://b': invalid }, { head: 100_000, oldest: 1 })
    const r = await access(['https://a', 'https://b'], e.fetchImpl).send('AAAA')
    expect(r.kind).toBe('unknown')
    // The same bytes went to the next node: same hash, same nonce, executed at most once.
    expect(e.hits.filter((h) => h.endsWith('send_tx'))).toEqual(['https://a send_tx', 'https://b send_tx'])
  })

  it('a TIMEOUT answer is unclear and stops there', async () => {
    const e = endpoints({ 'https://a': timeout, 'https://b': invalid }, { head: 100_000, oldest: 1 })
    expect((await access(['https://a', 'https://b'], e.fetchImpl).send('AAAA')).kind).toBe('unknown')
    expect(e.hits.filter((h) => h.endsWith('send_tx'))).toHaveLength(1)
  })
})

describe('anchoring', () => {
  it('names a block ~600 blocks from the end of its validity, so a lost transaction expires in minutes', async () => {
    const e = endpoints({}, { head: 200_000, oldest: 1 })
    const a = await access(['https://a'], e.fetchImpl).anchor()
    expect(a.height).toBe(200_000 - (86_400 - 600))
    expect(a.expiresHeight - 200_000).toBe(600)
  })

  it('falls back to the newest final block when the old one isn’t served', async () => {
    const e = endpoints({}, { head: 200_000, oldest: 150_000 })
    const a = await access(['https://a'], e.fetchImpl).anchor()
    expect(a).toMatchObject({ height: 200_000, expiresHeight: 286_400 })
  })
})

describe('what a wallet can spend', () => {
  const chainWith = (amount: bigint, storageUsage: number) => {
    const chain = createFakeChain({ accounts: { 'alice.testnet': { amount, storageUsage } } })
    return createChainAccess({ rpc: createRpcClient({ urls: ['https://rpc.test'], fetch: chain.fetch }), fetch: chain.fetch })
  }

  it('is the balance less the storage the account must keep; nothing for an account that does not exist', async () => {
    // A zero-balance account (≤ 770 bytes) keeps nothing back; a larger one keeps 1e19 yocto per byte.
    expect(await chainWith(5n * 10n ** 24n, 182).available('alice.testnet')).toBe(5n * 10n ** 24n)
    expect(await chainWith(5n * 10n ** 24n, 1000).available('alice.testnet')).toBe(5n * 10n ** 24n - 1000n * 10n ** 19n)
    expect(await chainWith(5n * 10n ** 24n, 182).available('ghost.testnet')).toBeNull()
  })
})

describe('a transaction as it runs', () => {
  const running = {
    final_execution_status: 'INCLUDED_FINAL',
    status: 'Started',
    transaction: { hash: 'H1', signer_id: 'alice.testnet', receiver_id: 'wrap.testnet' },
    transaction_outcome: {
      id: 'H1',
      outcome: { logs: [], receipt_ids: ['r1'], gas_burnt: 1, tokens_burnt: '0', executor_id: 'alice.testnet', status: { SuccessReceiptId: 'r1' } },
    },
    receipts_outcome: [{ id: 'r1', outcome: { logs: ['delivered'], receipt_ids: [], gas_burnt: 1, tokens_burnt: '0', executor_id: 'wrap.testnet', status: { SuccessValue: '' } } }],
  }

  it('reads the receipts so far without waiting for the transaction to finish, and never calls it final', async () => {
    const chain = createFakeChain()
    chain.settle('H1', running)
    const a = createChainAccess({ rpc: createRpcClient({ urls: ['https://rpc.test'], fetch: chain.fetch }), fetch: chain.fetch })
    expect(await a.progress('H1', 'alice.testnet')).toMatchObject({ final_execution_status: 'INCLUDED_FINAL', receipts_outcome: [{ id: 'r1' }] })
    expect(chain.rpcCalls('EXPERIMENTAL_tx_status').at(-1)?.params).toMatchObject({ tx_hash: 'H1', wait_until: 'NONE' })
    // Not final: status() still answers null.
    expect(await a.status('H1', 'alice.testnet')).toBeNull()
  })

  it('answers null for a transaction the chain doesn’t know yet', async () => {
    const chain = createFakeChain()
    const a = createChainAccess({ rpc: createRpcClient({ urls: ['https://rpc.test'], fetch: chain.fetch }), fetch: chain.fetch })
    expect(await a.progress('NOPE', 'alice.testnet')).toBeNull()
  })
})
