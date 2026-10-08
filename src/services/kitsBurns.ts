import { KIT_LAUNCHPAD, KITS_CONTRACT } from '@/config/kit'
import { apiPost } from './telegramLink'

/**
 * $KITS' Buyback & Burn as NEARKITS' server reads it from NEAR mainnet (server/src/kits): the
 * totals from chain state (Nearly's launchpad accounting, the token's own supply) and every burn
 * transaction, each checked against the ft_burn event the token contract emitted. Nothing here is
 * estimated. The page trusts none of it blindly: parseKitsBurnView refuses anything that isn't
 * about kits.nearlytrade.near on mainnet, or whose figures aren't plain non-negative integers.
 */

/**
 * `tax`: the launchpad burned the tax's Buyback & Burn share (its own tax_burned event for this launch,
 * of this amount, beside the token's ft_burn). `other`: a verified burn without that record.
 */
export type KitsBurnKind = 'tax' | 'other'

export interface KitsBurn {
  /** The transaction's hash. */
  tx: string
  /** When the token contract executed the burn (ms). */
  at: number
  /** KITS burned, raw (the token's decimals). */
  amount: string
  kind: KitsBurnKind
}

export interface KitsBurnView {
  network: 'mainnet'
  token: string
  launchpad: string
  /** $KITS' launch on the launchpad (read from it by token). */
  launchId: string
  decimals: number
  /** The fixed supply minted at launch, raw, as the launchpad records it. */
  launchSupply: string
  /** The token's ft_total_supply now, raw. */
  supply: string
  /** Every KITS ever burned: launchSupply − supply. */
  burnedTotal: string
  /** What the launchpad's tax accounting burned (its get_tax: `burned`). */
  burnedByTax: string
  /** Verified burns, newest first (at most the latest 50). */
  burns: KitsBurn[]
  /** Verified burn transactions found. */
  burnCount: number
  /** The verified burns add up to burnedTotal: the history is the whole story. */
  historyComplete: boolean
  /** When the chain state was read, and when the burn history was last read (null: never, so far). */
  readAt: number
  historyReadAt: number | null
}

const DIGITS = /^\d{1,40}$/
const HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/
const KINDS: readonly KitsBurnKind[] = ['tax', 'other']

class KitsBurnFormatError extends Error {
  constructor(message: string) {
    super(`$KITS burn data refused: ${message}`)
    this.name = 'KitsBurnFormatError'
  }
}

const digits = (o: Record<string, unknown>, key: string): string => {
  const v = o[key]
  if (typeof v !== 'string' || !DIGITS.test(v)) throw new KitsBurnFormatError(`${key} is not a whole number`)
  return v
}
const time = (v: unknown, key: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new KitsBurnFormatError(`${key} is not a time`)
  return v
}

/** The server's answer, checked: only $KITS at its one contract on mainnet, every figure a plain integer, every burn a real-looking transaction. */
export function parseKitsBurnView(raw: unknown): KitsBurnView {
  if (!raw || typeof raw !== 'object') throw new KitsBurnFormatError('not an object')
  const o = raw as Record<string, unknown>
  if (o.network !== 'mainnet') throw new KitsBurnFormatError('not NEAR mainnet')
  if (o.token !== KITS_CONTRACT) throw new KitsBurnFormatError(`not ${KITS_CONTRACT}`)
  if (o.launchpad !== KIT_LAUNCHPAD) throw new KitsBurnFormatError(`not read from ${KIT_LAUNCHPAD}`)
  const decimals = o.decimals
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new KitsBurnFormatError('bad decimals')
  if (!Array.isArray(o.burns)) throw new KitsBurnFormatError('no burn list')
  const burns = o.burns.map((b: unknown): KitsBurn => {
    const e = (b ?? {}) as Record<string, unknown>
    if (typeof e.tx !== 'string' || !HASH.test(e.tx)) throw new KitsBurnFormatError('bad transaction hash')
    if (!KINDS.includes(e.kind as KitsBurnKind)) throw new KitsBurnFormatError('bad burn kind')
    return { tx: e.tx, at: time(e.at, 'burn time'), amount: digits(e, 'amount'), kind: e.kind as KitsBurnKind }
  })
  const view: KitsBurnView = {
    network: 'mainnet',
    token: KITS_CONTRACT,
    launchpad: KIT_LAUNCHPAD,
    launchId: digits(o, 'launchId'),
    decimals,
    launchSupply: digits(o, 'launchSupply'),
    supply: digits(o, 'supply'),
    burnedTotal: digits(o, 'burnedTotal'),
    burnedByTax: digits(o, 'burnedByTax'),
    burns,
    burnCount: typeof o.burnCount === 'number' && Number.isInteger(o.burnCount) && o.burnCount >= burns.length ? o.burnCount : burns.length,
    historyComplete: o.historyComplete === true,
    readAt: time(o.readAt, 'read time'),
    historyReadAt: o.historyReadAt === null ? null : time(o.historyReadAt, 'history time'),
  }
  // The figures must hold together: supply never above the launch supply, and the totals what they say.
  if (BigInt(view.supply) > BigInt(view.launchSupply)) throw new KitsBurnFormatError('supply above the launch supply')
  if (BigInt(view.launchSupply) - BigInt(view.supply) !== BigInt(view.burnedTotal)) throw new KitsBurnFormatError('the total burned is not the supply burned')
  if (BigInt(view.burnedByTax) > BigInt(view.burnedTotal)) throw new KitsBurnFormatError('the tax burned more than was burned')
  return view
}

/** $KITS' Buyback & Burn from NEARKITS' server, checked. */
export async function fetchKitsBurns(apiUrl: string, fetchImpl: typeof fetch = fetch): Promise<KitsBurnView> {
  return parseKitsBurnView(await apiPost<unknown>(apiUrl, '/api/kits/burns', {}, fetchImpl))
}
