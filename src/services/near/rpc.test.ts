import { describe, expect, it, vi } from 'vitest'
import { createRpcClient, decodeBase64Json, encodeArgs, RpcError } from './rpc'

type Handler = (url: string, body: { method: string; params: unknown }) => { status?: number; json?: unknown; throws?: Error; hang?: boolean }

function fakeFetch(handler: Handler) {
  const calls: { url: string; method: string; params: unknown }[] = []
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown }
    calls.push({ url, method: body.method, params: body.params })
    const r = handler(url, body)
    if (r.throws) throw r.throws
    if (r.hang) {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    }
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } })
  })
  return { fetch: fn as unknown as typeof fetch, calls }
}

const bytes = (value: unknown) => Array.from(new TextEncoder().encode(JSON.stringify(value)))

describe('RPC client', () => {
  it('reads an account with the requested finality', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      json: {
        jsonrpc: '2.0',
        id: 1,
        result: { amount: '5000000000000000000000000', locked: '0', code_hash: '11111111111111111111111111111111', storage_usage: 182, block_height: 1, block_hash: 'h' },
      },
    }))
    const rpc = createRpcClient({ urls: ['https://a.example'], fetch })
    const account = await rpc.viewAccount('alice.near', 'final')
    expect(account.amount).toBe('5000000000000000000000000')
    expect(calls[0]).toMatchObject({ method: 'query', params: { request_type: 'view_account', account_id: 'alice.near', finality: 'final' } })
  })

  it('encodes view args as base64 JSON and decodes the byte-array result', async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: { result: { result: bytes({ total: '1250000000000000000000', available: '0' }), logs: [] } } }))
    const rpc = createRpcClient({ urls: ['https://a.example'], fetch })
    const out = await rpc.viewFunction<{ total: string }>('wrap.near', 'storage_balance_of', { account_id: 'bob.near' })
    expect(out).toEqual({ total: '1250000000000000000000', available: '0' })
    const params = calls[0]?.params as { args_base64: string; method_name: string; request_type: string; finality: string }
    expect(params.request_type).toBe('call_function')
    expect(params.method_name).toBe('storage_balance_of')
    expect(params.finality).toBe('optimistic')
    expect(decodeBase64Json(params.args_base64)).toEqual({ account_id: 'bob.near' })
  })

  it('returns null for a view that yields the JSON literal null or no bytes', async () => {
    const { fetch } = fakeFetch((_, body) => ({ json: { result: { result: (body.params as { method_name: string }).method_name === 'a' ? bytes(null) : [] } } }))
    const rpc = createRpcClient({ urls: ['https://a.example'], fetch })
    expect(await rpc.viewFunction('t.near', 'a', {})).toBeNull()
    expect(await rpc.viewFunction('t.near', 'b', {})).toBeNull()
  })

  it('treats an error string inside the result as a contract error, without failover', async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: { result: { error: 'wasm execution failed with error: MethodResolveError(MethodNotFound)', logs: [] } } }))
    const rpc = createRpcClient({ urls: ['https://a.example', 'https://b.example'], fetch })
    await expect(rpc.viewFunction('t.near', 'nope', {})).rejects.toMatchObject({ kind: 'contract', message: expect.stringMatching(/MethodNotFound/) })
    expect(calls).toHaveLength(1)
  })

  it('fails over on HTTP errors, rate limits and network failures, in order', async () => {
    const seen: string[] = []
    const { fetch } = fakeFetch((url) => {
      seen.push(url)
      if (url.startsWith('https://a')) return { status: 503 }
      if (url.startsWith('https://b')) return { json: { error: { code: -429, message: 'Rate limits exceeded' } } }
      if (url.startsWith('https://c')) return { throws: new TypeError('Failed to fetch') }
      return { json: { result: { ok: true } } }
    })
    const rpc = createRpcClient({ urls: ['https://a.example', 'https://b.example', 'https://c.example', 'https://d.example'], fetch })
    expect(await rpc.call('status', [])).toEqual({ ok: true })
    expect(seen).toEqual(['https://a.example', 'https://b.example', 'https://c.example', 'https://d.example'])
  })

  it('fails over when an endpoint hangs past the timeout', async () => {
    const { fetch } = fakeFetch((url) => (url.startsWith('https://slow') ? { hang: true } : { json: { result: 'fast' } }))
    const rpc = createRpcClient({ urls: ['https://slow.example', 'https://fast.example'], fetch, timeoutMs: 20 })
    expect(await rpc.call('status', [])).toBe('fast')
  })

  it('does not fail over on a semantic error such as an unknown account', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      json: {
        error: {
          name: 'HANDLER_ERROR',
          code: -32000,
          message: 'Server error',
          data: 'account x.near does not exist while viewing',
          cause: { name: 'UNKNOWN_ACCOUNT', info: { requested_account_id: 'x.near' } },
        },
      },
    }))
    const rpc = createRpcClient({ urls: ['https://a.example', 'https://b.example'], fetch })
    const error = await rpc.viewAccount('x.near').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RpcError)
    expect(error).toMatchObject({ kind: 'handler', causeName: 'UNKNOWN_ACCOUNT' })
    expect(calls).toHaveLength(1)
  })

  it('reports a transport error after every endpoint failed', async () => {
    const { fetch } = fakeFetch(() => ({ status: 502 }))
    const rpc = createRpcClient({ urls: ['https://a.example', 'https://b.example'], fetch })
    await expect(rpc.call('status', [])).rejects.toMatchObject({ kind: 'transport' })
  })

  it('asks for transaction status with EXPERIMENTAL_tx_status and the requested wait level', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      json: { result: { final_execution_status: 'FINAL', status: { SuccessValue: '' }, transaction: { hash: 'H' }, receipts_outcome: [] } },
    }))
    const rpc = createRpcClient({ urls: ['https://a.example'], fetch })
    await rpc.txStatus('H', 'alice.near', 'FINAL')
    expect(calls[0]).toMatchObject({ method: 'EXPERIMENTAL_tx_status', params: { tx_hash: 'H', sender_account_id: 'alice.near', wait_until: 'FINAL' } })
  })
})

describe('arg encoding', () => {
  it('encodes UTF-8 JSON args as base64', () => {
    expect(encodeArgs({})).toBe('e30=')
    expect(decodeBase64Json(encodeArgs({ memo: 'naïve ✓' }))).toEqual({ memo: 'naïve ✓' })
  })
})
