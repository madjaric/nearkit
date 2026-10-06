import { exportKeyFingerprint, type SealedExport } from '@/lib/exportCrypto'
import { apiPost } from './telegramLink'

/**
 * The web half of keeping NearKit wallets yours, with or without Telegram
 * (server/src/api/recoveryRoutes.ts). Every request is authorized by the wallet's owner
 * signing a one-time message that NearKit's signer wrote. Before the wallet is asked to
 * sign, this page checks the message says exactly what the user is doing. A key export is
 * held by NEARKITS (24 hours by default) while the wallet's Telegram account is told; it can
 * release it sooner or cancel it. The key then arrives sealed to a key that exists only in
 * this browser.
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
  if (c.kind !== want.kind) return 'NEARKITS answered with a different kind of request.'
  if (c.recipient !== want.recipient) return `This request is for another site (${c.recipient}), not this one.`
  if (f['Network'] !== want.network) return `This request is for ${f['Network'] ?? 'another network'}, but this NEARKITS runs on ${want.network}.`
  if (f['Request'] !== c.id || f['Owner wallet'] !== c.ownerAccount) return 'This request is malformed. Start again.'
  if (want.owner !== undefined && c.ownerAccount !== want.owner) return `This request is for ${c.ownerAccount}, not ${want.owner}.`
  if (want.wallet !== undefined && (f['NearKit wallet'] !== want.wallet || c.accountId !== want.wallet)) return 'This request names another NEARKITS wallet.'
  if (want.destination !== undefined && (f['Destination'] !== want.destination || c.destination !== want.destination)) return 'This request names another destination.'
  if (want.recipientKey !== undefined && f['Browser key'] !== (await exportKeyFingerprint(want.recipientKey)))
    return 'This request would send the key to another browser. Nothing was signed.'
  if (c.kind === 'export') {
    // The hold is part of what the owner signs: a request that would be released at once is not NEARKITS' own.
    const held = Date.parse(f['Held until'] ?? '')
    const collect = Date.parse(f['Collect by'] ?? '')
    if (!Number.isFinite(held) || !Number.isFinite(collect) || held < c.expiresAt || collect <= held)
      return 'This request doesn’t say how long NEARKITS holds the export. Nothing was signed.'
  }
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

/** A held key export, as the browser that asked for it sees it. */
export interface HeldExport {
  exportId: string
  accountId: string
  ownerAccount: string
  /** This browser's key, as the owner signed it and Telegram shows it. */
  browserKey: string
  /** held: waiting; ready: its time came, or the wallet's Telegram account released it sooner. */
  status: 'held' | 'ready' | 'collected' | 'cancelled' | 'expired'
  requestedAt: number
  releaseAt: number
  expiresAt: number
  confirmedAt: number | null
  cancelledAt: number | null
  cancelledBy: string | null
  collectedAt: number | null
}

/** The owner's signature asks for the export: NEARKITS holds it and tells the wallet's Telegram account. Nothing is released yet. */
export const requestExport = (apiUrl: string, proof: OwnerProof, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) =>
  apiPost<HeldExport>(apiUrl, '/api/recovery/export', proof, fetchImpl)

export const exportStatus = (apiUrl: string, exportId: string, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) =>
  apiPost<HeldExport>(apiUrl, '/api/recovery/export/status', { exportId }, fetchImpl)

/** Once released: the key, sealed to this browser's key for this export. Once. */
export const collectExport = (apiUrl: string, exportId: string, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) =>
  apiPost<{ exportId: string; accountId: string; publicKey: string; sealed: SealedExport; released: 'hold' | 'telegram' }>(
    apiUrl,
    '/api/recovery/export/collect',
    { exportId },
    fetchImpl,
  )

export const cancelExport = (apiUrl: string, exportId: string, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) =>
  apiPost<HeldExport>(apiUrl, '/api/recovery/export/cancel', { exportId }, fetchImpl)

export const approveDestination = (apiUrl: string, proof: OwnerProof, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) =>
  apiPost<{ accountId: string; destination: string }>(apiUrl, '/api/recovery/destination', proof, fetchImpl)
