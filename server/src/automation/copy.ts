import type { NetworkConfig } from '@/config/networks'
import type { CopyConfig } from '@/lib/automation/config'
import { accountLegs, flowsOf, type NormalizedTx } from '@/services/near/flows'

/**
 * Copy Trade's reading of a followed account's transaction. A copyable trade is a swap the account
 * itself started that went through an exchange NEARKITS routes through (Rhea's aggregator, Ref's v2
 * exchange, Ref DCL):
 *
 * - NEAR (or wNEAR) for exactly one token, or back: a buy or a sell;
 * - one token for exactly one other token, with no NEAR traded (a swap): NEARKITS wallets trade
 *   against NEAR, so it is copied as two NEAR trades (a sell of what the rule holds of the first token,
 *   a buy of the second with NEAR), never as a token-for-token swap.
 *
 * Anything else is skipped with its reason: a transfer or a refund (a token arriving with nothing
 * given up), a liquidity move (tokens both leaving or both arriving), trades of more than two tokens,
 * and calls that never touched an exchange.
 */

export type CopyRead =
  | { ok: true; side: 'buy' | 'sell'; token: string; tokenRaw: bigint; nearRaw: bigint }
  | { ok: true; side: 'swap'; sold: string; soldRaw: bigint; bought: string; boughtRaw: bigint }
  | { ok: false; reason: string }

/** NEAR moving in a token-for-token swap that is still no NEAR trade: storage registrations, the 1 yocto deposits. */
const SWAP_NEAR_DUST = 20_000_000_000_000_000_000_000n // 0.02 NEAR
/** The least NEAR a buy or a sell must move to be a trade (a 1 yocto security deposit next to a withdrawal from an exchange is not one). */
const NEAR_LEG_MIN = 1_000_000_000_000_000_000_000n // 0.001 NEAR

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
  const tokens = [...legs.entries()].filter(([asset, delta]) => asset !== 'near' && delta !== 0n)
  if (tokens.length === 0) return { ok: false, reason: 'No token traded' }
  const exchanges = exchangesOf(network)
  const through = (assets: readonly string[]) =>
    flows.some((f) => assets.includes(f.asset) && ((f.to !== null && exchanges.has(f.to)) || (f.from !== null && exchanges.has(f.from))))
  if (tokens.length === 2) {
    const sold = tokens.find(([, d]) => d < 0n)
    const bought = tokens.find(([, d]) => d > 0n)
    if (!sold || !bought) return { ok: false, reason: 'Two tokens moved the same way (a liquidity deposit or withdrawal, or transfers)' }
    if (near > SWAP_NEAR_DUST || -near > SWAP_NEAR_DUST) return { ok: false, reason: 'Two tokens and NEAR moved: not a swap NEARKITS can copy' }
    if (!through([sold[0], bought[0]])) return { ok: false, reason: 'Not through an exchange NEARKITS routes through' }
    return { ok: true, side: 'swap', sold: sold[0], soldRaw: -sold[1], bought: bought[0], boughtRaw: bought[1] }
  }
  if (tokens.length > 2) return { ok: false, reason: 'More than two tokens moved: not a swap NEARKITS copies' }
  const [token, delta] = tokens[0] as [string, bigint]
  if (delta > 0n && -near < NEAR_LEG_MIN) return { ok: false, reason: 'Tokens arrived with no NEAR given up (a transfer, a refund or a withdrawal)' }
  if (delta < 0n && near < NEAR_LEG_MIN) return { ok: false, reason: 'Tokens left with no NEAR received (a transfer or a liquidity deposit)' }
  if (!through([token, network.wrapContract])) return { ok: false, reason: 'Not through an exchange NEARKITS routes through' }
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
