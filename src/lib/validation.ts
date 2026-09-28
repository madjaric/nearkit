/**
 * NEAR account ID rules (nomicon.io/DataStructures/Account, near-account-id-rs):
 * 2–64 chars, lowercase a-z 0-9 with `-` `_` `.` separators, no leading/trailing or
 * doubled separators. Special formats: 64 hex = NEAR-implicit, `0x` + 40 hex =
 * ETH-implicit, `0s` + 40 hex = deterministic, `0u` + 52 base32 = universal (testnet).
 */
const NAMED = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/
const IMPLICIT = /^[0-9a-f]{64}$/
const ETH_IMPLICIT = /^0x[0-9a-f]{40}$/
const DETERMINISTIC = /^0s[0-9a-f]{40}$/
const UNIVERSAL = /^0u[0-9a-hjkmnp-tv-z]{52}$/

export type AccountKind = 'named' | 'implicit' | 'eth-implicit' | 'deterministic' | 'universal'

export function accountKind(id: string): AccountKind | null {
  if (IMPLICIT.test(id)) return 'implicit'
  if (ETH_IMPLICIT.test(id)) return 'eth-implicit'
  if (DETERMINISTIC.test(id)) return 'deterministic'
  if (UNIVERSAL.test(id)) return 'universal'
  if (id.length >= 2 && id.length <= 64 && NAMED.test(id)) return 'named'
  return null
}

/**
 * Which network a named account's suffix belongs to. Implicit IDs and other
 * top-level suffixes (e.g. `.tg` on mainnet) carry no network hint.
 */
export function accountNetworkHint(id: string): 'mainnet' | 'testnet' | null {
  if (accountKind(id) !== 'named') return null
  if (id === 'testnet' || id.endsWith('.testnet')) return 'testnet'
  if (id === 'near' || id.endsWith('.near')) return 'mainnet'
  return null
}

/** True when the account ID's own suffix says it lives on the other network. */
export function isForeignToNetwork(id: string, network: 'mainnet' | 'testnet'): boolean {
  const hint = accountNetworkHint(id)
  return hint !== null && hint !== network
}

export function isValidAccountId(id: string): boolean {
  return accountKind(id) !== null
}

/** Human explanation of why an account ID is invalid, or null when it is valid. */
export function accountIdError(raw: string): string | null {
  const id = raw.trim()
  if (!id) return 'Enter a NEAR account'
  if (isValidAccountId(id)) return null
  if (/[A-Z]/.test(id)) return 'Account IDs are lowercase'
  if (/\s/.test(id)) return 'Account IDs cannot contain spaces'
  if (id.length < 2) return 'Too short: at least 2 characters'
  if (id.length > 64) return 'Too long: 64 characters maximum'
  if (/[^a-z0-9._-]/.test(id)) return 'Only a–z, 0–9 and - _ . are allowed'
  return 'Not a valid NEAR account ID'
}

export function isHexAccount(id: string): boolean {
  return IMPLICIT.test(id) || ETH_IMPLICIT.test(id)
}
