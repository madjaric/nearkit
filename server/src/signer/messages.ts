import type { ChallengeKind } from './store'

/**
 * The exact text an owner wallet signs (NEP-413) for each owner-authorized request. The
 * signer writes it, the wallet shows it, and the signer reads the same fields back out of
 * a stored approval before trusting it: every line binds one fact (the operation, the
 * network, the NearKit wallet, the destination or the browser key, the owner wallet, the
 * request and its expiry).
 */

const HEADERS: Record<ChallengeKind, string> = {
  'owner-session': 'NearKit: show the NearKit wallets of my wallet',
  export: 'NearKit: export the private key of my NearKit wallet',
  'approve-destination': 'NearKit: approve a withdrawal destination',
}

const FOOTERS: Record<ChallengeKind, string> = {
  'owner-session': 'Signing this shows which NearKit wallets answer to your wallet. It moves nothing.',
  export: 'Only sign this if you are exporting this key yourself, in this browser. Anyone who sees the exported key controls that wallet.',
  'approve-destination': 'Only sign this if you asked NearKit for this yourself. Once approved, withdrawals from this NearKit wallet may go to this destination.',
}

export interface MessageFacts {
  kind: ChallengeKind
  id: string
  network: string
  ownerAccount: string
  accountId: string | null
  destination: string | null
  /** Export: the fingerprint of the browser key the exported key is sealed to. */
  browserKey: string | null
  expiresAt: number
}

export function challengeMessage(f: MessageFacts): string {
  return [
    HEADERS[f.kind],
    ...(f.accountId ? [`NearKit wallet: ${f.accountId}`] : []),
    ...(f.destination ? [`Destination: ${f.destination}`] : []),
    ...(f.browserKey ? [`Browser key: ${f.browserKey}`] : []),
    `Owner wallet: ${f.ownerAccount}`,
    `Network: ${f.network}`,
    `Request: ${f.id}`,
    `Expires: ${new Date(f.expiresAt).toISOString()}`,
    '',
    FOOTERS[f.kind],
  ].join('\n')
}

/** The facts a message states, or null when it isn't one of NearKit's owner messages. */
export function readMessage(message: string): { kind: ChallengeKind; fields: Record<string, string> } | null {
  const lines = message.split('\n')
  const kind = (Object.keys(HEADERS) as ChallengeKind[]).find((k) => HEADERS[k] === lines[0])
  if (!kind) return null
  const fields: Record<string, string> = {}
  for (const line of lines.slice(1)) {
    if (!line) break
    const at = line.indexOf(': ')
    if (at <= 0) return null
    const key = line.slice(0, at)
    if (key in fields) return null
    fields[key] = line.slice(at + 2)
  }
  return { kind, fields }
}
