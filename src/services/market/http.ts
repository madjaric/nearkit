/**
 * Reading public market-data APIs (DEX Screener, GeckoTerminal, CoinGecko) from the browser:
 * one GET with a timeout, and an HTTP failure that keeps its status, so a rate limit (429) is
 * told apart from an outage and from a token the source simply doesn't index (404).
 */

const TIMEOUT_MS = 8000

export class MarketSourceError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message)
    this.name = 'MarketSourceError'
  }
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A finite number from a number or a numeric string; anything else (missing, "N/A", NaN) is null. */
export function numberOrNull(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
  return Number.isFinite(n) ? n : null
}

/**
 * GET JSON. A 404 is `null` when `notFound` says the source answers that way for things it
 * doesn't index; any other failure is a MarketSourceError with the HTTP status (null when the
 * request never got an answer).
 */
export async function getMarketJson(fetchImpl: typeof fetch, url: string, opts: { notFound?: 'null' } = {}): Promise<unknown> {
  const host = new URL(url).hostname
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let res: Response
  try {
    res = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } })
  } catch (e) {
    throw new MarketSourceError(`${host} didn’t answer (${e instanceof Error ? e.message : String(e)})`)
  } finally {
    clearTimeout(timer)
  }
  if (res.status === 404 && opts.notFound === 'null') return null
  if (res.status === 429) throw new MarketSourceError(`${host} is rate-limiting requests right now`, 429)
  if (!res.ok) throw new MarketSourceError(`${host} answered HTTP ${res.status}`, res.status)
  try {
    return (await res.json()) as unknown
  } catch {
    throw new MarketSourceError(`${host} returned something that isn’t JSON`, res.status)
  }
}
