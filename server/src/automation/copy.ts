import type { NetworkConfig } from '@/config/networks'
import type { CopyConfig } from '@/lib/automation/config'
import { accountLegs, flowsOf, type NormalizedTx } from '@/services/near/flows'

/**
 * Copy Trade's reading of a followed account's transaction. A copyable trade is a swap the account
 * itself started, of NEAR (or wNEAR) for exactly one token or back, that went through an exchange
 * NEARKITS routes through (Rhea's aggregator, Ref's v2 exchange, Ref DCL). Anything else is skipped
 * with its reason: a transfer or a refund (a token arriving with nothing given up), a liquidity move
 * (tokens and NEAR both leaving or both arriving), token-for-token or multi-token trades, and calls
 * that never touched an exchange.
 */

export type CopyRead = { ok: true; side: 'buy' | 'sell'; token: string; tokenRaw: bigint; nearRaw: bigint } | { ok: false; reason: string }

/** The exchanges a copied trade must have gone through, on this network. */
export function exchangesOf(network: NetworkConfig): Set<string> {
  const s = new Set<string>([network.rhea.classic.exchange, network.dex.dcl.contract])
  if (network.rhea.aggregator) {
    s.add(network.rhea.aggregator.contract)
    for (const r of network.rhea.aggregator.dexReceivers) s.add(r)
  }
  return s
}

export function readCopyTrade(tx: NormalizedTx, account: string, network: NetworkConfig): CopyRead {
  if (!tx.initiators.includes(account)) return { ok: false, reason: 'Not started by the followed account' }
  const flows = flowsOf(tx, { wrapContract: network.wrapContract })
  const legs = accountLegs(flows, account, network.wrapContract)
  const near = legs.get('near') ?? 0n
  const tokens = [...legs.entries()].filter(([asset]) => asset !== 'near')
  if (tokens.length === 0) return { ok: false, reason: 'No token traded' }
  if (tokens.length > 1) return { ok: false, reason: 'More than one token moved: not a NEAR swap' }
  const [token, delta] = tokens[0] as [string, bigint]
  if (delta > 0n && near >= 0n) return { ok: false, reason: 'Tokens arrived with no NEAR given up (a transfer, a refund or a liquidity withdrawal)' }
  if (delta < 0n && near <= 0n) return { ok: false, reason: 'Tokens left with no NEAR received (a transfer or a liquidity deposit)' }
  const exchanges = exchangesOf(network)
  const touched = flows.some(
    (f) => (f.asset === token || f.asset === network.wrapContract) && ((f.to !== null && exchanges.has(f.to)) || (f.from !== null && exchanges.has(f.from))),
  )
  if (!touched) return { ok: false, reason: 'Not through an exchange NEARKITS routes through' }
  return delta > 0n ? { ok: true, side: 'buy', token, tokenRaw: delta, nearRaw: -near } : { ok: true, side: 'sell', token, tokenRaw: -delta, nearRaw: near }
}

/**
 * The NEAR a copied buy spends: the rule's fixed size, or its share of what the followed account
 * spent; never above the maximum trade nor the room left under the exposure limit. Null (skip) when
 * that is below the rule's minimum (or nothing at all).
 */
export function copyBuySize(c: CopyConfig, sourceNear: number, exposureNear: number): { near: number } | { skip: string } {
  let size = c.sizing.mode === 'fixed' ? c.sizing.amountNear : (sourceNear * c.sizing.pct) / 100
  size = Math.min(size, c.maxTradeNear)
  const room = c.maxExposureNear - exposureNear
  if (room <= 0) return { skip: `The rule’s exposure limit (${c.maxExposureNear} NEAR) is reached` }
  size = Math.min(size, room)
  const min = Math.max(c.minTradeNear ?? 0, 0.05)
  if (!(size >= min)) return { skip: `Below the minimum trade (${min} NEAR)` }
  return { near: Math.floor(size * 1e6) / 1e6 }
}
