import { walletName } from '../custody/limits'
import type { CustodyStore, Intent, TradingWallet } from '../custody/store'
import type { SwapParams, SwapQuote } from '../custody/swap'

/**
 * A trade prepared on NearKit web: one intent per NearKit wallet (one for a single buy or sell),
 * grouped so the web can follow them together. The group is only a handle for status: each
 * intent is its own wallet's trade, executed by the engine on its own.
 */

export type WebLegStatus = 'quoted' | 'requoted' | 'executing' | 'processing' | 'done' | 'failed' | 'cancelled' | 'expired'

export interface WebTradeLeg {
  /** This wallet's current quote: what the web confirms when it executes (a new price has a new id). */
  intentId: string
  walletId: string
  accountId: string
  name: string
  /** Exact decimal input: NEAR for a buy, the token for a sell. */
  amountIn: string
  /** What the wallet receives, raw: expected, and the minimum its route enforces (from its latest quote). */
  amountOut: string
  minOut: string
  /** NEAR the wallet needs available when its trade starts, and what it had when quoted (yocto); null when unknown. */
  need: string | null
  available: string | null
  /** Yocto for registrations this wallet's trade makes first. */
  registration: string
  status: WebLegStatus
  /** What the wallet received (raw), once done; null before, or when the chain didn't say. */
  received: string | null
  /** Why it failed, in plain words. */
  message: string | null
  hashes: string[]
  expiresAt: number
}

/** What the review shows for the whole trade, from the server's quotes. */
export interface WebTradeFacts {
  fee: { charged: boolean; bps: number }
  path: string[]
  networkFeeNear: string
  /** The largest price impact among the wallets; null where no prices exist (testnet). */
  priceImpactPct: number | null
  /** wrap.near's shard was backed up when quoted: it may take longer than usual. */
  busy: boolean
  /** When the earliest quote expires. */
  expiresAt: number
}

type WalletLike = Pick<TradingWallet, 'id' | 'accountId' | 'slot' | 'label'>

export function legStatus(intent: Intent, now: number, requoted = false): WebLegStatus {
  switch (intent.status) {
    case 'quoted':
      return now > intent.expiresAt ? 'expired' : requoted ? 'requoted' : 'quoted'
    case 'confirmed':
    case 'signing':
      return 'executing'
    case 'submitted':
      return 'processing'
    case 'done':
      return 'done'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'expired':
    case 'replaced':
      return 'expired'
  }
}

export function legView(intent: Intent, wallet: WalletLike, now: number, requoted = false): WebTradeLeg {
  const p = intent.params as unknown as SwapParams
  const q = intent.quote as unknown as SwapQuote
  const r = intent.result
  const facts = (r?.facts ?? {}) as { tokenAmount?: string; nearAmount?: string | null }
  const received = r?.ok ? ((p.side === 'buy' ? facts.tokenAmount : facts.nearAmount) ?? null) : null
  return {
    intentId: intent.id,
    walletId: wallet.id,
    accountId: wallet.accountId,
    name: walletName(wallet),
    amountIn: p.amountIn,
    amountOut: q.amountOut,
    minOut: q.minOut,
    need: q.need ?? null,
    available: q.available ?? null,
    registration: q.registration,
    status: legStatus(intent, now, requoted),
    received,
    message: intent.status === 'failed' ? (r?.message ?? null) : null,
    hashes: r?.hashes ?? [],
    expiresAt: intent.expiresAt,
  }
}

export function tradeFacts(intents: readonly Intent[]): WebTradeFacts {
  const quotes = intents.map((i) => i.quote as unknown as SwapQuote)
  const q0 = quotes[0]
  const impacts = quotes.map((q) => q.priceImpactPct).filter((x): x is number => x !== null)
  return {
    fee: { charged: Boolean(q0?.fee.charged && q0.fee.amountRaw !== null), bps: q0?.fee.bps ?? 0 },
    path: q0?.path ?? [],
    networkFeeNear: q0?.networkFeeNear ?? '0',
    priceImpactPct: impacts.length ? Math.max(...impacts) : null,
    busy: quotes.some((q) => q.busy),
    expiresAt: Math.min(...intents.map((i) => i.expiresAt)),
  }
}

/**
 * Where a wallet's trade in the group stands now. A leg whose price changed at execution was
 * replaced by a new quote of the same wallet, which runs only when the web confirms again: follow it.
 */
export async function latestOf(store: Pick<CustodyStore, 'intent'>, intent: Intent): Promise<{ intent: Intent; requoted: boolean }> {
  let current = intent
  let requoted = false
  for (let hop = 0; hop < 5 && current.status === 'replaced' && current.replacedBy; hop++) {
    const next = await store.intent(current.replacedBy)
    if (!next || next.userId !== intent.userId || next.walletId !== intent.walletId) break
    current = next
    requoted = true
  }
  return { intent: current, requoted }
}
