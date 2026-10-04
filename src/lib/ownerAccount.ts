import { accountKind } from './validation'

/**
 * Which NEAR account a wallet is on, and whether it is the one an owner request needs.
 *
 * A wallet hands NearKit a list of account values. Only NEAR account ids count: an EVM
 * address (`0x` + 40 hex, any case; NEAR's ETH-implicit ids are such addresses) is never
 * taken for a NEAR account, and neither is anything that isn't a NEAR account id. A
 * 64-character hex id is a NEAR implicit account, not an EVM address: every NearKit wallet
 * is one.
 *
 * An owner request needs the owner itself: its account id, exactly, among the NEAR accounts
 * the wallet shares (first or not). Another account is never taken for it, not even one the
 * owner's key also controls (a NearKit wallet with the owner's backup key, say): a wallet app
 * may show the two together, but they are different accounts, and nothing maps one to the other.
 */

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/

export function isEvmAddress(value: string): boolean {
  return EVM_ADDRESS.test(value)
}

/** A wallet's account values, split: its NEAR accounts (the active one first) and its EVM addresses. Anything else is dropped. */
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

export type OwnerAccountCheck =
  | { ok: true; account: string }
  /** No NEAR account and no EVM address: nothing is connected. */
  | { ok: false; reason: 'none' }
  /** Only an EVM address: no NEAR account to sign with. */
  | { ok: false; reason: 'evm-only'; evm: string }
  /** The wallet shares NEAR accounts, but not the owner: `account` is its first one. */
  | { ok: false; reason: 'other-account'; account: string }

export type OwnerAccountMismatch = Exclude<OwnerAccountCheck, { ok: true }>

/** Does the wallet share exactly `owner` among its NEAR accounts? By its id only: no case folding, no account standing in for it. */
export function checkOwnerAccount(values: readonly string[], owner: string): OwnerAccountCheck {
  const { near, evm } = walletAccounts(values)
  if (near.includes(owner)) return { ok: true, account: owner }
  const first = near[0]
  if (first === undefined) return evm[0] === undefined ? { ok: false, reason: 'none' } : { ok: false, reason: 'evm-only', evm: evm[0] }
  return { ok: false, reason: 'other-account', account: first }
}

/** What the wallet returned instead of `owner`, and what to do about it, in a sentence or two. */
export function ownerAccountProblem(check: OwnerAccountMismatch, owner: string): string {
  switch (check.reason) {
    case 'none':
      return `No NEAR account is connected. Connect ${owner}, the wallet this NearKit wallet was created with.`
    case 'evm-only':
      return `Your wallet returned an EVM address (${check.evm}), not a NEAR account. Switch to the NEAR account ${owner} in your wallet, then try again.`
    case 'other-account':
      return `Your wallet returned ${check.account}, not ${owner}. They are different NEAR accounts, even when a wallet app shows them together (one key can control both). Switch to ${owner} itself in your wallet; if it keeps returning the same account, remove NearKit from the wallet’s connected sites, then connect again.`
  }
}
