import { createRpcClient } from '@/services/near/rpc'

/**
 * Every process that talks to NEAR checks at start that each configured RPC provider
 * really serves the network it was configured for (`status` → `chain_id`). A mainnet
 * process pointed at a testnet provider (or the reverse) refuses to start: that mistake
 * must never surface as balances or signatures on the wrong chain.
 *
 * A provider that doesn't answer is reported, not fatal (it may be down briefly); one
 * that answers with the other chain is fatal.
 */
export async function checkChainIds(urls: readonly string[], expected: 'mainnet' | 'testnet', fetchImpl?: typeof fetch): Promise<{ unreachable: string[] }> {
  const unreachable: string[] = []
  const wrong: string[] = []
  await Promise.all(
    urls.map(async (url) => {
      try {
        const status = await createRpcClient({ urls: [url], fetch: fetchImpl, timeoutMs: 8_000 }).call<{ chain_id?: unknown }>('status', [])
        if (status?.chain_id !== expected) wrong.push(`${url} serves ${String(status?.chain_id)}`)
      } catch {
        unreachable.push(url)
      }
    }),
  )
  if (wrong.length) throw new Error(`RPC providers on the wrong network (expected ${expected}): ${wrong.join('; ')}`)
  return { unreachable }
}
