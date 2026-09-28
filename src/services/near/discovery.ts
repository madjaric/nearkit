import type { NetworkConfig } from '@/config/networks'
import { isValidAccountId } from '@/lib/validation'
import { NearKitError } from './errors'

/**
 * Token discovery: which NEP-141 contracts an account holds. Indexers answer
 * this; RPC cannot enumerate holdings. Discovery only proposes candidates:
 * balances shown or acted on are verified with `ft_balance_of`.
 * Primary FastNEAR (fresh within seconds, keyless, CORS); fallback NearBlocks.
 */

export interface DiscoveredToken {
  contract: string
  /** Balance the indexer reports; verify on chain before relying on it. */
  raw: bigint
}

const TIMEOUT_MS = 8000

export async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

function collect(rows: unknown, contractKey: string, amountKey: string): DiscoveredToken[] {
  if (!Array.isArray(rows)) throw new Error('Unexpected discovery response')
  const out: DiscoveredToken[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const contract = (row as Record<string, unknown>)[contractKey]
    const amount = (row as Record<string, unknown>)[amountKey]
    if (typeof contract !== 'string' || !isValidAccountId(contract) || seen.has(contract)) continue
    if (typeof amount !== 'string' || !/^[0-9]+$/.test(amount) || /^0+$/.test(amount)) continue
    seen.add(contract)
    out.push({ contract, raw: BigInt(amount) })
  }
  return out
}

export async function discoverFtHoldings(fetchImpl: typeof fetch, network: NetworkConfig, accountId: string): Promise<DiscoveredToken[]> {
  const id = encodeURIComponent(accountId)
  const failures: string[] = []
  try {
    const body = (await getJson(fetchImpl, `${network.discovery.fastnearUrl}/v1/account/${id}/ft`)) as { tokens?: unknown }
    return collect(body?.tokens, 'contract_id', 'balance')
  } catch (e) {
    failures.push(e instanceof Error ? e.message : String(e))
  }
  try {
    if (network.discovery.nearblocksAssets === 'v3') {
      const body = (await getJson(fetchImpl, `${network.discovery.nearblocksUrl}/v3/accounts/${id}/assets/fts?limit=100`)) as { data?: unknown }
      return collect(body?.data, 'contract', 'amount')
    }
    const body = (await getJson(fetchImpl, `${network.discovery.nearblocksUrl}/v1/account/${id}/inventory`)) as { inventory?: { fts?: unknown } }
    return collect(body?.inventory?.fts, 'contract', 'amount')
  } catch (e) {
    failures.push(e instanceof Error ? e.message : String(e))
  }
  throw new NearKitError('RPC_ERROR', 'Token discovery is unavailable right now', { detail: failures.join('; ') })
}
