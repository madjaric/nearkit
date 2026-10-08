import { formatUnits } from '@/lib/amounts'
import type { KitsBurnView } from '@/services/kitsBurns'

/**
 * $KITS' Buyback & Burn on its page, from NEARKITS' server's reading of NEAR mainnet
 * (services/kitsBurns.ts, server/src/kits/burns.ts): which state the tracker is in, and the figures
 * it prints. Every figure is the reading's own; the one exception, the burned KITS' value, is today's
 * market price times the amount, and says so. A figure nobody read is "—", never 0.
 */

export type BurnTrackerState =
  /** This build's network has no $KITS (testnet). */
  | { state: 'not-on-network' }
  /** Nothing here reads the chain for it: the demo, or a build not connected to NEARKITS' server. */
  | { state: 'no-source'; reason: 'demo' | 'no-server' }
  | { state: 'loading' }
  /** NEARKITS' server couldn't read it and nothing was read before. */
  | { state: 'unavailable' }
  /** The latest reading; `refreshFailed`: the last refresh didn't come back, so this one is older. */
  | { state: 'live'; view: KitsBurnView; refreshFailed: boolean }

export function burnTrackerState(input: {
  contract: string | null
  mode: 'demo' | 'near'
  network: 'mainnet' | 'testnet' | null
  apiUrl: string | null
  query: { data: KitsBurnView | undefined; isPending: boolean; isError: boolean }
}): BurnTrackerState {
  if (input.contract === null) return { state: 'not-on-network' }
  if (input.mode === 'demo') return { state: 'no-source', reason: 'demo' }
  if (input.network !== 'mainnet' || input.apiUrl === null) return { state: 'no-source', reason: 'no-server' }
  const { data, isPending, isError } = input.query
  if (data) return { state: 'live', view: data, refreshFailed: isError }
  if (isError) return { state: 'unavailable' }
  return isPending ? { state: 'loading' } : { state: 'unavailable' }
}

export interface BurnFigures {
  /** KITS burned in all, two decimals, grouped. */
  burned: string
  /** Of the launch supply. */
  burnedPct: string
  launchSupply: string
  /** Whole KITS: a nine-digit supply reads as one. */
  supply: string
  burnCount: number
  lastBurn: { at: number; amount: string; tx: string } | null
  /** Every KITS burned went through the tax's Buyback & Burn share (the launchpad accounted for all of it). */
  allByTax: boolean
  /** The burned KITS at today's price, when a price is known. */
  valueUsd: number | null
}

const kits = (raw: string, decimals: number) => formatUnits(BigInt(raw), decimals, { maxFraction: 2, group: true })

export function burnFigures(view: KitsBurnView, priceUsd: number | null): BurnFigures {
  const burned = BigInt(view.burnedTotal)
  const launch = BigInt(view.launchSupply)
  // Hundredths of a percent, truncated: a share that rounds to nothing still reads as a share.
  const bp = launch > 0n ? (burned * 10_000n) / launch : 0n
  const burnedPct = burned > 0n && bp === 0n ? '< 0.01%' : `${(Number(bp) / 100).toFixed(2)}%`
  const last = view.burns[0]
  const units = Number(formatUnits(burned, view.decimals))
  return {
    burned: kits(view.burnedTotal, view.decimals),
    burnedPct,
    launchSupply: kits(view.launchSupply, view.decimals),
    supply: formatUnits(BigInt(view.supply), view.decimals, { maxFraction: 0, group: true }),
    burnCount: view.burnCount,
    lastBurn: last ? { at: last.at, amount: kits(last.amount, view.decimals), tx: last.tx } : null,
    allByTax: view.burnedByTax === view.burnedTotal,
    valueUsd: priceUsd !== null && Number.isFinite(priceUsd) && priceUsd > 0 ? units * priceUsd : null,
  }
}
