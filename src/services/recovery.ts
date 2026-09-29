import { exportKeyFingerprint, type SealedExport } from '@/lib/exportCrypto'
import { apiPost } from './telegramLink'

/**
 * The web half of keeping NearKit wallets yours, with or without Telegram
 * (server/src/api/recoveryRoutes.ts). Every request is authorized by the wallet's owner
 * signing a one-time message that NearKit's signer wrote. Before the wallet is asked to
 * sign, this page checks the message says exactly what the user is doing; an exported
 * key arrives sealed to a key that exists only in this page.
 */

export type RecoverTarget = { kind: 'list' } | { kind: 'export'; wallet: string } | { kind: 'approve'; wallet: string; destination: string }

const ACCOUNT = '[0-9a-z_.-]{2,64}'

/** The page's fragment (public data only: a wallet address, a destination). It never reaches a server log. */
export function readRecoverHash(hash: string): RecoverTarget {
  const wallet = new RegExp(`^#wallet=(${ACCOUNT})$`).exec(hash)
  if (wallet) return { kind: 'export', wallet: wallet[1] as string }
  const approve = new RegExp(`^#approve=(${ACCOUNT})&to=([^&#]{2,200})$`).exec(hash)
  if (approve) {
    let destination = ''
    try {
      destination = decodeURIComponent(approve[2] as string)
    } catch {
      return { kind: 'list' }
    }
    if (new RegExp(`^${ACCOUNT}$`).test(destination)) return { kind: 'approve', wallet: approve[1] as string, destination }
  }
  return { kind: 'list' }
}

export interface OwnerChallenge {
  id: string
  kind: 'owner-session' | 'export' | 'approve-destination'
  message: string
  /** Base64 of the 32-byte NEP-413 nonce. */
  nonce: string
  recipient: string
  expiresAt: number
  ownerAccount: string
  accountId: string | null
  destination: string | null
}

export interface OwnerProof {
  challengeId: string
  publicKey: string
  signature: string
}

function fieldsOf(message: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const line of message.split('\n').slice(1)) {
    if (!line) break
    const at = line.indexOf(': ')
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 2)
  }
  return fields
}

/**
 * Why this page must not have the wallet sign `c`, or null when it says exactly what
 * the user asked for: this operation, this wallet, this destination or this page's own
 * key, this network, this site as the recipient.
 */
export async function challengeProblem(
  c: OwnerChallenge,
  want: { kind: OwnerChallenge['kind']; network: string; recipient: string; owner?: string; wallet?: string; destination?: string; recipientKey?: string },
): Promise<string | null> {
  const f = fieldsOf(c.message)
  if (c.kind !== want.kind) return 'NearKit answered with a different kind of request.'
  if (c.recipient !== want.recipient) return `This request is for another site (${c.recipient}), not this one.`
  if (f['Network'] !== want.network) return `This request is for ${f['Network'] ?? 'another network'}, but this NearKit runs on ${want.network}.`
  if (f['Request'] !== c.id || f['Owner wallet'] !== c.ownerAccount) return 'This request is malformed. Start again.'
  if (want.owner !== undefined && c.ownerAccount !== want.owner) return `This request is for ${c.ownerAccount}, not ${want.owner}.`
  if (want.wallet !== undefined && (f['NearKit wallet'] !== want.wallet || c.accountId !== want.wallet)) return 'This request names another NearKit wallet.'
  if (want.destination !== undefined && (f['Destination'] !== want.destination || c.destination !== want.destination)) return 'This request names another destination.'
  if (want.recipientKey !== undefined && f['Browser key'] !== (await exportKeyFingerprint(want.recipientKey)))
    return 'This request would send the key to another browser. Nothing was signed.'
  return null
}

export const requestChallenge = (
  apiUrl: string,
  body:
    | { kind: 'owner-session'; owner: string }
    | { kind: 'export'; accountId: string; recipientKey: string }
    | { kind: 'approve-destination'; accountId: string; destination: string },
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
) => apiPost<OwnerChallenge>(apiUrl, '/api/recovery/challenge', body, fetchImpl)

export const listOwnerWallets = (apiUrl: string, proof: OwnerProof, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) =>
  apiPost<{ ownerAccount: string; network: string; wallets: { accountId: string; name: string; createdAt: number }[] }>(apiUrl, '/api/recovery/wallets', proof, fetchImpl)

export const exportSealedKey = (apiUrl: string, proof: OwnerProof, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) =>
  apiPost<{ accountId: string; publicKey: string; sealed: SealedExport }>(apiUrl, '/api/recovery/export', proof, fetchImpl)

export const approveDestination = (apiUrl: string, proof: OwnerProof, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) =>
  apiPost<{ accountId: string; destination: string }>(apiUrl, '/api/recovery/destination', proof, fetchImpl)
