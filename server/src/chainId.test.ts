import { describe, expect, it } from 'vitest'
import { checkChainIds } from './chainId'

const provider = (answers: Record<string, string | 'down'>): typeof fetch =>
  (async (input: RequestInfo | URL) => {
    const a = answers[String(input)]
    if (a === 'down' || a === undefined) throw new Error('ECONNREFUSED')
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { chain_id: a } }))
  }) as typeof fetch

describe('RPC providers serve the configured network', () => {
  it('passes when every answering provider is on the network; reports the silent ones', async () => {
    expect(await checkChainIds(['https://a', 'https://b'], 'mainnet', provider({ 'https://a': 'mainnet', 'https://b': 'down' }))).toEqual({ unreachable: ['https://b'] })
  })

  it('refuses to go on when one serves the other chain', async () => {
    await expect(checkChainIds(['https://a', 'https://b'], 'mainnet', provider({ 'https://a': 'mainnet', 'https://b': 'testnet' }))).rejects.toThrow(/https:\/\/b serves testnet/)
  })
})
