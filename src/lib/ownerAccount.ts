import { base58Decode, hexEncode } from './encoding'
import { accountKind } from './validation'

/**
 * Which NEAR accounts a wallet is on, and whether it can sign for the owner of a NearKit wallet.
 *
 * A wallet hands NearKit a list of account values. Only NEAR account ids count: an EVM
 * address (`0x` + 40 hex, any case; NEAR's ETH-implicit ids are such addresses) is never
 * taken for a NEAR account, and neither is anything that isn't a NEAR account id. A
 * 64-character hex id is a NEAR implicit account, not an EVM address: every NearKit wallet
 * is one.
 *
 * An owner request is decided the way NearKit's signer decides it: by the key that signs. The
 * wallet can sign for the owner when it shares the owner account itself (exactly, by its id), or
 * when one of its accounts signs with a key that is, on chain right now, a full-access key of the
 * owner. Account ids stay exactly as the wallet gave them: no account is ever taken for another,
 * not even one a wallet app shows under the owner's name (a NearKit wallet whose exported key it
 * holds, say). After signing, the key that actually signed is what counts, whatever account the
 * wallet names with it. The signer checks all of it again, and decides.
 */

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/

export function isEvmAddress(value: string): boolean {
  return EVM_ADDRESS.test(value)
}

/** A wallet's account values, split: its NEAR accounts (in the wallet's order) and its EVM addresses. Anything else is dropped. */
export function walletAccounts(values: readonly string[]): { near: string[]; evm: string[] } {
  const near: string[] = []
  const evm: string[] = []
  for (const value of values) {
    if (isEvmAddress(value)) {
      if (!evm.includes(value)) evm.push(value)
    } else if (accountKind(value) !== null && !near.includes(value)) near.push(value)
  }
  return { near, evm }
}

/** The implicit account of an ed25519 public key (its 32 bytes in hex); null for anything that isn't such a key. */
export function implicitAccountOf(publicKey: string): string | null {
  if (!publicKey.startsWith('ed25519:')) return null
  const raw = base58Decode(publicKey.slice('ed25519:'.length))
  return raw && raw.length === 32 ? hexEncode(raw) : null
}

/** A key's permission on an account, as read on chain. */
export type KeyPermission = 'full' | 'function-call' | 'missing'

/** The key a wallet says one of its accounts signs with (NEAR Connect's `Account.publicKey`). */
export interface ReportedKey {
  accountId: string
  publicKey: string
}

export type OwnerControl =
  /** The wallet shares the owner account itself: it is asked to sign as the owner. */
  | { ok: true; via: 'account'; account: string }
  /** One of the wallet's accounts signs with a key that is a full-access key of the owner on chain: it is asked to sign as that account. */
  | { ok: true; via: 'key'; account: string; publicKey: string }
  /** No NEAR account and no EVM address: nothing is connected. */
  | { ok: false; reason: 'none' }
  /** Only an EVM address: no NEAR account to sign with. */
  | { ok: false; reason: 'evm-only'; evm: string }
  /** Not the owner, and the wallet didn't say which key it signs with: `account` is its first NEAR account. */
  | { ok: false; reason: 'no-key'; account: string }
  /** Not the owner, and the key it reports isn't a full-access key of the owner (no key of it at all, or only a limited one). */
  | { ok: false; reason: 'not-owner-key'; account: string; publicKey: string; permission: 'missing' | 'function-call' }
  /** The chain couldn't be asked about the key: refused, never assumed. */
  | { ok: false; reason: 'unchecked'; account: string; publicKey: string }

export type OwnerRefusal = Exclude<OwnerControl, { ok: true }>

/**
 * Can the wallet sign for `owner`? The owner account itself, by its exact id, wherever the wallet
 * lists it; otherwise the first of its NEAR accounts whose reported key is a full-access key of
 * the owner (`permission` reads it on chain). A lookup that failed refuses and outweighs a
 * "not a key" answer: it is never taken as either answer.
 */
