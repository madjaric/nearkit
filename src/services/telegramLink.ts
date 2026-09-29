/**
 * The web half of linking a Telegram account (the server half is
 * server/src/link/service.ts): read the one-time code from the page fragment,
 * ask the server what exactly to sign, and send back the wallet's signature.
 */

export interface LinkDescription {
  telegram: { name: string; username: string | null }
  network: string
  recipient: string
  message: string
  /** Base64 of the 32-byte NEP-413 nonce. */
  nonce: string
  expiresAt: number
}

export interface LinkResult {
  accountId: string
  telegram: { name: string; username: string | null }
  network: string
}

export class LinkRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'LinkRequestError'
  }
}

/** `#link=<code>` → code; anything else → null. The fragment never reaches a server log. */
export function readLinkCode(hash: string): string | null {
  const m = /^#link=([A-Za-z0-9_-]{16,64})$/.exec(hash)
  return m ? (m[1] as string) : null
}

async function post<T>(apiUrl: string, path: string, body: unknown, fetchImpl: typeof fetch): Promise<T> {
  let res: Response
  try {
    res = await fetchImpl(`${apiUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  } catch {
    throw new LinkRequestError(0, 'unreachable', 'The NearKit server can’t be reached right now. Try again in a moment.')
  }
  let json: unknown = null
  try {
    json = await res.json()
  } catch {
    // handled below
  }
  if (res.ok && json !== null) return json as T
  const err = (json as { error?: { code?: unknown; message?: unknown } } | null)?.error
  throw new LinkRequestError(
    res.status,
    typeof err?.code === 'string' ? err.code : 'error',
    typeof err?.message === 'string' ? err.message : `The NearKit server answered ${res.status}. Try again in a moment.`,
  )
}

export const describeLink = (apiUrl: string, code: string, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) =>
  post<LinkDescription>(apiUrl, '/api/link/describe', { code }, fetchImpl)

// ─── trades prepared in Telegram ─────────────────────────────────────────────

export interface HandoffInfo {
  /** The linked account the trade was prepared for; the server only accepts its signatures. */
  accountId: string
  network: string
  status: 'open' | 'confirmed' | 'failed'
  expiresAt: number
}

/** `?tg=<id>` on the swap page: a trade prepared in Telegram. */
export function readHandoffId(value: string | null): string | null {
  return value && /^[A-Za-z0-9_-]{16,64}$/.test(value) ? value : null
}

export const describeHandoff = (apiUrl: string, id: string, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) =>
  post<HandoffInfo>(apiUrl, '/api/handoff/describe', { id }, fetchImpl)

/** Tells the NearKit server what the wallet signed; it checks each hash on chain before telling Telegram. */
export const reportHandoff = (apiUrl: string, id: string, txHashes: string[], fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) =>
  post<{ status: HandoffInfo['status']; outcome: 'traded' | 'no-trade' | 'failed' | null }>(apiUrl, '/api/handoff/result', { id, txHashes }, fetchImpl)

export const confirmLink = (
  apiUrl: string,
  body: { code: string; accountId: string; publicKey: string; signature: string },
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
) => post<LinkResult>(apiUrl, '/api/link/confirm', body, fetchImpl)

// ─── NearKit wallet key export ───────────────────────────────────────────────

export interface RecoveryDescription {
  telegram: { name: string; username: string | null }
  network: string
  /** The NearKit wallet whose key would be exported. */
  wallet: string
  /** Linked accounts: one of them must sign. */
  accounts: string[]
  recipient: string
  message: string
  /** Base64 of the 32-byte NEP-413 nonce. */
  nonce: string
  expiresAt: number
}

export interface RecoveryExport {
  accountId: string
  publicKey: string
  /** The private key. Kept in memory only while the page shows it; never stored. */
  secretKey: string
}

/** `#recover=<code>` → code; anything else → null. The fragment never reaches a server log. */
export function readRecoverCode(hash: string): string | null {
  const m = /^#recover=([A-Za-z0-9_-]{16,64})$/.exec(hash)
  return m ? (m[1] as string) : null
}

export const describeRecovery = (apiUrl: string, code: string, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) =>
  post<RecoveryDescription>(apiUrl, '/api/recovery/describe', { code }, fetchImpl)

export const exportRecovery = (
  apiUrl: string,
  body: { code: string; accountId: string; publicKey: string; signature: string },
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
) => post<RecoveryExport>(apiUrl, '/api/recovery/export', body, fetchImpl)
