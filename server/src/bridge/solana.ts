import { isSolanaAddress } from '@/lib/bridge/addresses'
import { HttpError } from '../api/http'

/**
 * The two Solana reads Bridge & Buy's page needs to build a SOL transfer for the user's wallet: a
 * recent blockhash and the balance of the user's address. Asked here, of one Solana RPC (SOLANA_RPC_URL,
 * mainnet's public endpoint by default), so the page never depends on a public RPC's browser limits.
 * Nothing else is proxied: no method, address or URL comes from the client.
 */

export const SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com'

export interface SolanaReads {
  blockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>
  balance(address: string): Promise<bigint>
}

export function createSolanaReads(deps: { rpcUrl?: string; fetch: typeof fetch; now?: () => number }): SolanaReads {
  const url = deps.rpcUrl ?? SOLANA_RPC_URL
  const now = deps.now ?? Date.now
  let cached: { at: number; value: { blockhash: string; lastValidBlockHeight: number } } | null = null

  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    let res: Response
    try {
      res = await deps.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      throw new HttpError(503, 'solana', 'Solana isn’t answering right now. Try again in a moment.')
    }
    const json = (await res.json().catch(() => null)) as { result?: T; error?: unknown } | null
    if (!res.ok || !json || json.error !== undefined || json.result === undefined) throw new HttpError(503, 'solana', 'Solana isn’t answering right now. Try again in a moment.')
    return json.result
  }

  return {
    async blockhash() {
      // A blockhash is good for about a minute: one read serves every page for a few seconds.
      if (cached && now() - cached.at < 5_000) return cached.value
      const r = await rpc<{ value?: { blockhash?: unknown; lastValidBlockHeight?: unknown } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])
      const blockhash = r.value?.blockhash
      const height = r.value?.lastValidBlockHeight
      if (typeof blockhash !== 'string' || !isSolanaAddress(blockhash) || typeof height !== 'number') throw new HttpError(503, 'solana', 'Solana returned no blockhash.')
      cached = { at: now(), value: { blockhash, lastValidBlockHeight: height } }
      return cached.value
    },

    async balance(address: string) {
      if (!isSolanaAddress(address)) throw new HttpError(400, 'address', 'That isn’t a Solana address.')
      const r = await rpc<{ value?: unknown }>('getBalance', [address, { commitment: 'confirmed' }])
      if (typeof r.value !== 'number' || !Number.isSafeInteger(r.value) || r.value < 0) throw new HttpError(503, 'solana', 'Solana returned no balance.')
      return BigInt(r.value)
    },
  }
}