export async function checkOwnerControl(
  wallet: { accounts: readonly string[]; keys?: readonly ReportedKey[] },
  owner: string,
  permission: (account: string, publicKey: string) => Promise<KeyPermission>,
): Promise<OwnerControl> {
  const { near, evm } = walletAccounts(wallet.accounts)
  if (near.includes(owner)) return { ok: true, via: 'account', account: owner }
  const first = near[0]
  if (first === undefined) return evm[0] === undefined ? { ok: false, reason: 'none' } : { ok: false, reason: 'evm-only', evm: evm[0] }
  let unchecked: OwnerRefusal | null = null
  let notOwner: OwnerRefusal | null = null
  for (const account of near) {
    const publicKey = wallet.keys?.find((k) => k.accountId === account)?.publicKey
    if (publicKey === undefined) continue
    let found: KeyPermission
    try {
      found = await permission(owner, publicKey)
    } catch {
      unchecked ??= { ok: false, reason: 'unchecked', account, publicKey }
      continue
    }
    if (found === 'full') return { ok: true, via: 'key', account, publicKey }
    notOwner ??= { ok: false, reason: 'not-owner-key', account, publicKey, permission: found }
  }
  return unchecked ?? notOwner ?? { ok: false, reason: 'no-key', account: first }
}

/**
 * Why the wallet can't sign for `owner`, and what to do, in a sentence or two. `nearkitWallet` is
 * the NearKit wallet the request is about, if any: a wallet connected as that very wallet, with its
 * own (exported) key, is told so.
 */
export function ownerControlProblem(r: OwnerRefusal, owner: string, nearkitWallet?: string): string {
  switch (r.reason) {
    case 'none':
      return `No NEAR account is connected. Connect ${owner}, the wallet this NEARKITS wallet was created with.`
    case 'evm-only':
      return `Your wallet returned an EVM address (${r.evm}), not a NEAR account. Switch to the NEAR account ${owner} in your wallet, then try again.`
    case 'no-key':
      return `Your wallet returned ${r.account}, not ${owner}, and didn’t say which key it signs with, so NEARKITS can’t tell whether it holds a key of ${owner}. Switch to ${owner} itself in your wallet; if it keeps returning the same account, remove NEARKITS from the wallet’s connected sites, then connect again.`
    case 'not-owner-key':
      if (r.permission === 'function-call')
        return `Your wallet is connected as ${r.account} and signs with ${r.publicKey}, which is only a limited (function-call) key of ${owner}. Owner requests need a full-access key of ${owner}: connect the wallet that holds one, then try again.`
      if (r.account === nearkitWallet && implicitAccountOf(r.publicKey) === r.account)
        return `Your wallet is connected as ${r.account}, your NEARKITS wallet itself: it signs with that wallet’s exported key (${r.publicKey}), which isn’t a key of ${owner}. Connect the wallet that holds ${owner}’s own key, then try again.`
      return `Your wallet is connected as ${r.account} and signs with ${r.publicKey}, which isn’t a key of ${owner}. Connect the wallet that holds ${owner}’s own key, then try again.`
    case 'unchecked':
      return `NEARKITS couldn’t check on chain whether ${r.publicKey} is a key of ${owner}: the network didn’t answer. Nothing was signed. Try again in a moment.`
  }
}

/** Said before the wallet signs, when it signs for `owner` with an owner key under another account id. */
export function ownerKeyNote(c: Extract<OwnerControl, { via: 'key' }>, owner: string): string {
  return `Your wallet is connected as ${c.account}. It signs with ${c.publicKey}, a full-access key of ${owner}, so its signature counts as ${owner}’s.`
}

/**
 * The decisive check on a signature for `owner`: the key that made it must be a full-access key of
 * the owner on chain right now. The account a wallet names with it is only a claim (a wallet signs
 * with whichever account is active in it, whatever it was asked). Null when the key is the owner's;
 * otherwise why the signature isn't used.
 */
export async function signedKeyProblem(publicKey: string, owner: string, permission: (account: string, publicKey: string) => Promise<KeyPermission>): Promise<string | null> {
  const refused = `Your wallet signed with ${publicKey}, which isn’t a full-access key of ${owner}. NEARKITS didn’t use that signature.`
  if (implicitAccountOf(publicKey) === null) return refused
  try {
    return (await permission(owner, publicKey)) === 'full' ? null : refused
  } catch {
    return `NEARKITS couldn’t check on chain whether ${publicKey} is a key of ${owner}, so it didn’t use that signature. Try again in a moment.`
  }
}
