import { telegramApprovalDigest, type TelegramApprovalRequest } from '@/lib/telegramApproval'
import { apiPost } from './telegramLink'

/**
 * NearKit's Telegram Mini App: approving, from inside Telegram, something for a NearKit
 * wallet with no owner wallet (a withdrawal address, or the wallet's first owner).
 *
 * Telegram opens this page with its launch data in the address: who opened it, when, and
 * the link's start parameter, all signed by Telegram. The start parameter is the digest of
 * the request NearKit's signer wrote. The page shows a request only if it hashes to that
 * digest, so a server that lied about the request would be caught here. On Approve it sends
 * Telegram's signed data, which the signer checks.
 */

export interface TelegramRequestView extends TelegramApprovalRequest {
  digest: string
}

export interface TelegramLaunch {
  /** Telegram's signed launch data, exactly as received. */
  initData: string
  /** The link's `startapp`: the digest of the request to approve. */
  startParam: string
}

/** The launch in this page's address (`#tgWebAppData=…`), or null outside Telegram or without a request's digest. */
export function readTelegramLaunch(hash: string, search: string): TelegramLaunch | null {
  const initData = new URLSearchParams(hash.replace(/^#/, '')).get('tgWebAppData')
  if (!initData) return null
  const startParam = new URLSearchParams(initData).get('start_param') ?? new URLSearchParams(search).get('tgWebAppStartParam') ?? ''
  return /^[A-Za-z0-9_-]{43}$/.test(startParam) ? { initData, startParam } : null
}

/** Why the page must not offer to approve `r`, or null when it is exactly the request the link names, on this network. */
export async function telegramRequestProblem(r: TelegramRequestView, want: { digest: string; network: string }): Promise<string | null> {
  if (r.network !== want.network) return `This request is for ${r.network}, but this NearKit runs on ${want.network}.`
  if (r.digest !== want.digest || (await telegramApprovalDigest(r)) !== want.digest)
    return 'This request doesn’t match the link you opened. Don’t approve it: start again in Telegram.'
  return null
}

export const fetchTelegramRequest = (apiUrl: string, digest: string, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) =>
  apiPost<{ request: TelegramRequestView | null; status: 'open' | 'used' | 'expired' | null; walletName: string | null }>(apiUrl, '/api/telegram/request', { digest }, fetchImpl)

export const sendTelegramApproval = (apiUrl: string, initData: string, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) =>
  apiPost<{ kind: TelegramRequestView['kind']; accountId: string; target: string }>(apiUrl, '/api/telegram/approve', { initData }, fetchImpl)
