import { base64UrlEncode } from './encoding'

/**
 * Something NearKit's signer asks a wallet's Telegram account to approve in NearKit's Mini
 * App: for a wallet with no owner wallet, a withdrawal address or the wallet's first owner.
 *
 * The Mini App opens with `startapp=<digest>`, and Telegram signs that start parameter into
 * the launch data it hands the page. The digest therefore ties Telegram's signature to exactly
 * this request. The page shows a request only if it hashes to the start parameter, and the
 * signer accepts Telegram's signature only for the request it hashes to.
 */
export interface TelegramApprovalRequest {
  id: string
  kind: 'destination' | 'bind-owner'
  network: string
  /** The NearKit wallet. */
  accountId: string
  /** The withdrawal address, or the account that becomes the wallet's owner. */
  target: string
  expiresAt: number
}

/** Every field is a NEAR account, a network, a fixed kind or base64url: none can contain `|`. */
const text = (r: TelegramApprovalRequest) => ['nearkit:telegram-approval:v1', r.kind, r.network, r.accountId, r.target, r.id, String(r.expiresAt)].join('|')

/** base64url of SHA-256 of the request: 43 characters, within Telegram's start parameter. */
export async function telegramApprovalDigest(r: TelegramApprovalRequest): Promise<string> {
  return base64UrlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text(r)))))
}
