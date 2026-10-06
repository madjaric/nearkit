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

const LINK_HEADER = 'NearKit: link this NEAR account to Telegram'
const LINK_FOOTER = 'Only sign this if you asked the NearKit bot for this link yourself. Signing is free and moves no funds.'

/**
 * Why the link page must not have the wallet sign `d`, or null when it is exactly a link request
 * (server/src/link/service.ts `linkMessage`) for this site and network. The API's answer is not
 * trusted: an owner's request (an export, an approval) carries the same recipient, so a message of
 * any other shape is never signed here.
 */
export function linkMessageProblem(d: LinkDescription, want: { network: string; recipient: string }): string | null {
  if (d.recipient !== want.recipient) return `This request is for another site (${d.recipient}), not this one.`
  const lines = d.message.split('\n')
  if (lines.length !== 5 || lines[0] !== LINK_HEADER || !lines[1]?.startsWith('Telegram: ') || lines[3] !== '' || lines[4] !== LINK_FOOTER)
    return 'This is not a link request. Nothing was signed: ask the bot for a new link with /link.'
  if (lines[2] !== `Network: ${want.network}` || d.network !== want.network)
    return `This request is for ${d.network === want.network ? lines[2]?.slice(9) : d.network}, but this NEARKITS runs on ${want.network}.`
  return null
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
    /** Facts the server sent with the error (e.g. how an address gets approved). */
    readonly detail: Record<string, unknown> | null = null,
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

/** POST JSON to the NearKit API; its errors come back as LinkRequestError (status, code, a sentence for people). */
export async function apiPost<T>(apiUrl: string, path: string, body: unknown, fetchImpl: typeof fetch): Promise<T> {
  let res: Response
  try {
    res = await fetchImpl(`${apiUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  } catch {
    throw new LinkRequestError(0, 'unreachable', 'The NEARKITS server can’t be reached right now. Try again in a moment.')
  }
  let json: unknown = null
  try {
    json = await res.json()
  } catch {
    // handled below
  }
  if (res.ok && json !== null) return json as T
  const err = (json as { error?: { code?: unknown; message?: unknown; detail?: unknown } } | null)?.error
  throw new LinkRequestError(
    res.status,
    typeof err?.code === 'string' ? err.code : 'error',
    typeof err?.message === 'string' ? err.message : `The NEARKITS server answered ${res.status}. Try again in a moment.`,
    typeof err?.detail === 'object' && err.detail !== null && !Array.isArray(err.detail) ? (err.detail as Record<string, unknown>) : null,
  )
}

export const describeLink = (apiUrl: string, code: string, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) =>
  apiPost<LinkDescription>(apiUrl, '/api/link/describe', { code }, fetchImpl)

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
  apiPost<HandoffInfo>(apiUrl, '/api/handoff/describe', { id }, fetchImpl)

/** Tells the NearKit server what the wallet signed; it checks each hash on chain before telling Telegram. */
export const reportHandoff = (apiUrl: string, id: string, txHashes: string[], fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) =>
  apiPost<{ status: HandoffInfo['status']; outcome: 'traded' | 'no-trade' | 'failed' | null }>(apiUrl, '/api/handoff/result', { id, txHashes }, fetchImpl)

export const confirmLink = (
  apiUrl: string,
  body: { code: string; accountId: string; publicKey: string; signature: string },
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
) => apiPost<LinkResult>(apiUrl, '/api/link/confirm', body, fetchImpl)

// ─── NearKit wallet key export ───────────────────────────────────────────────

/**
 * `#recover=<code>`: export links from before recovery moved to /recover. The code means
 * nothing any more; the page sends the user to /recover instead.
 */
export function readRecoverCode(hash: string): string | null {
  const m = /^#recover=([A-Za-z0-9_-]{16,64})$/.exec(hash)
  return m ? (m[1] as string) : null
}
