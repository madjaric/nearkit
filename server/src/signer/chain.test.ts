import { describe, expect, it } from 'vitest'
import { ChainUncertainError, createSignerChain } from './chain'

/** RPC providers, each answering "is this key a full-access key?" its own way. */
function providers(answers: Record<string, 'full' | 'function-call' | 'missing' | 'down'>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    const answer = answers[url]
    if (answer === 'down' || answer === undefined) throw new Error('connect ECONNREFUSED')
    const body =
      answer === 'missing'
        ? { jsonrpc: '2.0', id: 1, error: { name: 'HANDLER_ERROR', message: 'Server error', cause: { name: 'UNKNOWN_ACCESS_KEY' } } }
        : { jsonrpc: '2.0', id: 1, result: { nonce: 5, permission: answer === 'full' ? 'FullAccess' : { FunctionCall: { receiver_id: 'x', method_names: [] } } } }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

const URLS = ['https://a.rpc', 'https://b.rpc', 'https://c.rpc']
const KEY = 'ed25519:Anu7LYDfpLtkP7E16LT9imXF694BdQaa9ufVkQiwTQxC'

describe('the signer asks several RPC providers', () => {
  it('decides when a quorum agrees, even with one provider down', async () => {
    const chain = createSignerChain({ rpcUrls: URLS, quorum: 2, fetch: providers({ 'https://a.rpc': 'full', 'https://b.rpc': 'full', 'https://c.rpc': 'down' }) })
    expect(await chain.permission('alice.near', KEY)).toBe('full')
  })

  it('one lying provider is enough to decide nothing', async () => {
    const chain = createSignerChain({ rpcUrls: URLS, quorum: 2, fetch: providers({ 'https://a.rpc': 'full', 'https://b.rpc': 'full', 'https://c.rpc': 'missing' }) })
    await expect(chain.permission('alice.near', KEY)).rejects.toThrow(ChainUncertainError)
    const fc = createSignerChain({ rpcUrls: URLS, quorum: 2, fetch: providers({ 'https://a.rpc': 'full', 'https://b.rpc': 'function-call', 'https://c.rpc': 'full' }) })
    await expect(fc.permission('alice.near', KEY)).rejects.toThrow(/disagree/)
  })

  it('too few answers decide nothing', async () => {
    const chain = createSignerChain({ rpcUrls: URLS, quorum: 2, fetch: providers({ 'https://a.rpc': 'full', 'https://b.rpc': 'down', 'https://c.rpc': 'down' }) })
    await expect(chain.permission('alice.near', KEY)).rejects.toThrow(/Too few/)
  })

  it('a quorum larger than the providers is a configuration error', () => {
    expect(() => createSignerChain({ rpcUrls: URLS.slice(0, 1), quorum: 2 })).toThrow(/quorum/)
  })
})
