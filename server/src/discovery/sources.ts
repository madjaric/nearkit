import type { HolderSnapshot } from './store'

/**
 * Where a launch comes from (DISCOVERY.md, Launch Radar). A token account `x.p.near` can only have
 * been created by `p.near` (NEAR's account structure), so the parent account is an on-chain fact. A
 * parent is a launch source once it has a deployed contract and at least MIN_LAUNCHES tokens; known
 * ones get their product name, every other one is shown by its account (look-alikes are never named).
 */

export type SourceKind = 'launchpad' | 'bridge' | 'factory'

export interface LaunchSource {
  id: string
  /** The product's name, for known sources only. */
  name: string | null
  kind: SourceKind
  validated: boolean
}

export const MIN_LAUNCHES = 3

/** Known parents, verified by their contracts' own listing methods (2026-10-16). */
const KNOWN: Readonly<Record<string, { name: string; kind: SourceKind }>> = {
  'nearlytrade.near': { name: 'Nearly', kind: 'launchpad' },
  'launchpad.justhoot.near': { name: 'JustHoot', kind: 'launchpad' },
  'rhea.meme-launchpad.near': { name: 'Rhea Launchpad', kind: 'launchpad' },
  'meme-cooking.near': { name: 'meme.cooking', kind: 'launchpad' },
  'tkn.near': { name: 'tkn.homes', kind: 'launchpad' },
  'launch-v2.intear.near': { name: 'Intear', kind: 'launchpad' },
  'launch.shoremarkets.near': { name: 'Shore Markets', kind: 'launchpad' },
  'nearrr-fun.near': { name: 'NEARRR.fun', kind: 'launchpad' },
  'factory.shardsmarket.near': { name: 'Shards', kind: 'launchpad' },
  'nearpadfamily.near': { name: 'NearPad', kind: 'launchpad' },
  'aidols.near': { name: 'Aidols', kind: 'launchpad' },
  'factory.bridge.near': { name: 'Rainbow Bridge', kind: 'bridge' },
  'omft.near': { name: 'Omni Bridge', kind: 'bridge' },
}

export function sourceOf(parent: string, seen: { hasContract: boolean | null; launches: number }): LaunchSource {
  const known = KNOWN[parent]
  const validated = seen.hasContract === true && seen.launches >= MIN_LAUNCHES
  return { id: parent, name: known?.name ?? null, kind: known?.kind ?? 'factory', validated }
}

/** The venue of a token's main pool (Intear's pool ids). */
export function venueOf(mainPool: string | null): string | null {
  if (!mainPool) return null
  const kind = mainPool.split('-')[0]
  switch (kind) {
    case 'REFDCL':
      return 'Rhea DCL'
    case 'REF':
      return 'Ref v1'
    case 'INTEARPLACH':
      return 'Intear'
    case 'AIDOLS':
      return 'Aidols'
    default:
      return kind ?? null
  }
}

/** Accounts that hold a token as infrastructure (pools, curves), never as a holder: left out of concentration. */
export const INFRA_ACCOUNTS: readonly string[] = ['dclv2.ref-labs.near', 'v2.ref-finance.near', 'dex.intear.near', 'aidols.near']

const share = (balance: string, supply: bigint): number => {
  if (supply === 0n || !/^\d+$/.test(balance)) return 0
  return Number((BigInt(balance) * 1_000_000n) / supply) / 1_000_000
}

/**
 * Holder concentration from the largest holders (sorted by balance): the ten largest holders' share of
 * supply and the dev account's, with pools, the token contract and its parent left out. The dev's share
 * is unknown (null) when it isn't among the holders read and more holders exist.
 */
export function concentration(
  rows: readonly { account: string; balance: string }[],
  totalSupply: string | null,
  ctx: { token: string; parent: string | null; dev: string | null; total: number | null; listed: number },
): HolderSnapshot {
  const skip = new Set([...INFRA_ACCOUNTS, ctx.token, ...(ctx.parent ? [ctx.parent] : [])])
  const excluded = rows.filter((r) => skip.has(r.account)).map((r) => r.account)
  const holders = rows.filter((r) => !skip.has(r.account))
  const supply = totalSupply && /^\d+$/.test(totalSupply) ? BigInt(totalSupply) : null
  if (supply === null || supply === 0n) return { total: ctx.total, top10Share: null, devShare: null, excluded, top: [] }
  const top = holders.slice(0, 10).map((r) => ({ account: r.account, share: share(r.balance, supply) }))
  const dev = ctx.dev ? holders.find((r) => r.account === ctx.dev) : undefined
  const everyoneListed = ctx.total !== null && rows.length >= ctx.total
  const devShare = !ctx.dev ? null : dev ? share(dev.balance, supply) : everyoneListed || rows.length < ctx.listed ? 0 : null
  return { total: ctx.total, top10Share: top.reduce((s, r) => s + r.share, 0), devShare, excluded, top }
}
