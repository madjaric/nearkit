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

/**
 * Where the page was opened from, read from its address:
 * - `outside`: no launch data, so not Telegram (a browser, a copied link);
 * - `direct`: Telegram's signed launch data with no request to approve (the bot's Open button,
 *   the main Mini App);
 * - `approval`: the launch data carries a request's digest as the start parameter Telegram
 *   signed (the Approve button in the chat, `startapp=<digest>`), or the direct-link parameter.
 * Being inside Telegram never makes an approval: only the digest does, and the signer checks
 * Telegram's signature over it.
 */
export type TelegramLaunchContext = { kind: 'outside' } | { kind: 'direct'; initData: string } | { kind: 'approval'; launch: TelegramLaunch }

export function telegramLaunchContext(hash: string, search: string): TelegramLaunchContext {
  const initData = new URLSearchParams(hash.replace(/^#/, '')).get('tgWebAppData')
  if (!initData) return { kind: 'outside' }
  const startParam = new URLSearchParams(initData).get('start_param') ?? new URLSearchParams(search).get('tgWebAppStartParam') ?? ''
  return /^[A-Za-z0-9_-]{43}$/.test(startParam) ? { kind: 'approval', launch: { initData, startParam } } : { kind: 'direct', initData }
}

/** The approval launch in this page's address (`#tgWebAppData=…`), or null outside Telegram or without a request's digest. */
export function readTelegramLaunch(hash: string, search: string): TelegramLaunch | null {
  const context = telegramLaunchContext(hash, search)
  return context.kind === 'approval' ? context.launch : null
}

/** Why the page must not offer to approve `r`, or null when it is exactly the request the link names, on this network. */
export async function telegramRequestProblem(r: TelegramRequestView, want: { digest: string; network: string }): Promise<string | null> {
  if (r.network !== want.network) return `This request is for ${r.network}, but this NEARKITS runs on ${want.network}.`
  if (r.digest !== want.digest || (await telegramApprovalDigest(r)) !== want.digest)
    return 'This request doesn’t match the link you opened. Don’t approve it: start again in Telegram.'
  return null
}

export const fetchTelegramRequest = (apiUrl: string, digest: string, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) =>
  apiPost<{ request: TelegramRequestView | null; status: 'open' | 'used' | 'expired' | null; walletName: string | null }>(apiUrl, '/api/telegram/request', { digest }, fetchImpl)

export const sendTelegramApproval = (apiUrl: string, initData: string, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) =>
  apiPost<{ kind: TelegramRequestView['kind']; accountId: string; target: string }>(apiUrl, '/api/telegram/approve', { initData }, fetchImpl)
