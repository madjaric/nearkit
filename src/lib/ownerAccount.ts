import { accountKind } from './validation'

/**
 * Which NEAR account a wallet is on, and whether it is the one an owner request needs.
 *
 * A wallet hands NearKit a list of account values. Only NEAR account ids count: an EVM
 * address (`0x` + 40 hex, any case; NEAR's ETH-implicit ids are such addresses) is never
 * taken for a NEAR account, and neither is anything that isn't a NEAR account id. A
 * 64-character hex id is a NEAR implicit account, not an EVM address: every NearKit wallet
 * is one. The wallet's active NEAR account is the first NEAR account it lists.
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
  /** The active NEAR account is another account. */
  | { ok: false; reason: 'other-account'; account: string }

export type OwnerAccountMismatch = Exclude<OwnerAccountCheck, { ok: true }>

/** Is the wallet's active NEAR account exactly `owner`? (An owner further down the wallet's list doesn't count.) */
export function checkOwnerAccount(values: readonly string[], owner: string): OwnerAccountCheck {
  const { near, evm } = walletAccounts(values)
  const active = near[0]
  if (active === undefined) return evm[0] === undefined ? { ok: false, reason: 'none' } : { ok: false, reason: 'evm-only', evm: evm[0] }
  return active === owner ? { ok: true, account: active } : { ok: false, reason: 'other-account', account: active }
}

/** What the wallet returned instead of `owner`, and what to do about it, in a sentence or two. */
export function ownerAccountProblem(check: OwnerAccountMismatch, owner: string): string {
  switch (check.reason) {
    case 'none':
      return `No NEAR account is connected. Connect ${owner}, the wallet this NearKit wallet was created with.`
    case 'evm-only':
      return `Your wallet returned an EVM address (${check.evm}), not a NEAR account. Switch to the NEAR account ${owner} in your wallet, then try again.`
    case 'other-account':
      return `Your wallet returned ${check.account}, not ${owner}. Switch to ${owner} in your wallet, then try again.`
  }
}
