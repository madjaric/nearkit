import { KIT_LAUNCHPAD, KITS_CONTRACT } from '@/config/kit'
import { apiPost } from './telegramLink'

/**
 * $KITS' holder rewards as NEARKITS' server reads them from NEAR mainnet (server/src/kits/rewards.ts):
 * the totals from Nearly's launchpad accounting (`get_tax`: NEAR paid to holders, and NEAR allocated to
 * them but not paid yet) and every payout batch, each checked against the launchpad's own
 * `tax_holders_paid` event. Holders are paid in NEAR (the launch's quote asset), not in KITS. Allocated
 * and paid are different things and stay apart everywhere. parseKitsRewardsView refuses anything that
 * isn't about kits.nearlytrade.near on mainnet, or whose figures don't hold together.
 */

export interface KitsHolderPayout {
  /** The `pay_tax_holders` transaction. */
  tx: string
  /** When it ran (ms). */
  at: number
  /** NEAR paid in this batch, yocto. */
  amount: string
  /** Holder payments in the batch (one transfer each). */
  payments: number
}

export interface KitsRewardsView {
  network: 'mainnet'
  token: string
  launchpad: string
  launchId: string
  /** Holders are paid in NEAR. */
  asset: 'near'
  decimals: 24
  /** The holders' share of the tax, bps, as the launchpad configures it. */
  holdersBps: number
  /** NEAR paid to holders, all time (get_tax: `paid_holders`), yocto. */
  paid: string
  /** NEAR allocated to holders and not paid yet (get_tax: `holders_bucket`), yocto. */
  waiting: string
  /** paid + waiting. */
  allocated: string
  /** Verified payout batches, newest first (at most the latest 50). */
  payouts: KitsHolderPayout[]
  payoutCount: number
  /** Holder payments across every verified batch. */
  paymentCount: number
  /** The verified payouts add up to `paid`, scanned back to the launch. */
  historyComplete: boolean
  readAt: number
  historyReadAt: number | null
}

const DIGITS = /^\d{1,40}$/
const HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/

class KitsRewardsFormatError extends Error {
  constructor(message: string) {
    super(`$KITS holder reward data refused: ${message}`)
    this.name = 'KitsRewardsFormatError'
  }
}

const digits = (o: Record<string, unknown>, key: string): string => {
  const v = o[key]
  if (typeof v !== 'string' || !DIGITS.test(v)) throw new KitsRewardsFormatError(`${key} is not a whole number`)
  return v
}
const time = (v: unknown, key: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new KitsRewardsFormatError(`${key} is not a time`)
  return v
}
const count = (v: unknown, key: string): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new KitsRewardsFormatError(`${key} is not a count`)
  return v
}

export function parseKitsRewardsView(raw: unknown): KitsRewardsView {
  if (!raw || typeof raw !== 'object') throw new KitsRewardsFormatError('not an object')
  const o = raw as Record<string, unknown>
  if (o.network !== 'mainnet') throw new KitsRewardsFormatError('not NEAR mainnet')
  if (o.token !== KITS_CONTRACT) throw new KitsRewardsFormatError(`not ${KITS_CONTRACT}`)
  if (o.launchpad !== KIT_LAUNCHPAD) throw new KitsRewardsFormatError(`not read from ${KIT_LAUNCHPAD}`)
  if (o.asset !== 'near' || o.decimals !== 24) throw new KitsRewardsFormatError('holders are not paid in NEAR')
  if (!Array.isArray(o.payouts)) throw new KitsRewardsFormatError('no payout list')
  const payouts = o.payouts.map((p: unknown): KitsHolderPayout => {
    const e = (p ?? {}) as Record<string, unknown>
    if (typeof e.tx !== 'string' || !HASH.test(e.tx)) throw new KitsRewardsFormatError('bad transaction hash')
    const payments = count(e.payments, 'payments')
    if (payments === 0) throw new KitsRewardsFormatError('a payout with no payment')
    return { tx: e.tx, at: time(e.at, 'payout time'), amount: digits(e, 'amount'), payments }
  })
  const holdersBps = count(o.holdersBps, 'holders share')
  if (holdersBps > 10_000) throw new KitsRewardsFormatError('holders share above 100%')
  const view: KitsRewardsView = {
    network: 'mainnet',
    token: KITS_CONTRACT,
    launchpad: KIT_LAUNCHPAD,
    launchId: digits(o, 'launchId'),
    asset: 'near',
    decimals: 24,
    holdersBps,
    paid: digits(o, 'paid'),
    waiting: digits(o, 'waiting'),
    allocated: digits(o, 'allocated'),
    payouts,
    payoutCount: count(o.payoutCount, 'payout count'),
    paymentCount: count(o.paymentCount, 'payment count'),
    historyComplete: o.historyComplete === true,
    readAt: time(o.readAt, 'read time'),
    historyReadAt: o.historyReadAt === null ? null : time(o.historyReadAt, 'history time'),
  }
  if (BigInt(view.paid) + BigInt(view.waiting) !== BigInt(view.allocated)) throw new KitsRewardsFormatError('allocated is not paid plus waiting')
  if (view.payoutCount < payouts.length) throw new KitsRewardsFormatError('fewer payouts counted than listed')
  const listed = payouts.reduce((s, p) => s + BigInt(p.amount), 0n)
  // Every payout listed is part of what was paid; a complete history is exactly it.
  if (view.historyComplete && view.payoutCount === payouts.length && listed !== BigInt(view.paid)) throw new KitsRewardsFormatError('a complete history that isn’t what was paid')
  if (listed > BigInt(view.paid)) throw new KitsRewardsFormatError('more listed than paid')
  return view
}

/** $KITS' holder rewards from NEARKITS' server, checked. */
export async function fetchKitsRewards(apiUrl: string, fetchImpl: typeof fetch = fetch): Promise<KitsRewardsView> {
  return parseKitsRewardsView(await apiPost<unknown>(apiUrl, '/api/kits/rewards', {}, fetchImpl))
}
