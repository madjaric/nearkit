import { BRIDGE_CHAINS, BRIDGE_DEADLINE_MS, BRIDGE_NEAR_ASSET, BRIDGE_REFERRAL, BRIDGE_SIGN_WINDOW_MS, BRIDGE_SLIPPAGE_BPS, bridgeChain, type BridgeChain } from '@/config/bridge'
import { KITS_CONTRACT } from '@/config/kit'
import { NATIVE_TOKEN_ID, NEAR_DECIMALS, type NetworkConfig } from '@/config/networks'
import { formatUnits, tryParseUnits } from '@/lib/amounts'
import { isEvmAddress, isSolanaAddress, isSourceTxHash, sourceAddressError } from '@/lib/bridge/addresses'
import { bpsOf, bridgeAppFeeRequestBps, feeSplitOf } from '@/lib/bridge/fee'
import {
  BRIDGE_IN_TRANSIT,
  type BridgeDelivery,
  type BridgeKitsEstimate,
  type BridgeOrderStatus,
  type BridgeOrderView,
  type BridgeProduct,
  type BridgeQuoteView,
  type BridgeTx,
} from '@/lib/bridge/types'
import { BRIDGE_FEE_BPS, MAX_SLIPPAGE, NEARKIT_FEE_BPS } from '@/lib/fees'
import { accountIdError } from '@/lib/validation'
import { accountState } from '@/services/near/account'
import { explorerTxUrl } from '@/services/near/explorer'
import { flowsOf, fromFastnear, isComplete, type NormalizedTx } from '@/services/near/flows'
import { estimateUpfrontYocto, GAS } from '@/services/near/gas'
import { storageStatus } from '@/services/near/storage'
import { createSwapRouter } from '@/services/real/swapRouting'
import { HttpError } from '../api/http'
import { walletName } from '../custody/limits'
import type { Intent, IntentResult, TradingWallet } from '../custody/store'
import { buyReserve, type SwapParams, type SwapQuote, SWAP_QUOTE_TTL_MS } from '../custody/swap'
import { UNWRAP_TTL_MS, type UnwrapParams } from '../custody/unwrap'
import type { CustodyDeps } from '../custody/wallets'
import type { Logger } from '../log'
import type { ServerNear } from '../near'
import type { OpsSwitches } from '../ops/switches'
import { OneClickError, type OneClick, type OneClickQuote, type OneClickQuoteRequest, type OneClickSwapStatus } from './oneclick'
import type { BridgeOrder, BridgeStore } from './store'

/**
 * Bridge & Buy $KITS, on NEARKITS' server. NEARKITS is the interface and orchestration; NEAR
 * Intents (its 1Click API) is the cross-chain infrastructure; NEARKITS never holds the user's funds
 * on the source chain, runs no bridge and no solver.
 *
 * $KITS isn't one of 1Click's tokens (its quote refuses kits.nearlytrade.near: "tokenOut is not
 * valid", checked 2026-10-08), so it runs in two stages and says so everywhere:
 * 1. SOL, ETH or BNB → NEAR: a 1Click quote (EXACT_INPUT, origin-chain deposit) delivering NEAR
 *    (1Click's wNEAR asset) to the NEAR wallet the user chose. The user's own wallet on the source
 *    chain sends the amount to the quote's deposit address; a refund goes back to that address.
 * 2. NEAR → $KITS: an ordinary NEARKITS buy of kits.nearlytrade.near, priced fresh when the NEAR
 *    is there. To a NEARKITS wallet NEARKITS' server runs it through the engine, exactly as a web
 *    trade (signer policy, the wallet's own key, the 0.50% trading fee), and only at or above the
 *    $KITS per NEAR the user accepted at review; anything else stops and asks. A connected wallet's
 *    owner signs it in their own wallet.
 *
 * The same service runs the plain Bridge to NEAR (product 'bridge', /bridge-near): stage 1 exactly
 * as above (the same quote, fee check, order, worker and on-chain delivery check), and no purchase.
 * NEAR Intents delivers NEAR as wNEAR (1Click has no native NEAR asset; its NEAR withdrawals are
 * wrap.near's ft_transfer), so what follows the delivery is the unwrap to native NEAR, where an
 * authorized one exists: for a NEARKITS wallet NEARKITS' engine runs its existing `unwrap` intent
 * (one near_withdraw, the signer's policy unchanged); a connected wallet's owner signs it; an
 * external address keeps the wNEAR, and the page says so before the user confirms. A destination
 * that can't receive wNEAR (not on NEAR, not registered with wrap.near) is refused before any
 * deposit address exists.
 *
 * Every input is the server's to check: the product, the chain and asset (V1: SOL, ETH, BNB, and
 * only while 1Click lists them), the amount, the source address's shape, the destination (one of the
 * user's own NEARKITS wallets by session, or an existing NEAR account), the fee (BRIDGE_FEE_BPS,
 * confirmed from 1Click's echo of every quote), the purchase's token (kits.nearlytrade.near only,
 * here). An order's product, destination, amount, deposit address and fee never change after it is created.
 */

/** 1Click's verifier contract on NEAR mainnet: NEAR Intents delivers from it. */
export const INTENTS_CONTRACT = 'intents.near'

/**
 * Dry quotes (no deposit address) still need a refund address of the source chain's shape. Before
 * the user connects a wallet, these stand in: random keys nobody holds, never used in a real quote.
 */
const DRY_REFUND: Record<BridgeChain['family'], string> = {
  solana: 'FDHEVP16btz5HCjFjMkQWzwGDqYpMpgDk6i7taVdK442',
  evm: '0xdb0f8971f948f7e14f7bfb12c1b870388a4cf12a',
}

/** Below this the purchase isn't worth its network fees (yocto): 0.01 NEAR. */
export const STAGE2_MIN_NEAR = 10n ** 22n
/** How long the worker holds an order while it steps it (the purchase can take a while under congestion). */
export const ORDER_LEASE_MS = 3 * 60_000
const ONE_NEAR = 10n ** 24n
/** Statuses NEAR Intents may still move an order out of: in transit, or failed (its refund may follow). */
const FOLLOWED: readonly BridgeOrderStatus[] = [...BRIDGE_IN_TRANSIT, 'failed']
/** A failed order is followed this long for its refund. */
const FAILED_FOLLOW_MS = 24 * 60 * 60_000
/** A busy wallet (its own trade running) is tried this many times before the user is asked. */
const BUSY_TRIES = 3

export type BridgeDestinationInput = { kind: 'nearkits'; userId: number; walletId: string } | { kind: 'connected' | 'external'; accountId: string }

export interface BridgeQuoteInput {
  /** Bridge & Buy $KITS, or the plain Bridge to NEAR. */
  product: BridgeProduct
  chain: string
  /** Decimal amount of the source coin, as entered. */
  amount: string
  /** The user's address on the source chain (required for a real quote: it sends and is refunded). */
  sourceAddress: string | null
  destination: BridgeDestinationInput
  /** Slippage for the $KITS purchase, percent (Bridge & Buy only; a Bridge buys nothing). */
  kitsSlippagePct: number | null
}

export interface BridgeServiceDeps {
  network: NetworkConfig
  oneclick: OneClick
  store: BridgeStore
  near: ServerNear
  /** NEARKITS' fee account (nearkitfee.near on mainnet): it receives the bridge fee inside NEAR Intents. */
  feeRecipient: string
  /** NEARKITS wallets; null on a server without custody (then only connected wallets are offered). */
  custody: CustodyDeps | null
  ops: Pick<OpsSwitches, 'bridgeBlocked'> & Partial<Pick<OpsSwitches, 'blocked'>>
  fetch: typeof fetch
  now: () => number
  log: Logger
}

type Delivered = NonNullable<BridgeOrder['delivered']> & { wnear?: string }

const decimal = (raw: bigint, decimals: number) => formatUnits(raw, decimals)

/** Bridge & Buy for $KITS: NEAR mainnet and kits.nearlytrade.near only, refused anywhere else. */
export function createBridgeService(deps: BridgeServiceDeps) {
  if (deps.network.id !== 'mainnet' || deps.network.kitsContract !== KITS_CONTRACT) throw new Error('Bridge & Buy runs on NEAR mainnet, for kits.nearlytrade.near only')
  return bridgeFor(deps, KITS_CONTRACT)
}

/**
 * The service for one destination token. Production builds it only through createBridgeService
 * (mainnet, $KITS); the tests build it on the test chain, with one of its tokens standing in.
 */
export function bridgeFor(deps: BridgeServiceDeps, token: string) {
  const { network, oneclick, store, near, log } = deps
  const tokenMeta = async () => {
    const m = await near.ctx.reader.metadata(token)
    return { symbol: m.symbol, name: m.name ?? m.symbol, decimals: m.decimals }
  }
  const router = createSwapRouter(near.ctx)
  const wrap = network.wrapContract
  const nearTx = (hash: string): BridgeTx => ({ hash, url: explorerTxUrl(network, hash) })
  const productName = (product: BridgeProduct) => (product === 'bridge' ? 'Bridge' : 'Bridge & Buy')

  /** The V1 chains 1Click supports right now, with the decimals NEARKITS expects, and only while it delivers wNEAR. */
  async function enabledChains(): Promise<{ chain: BridgeChain; priceUsd: number | null }[]> {
    const list = await oneclick.tokens()
    if (!list.some((t) => t.assetId === BRIDGE_NEAR_ASSET && t.blockchain === 'near' && t.decimals === NEAR_DECIMALS)) return []
    return BRIDGE_CHAINS.flatMap((chain) => {
      const t = list.find((x) => x.assetId === chain.assetId && x.blockchain === chain.id && x.decimals === chain.decimals)
      return t ? [{ chain, priceUsd: t.priceUsd }] : []
    })
  }

  async function chainOf(id: string, product: BridgeProduct): Promise<BridgeChain> {
    const chain = bridgeChain(id)
    let on: { chain: BridgeChain }[]
    try {
      on = await enabledChains()
    } catch (e) {
      throw toHttp(e, product)
    }
    if (!chain || !on.some((c) => c.chain.id === chain.id))
      throw new HttpError(400, 'chain', `${productName(product)} brings SOL from Solana, ETH from Ethereum or BNB from BNB Chain.`)
    return chain
  }

  /** The NEAR account the order delivers to: one of the user's own NEARKITS wallets, or a NEAR account. */
  async function destinationOf(d: BridgeDestinationInput, product: BridgeProduct): Promise<{ accountId: string; wallet: TradingWallet | null; userId: number | null }> {
    if (d.kind === 'nearkits') {
      if (!deps.custody) throw new HttpError(409, 'no-custody', 'NEARKITS wallets aren’t available on this server. Use a connected NEAR wallet.')
      const wallet = await deps.custody.store.ownedWallet(d.userId, d.walletId)
      if (!wallet || wallet.network !== network.id) throw new HttpError(403, 'not-executable', 'That isn’t one of your NEARKITS wallets.')
      if (wallet.frozenAt !== null) throw new HttpError(409, 'frozen', `${walletName(wallet)} is frozen by NEARKITS for your protection: it doesn’t trade.`)
      return { accountId: wallet.accountId, wallet, userId: d.userId }
    }
    // Any NEAR account typed in is the plain Bridge's only: Bridge & Buy's purchase needs a wallet that signs.
    if (d.kind === 'external' && product !== 'bridge') throw new HttpError(400, 'destination', 'Choose the NEAR wallet that receives $KITS.')
    const accountId = d.accountId.trim().toLowerCase()
    const problem = accountIdError(accountId)
    const elsewhere = network.id === 'mainnet' ? accountId.endsWith('.testnet') : accountId.endsWith('.near')
    if (problem || elsewhere) throw new HttpError(400, 'destination', problem ?? `That account isn’t on NEAR ${network.id}, where ${productName(product)} delivers.`)
    return { accountId, wallet: null, userId: null }
  }

  /**
   * Bridge: whether the destination can receive what NEAR Intents delivers (wNEAR), and who turns it
   * into native NEAR. It must exist on NEAR and be registered with wrap.near (an ft_transfer to an
   * account the token doesn't know fails); a NEARKITS wallet also needs NEAR for the unwrap's own
   * network fee, and the unwrap must be allowed now (the trading switch, the wallet's freeze).
   */
  async function receivability(dest: { accountId: string; wallet: TradingWallet | null }, kind: BridgeDestinationInput['kind']): Promise<BridgeDelivery & { code: string | null }> {
    const unwrap: BridgeDelivery['unwrap'] = kind === 'nearkits' ? 'nearkits' : kind === 'connected' ? 'wallet' : 'none'
    const no = (code: string, blocked: string, fix: BridgeDelivery['fix'] = null) => ({ asset: 'wnear' as const, unwrap, blocked, fix, code })
    const unread = `NEARKITS can’t read ${dest.accountId} on NEAR right now. Try again in a moment.`
    const [state, registered] = await Promise.all([
      accountState(near.ctx.rpc, dest.accountId, 'final').catch(() => null),
      storageStatus(near.ctx.rpc, wrap, [dest.accountId])
        .then((m) => m.get(dest.accountId) ?? null)
        .catch(() => null),
    ])
    if (!state) return no('chain', unread)
    const who = kind === 'nearkits' ? 'This NEARKITS wallet' : dest.accountId
    if (!state.exists)
      return no('not-on-chain', `${who} isn’t on NEAR yet. NEAR Intents delivers NEAR as wNEAR, which only an account already on NEAR can receive: send it a little NEAR first.`)
    if (registered === null) return no('chain', unread)
    if (!registered) {
      if (kind === 'nearkits')
        return no(
          'not-registered',
          'This NEARKITS wallet isn’t registered with wNEAR (wrap.near) yet, so NEAR Intents can’t deliver to it. Its first trade registers it; or choose another wallet.',
        )
      if (kind === 'connected')
        return no(
          'not-registered',
          `${dest.accountId} isn’t registered with wNEAR (wrap.near) yet, so NEAR Intents can’t deliver to it. Register it once: your wallet signs, about 0.00125 NEAR.`,
          'register',
        )
      return no(
        'not-registered',
        `${dest.accountId} isn’t registered with wNEAR (wrap.near), so NEAR Intents can’t deliver to it. Its owner registers it once (wrapping a little NEAR does), or choose another destination.`,
      )
    }
    if (kind === 'nearkits' && dest.wallet) {
      const blocked = deps.custody ? await deps.custody.ops.blocked('unwrap', dest.wallet) : null
      if (blocked) return no('paused', `${blocked} NEAR Intents delivers wNEAR, and NEARKITS couldn’t unwrap it now.`)
      const fee = estimateUpfrontYocto({ transactions: 1, actions: 1, attachedGas: GAS.NEAR_WITHDRAW, deposits: 1n })
      if (state.availableYocto < fee)
        return no(
          'no-gas',
          `This NEARKITS wallet has no NEAR for the network fee of unwrapping (about ${formatUnits(fee, NEAR_DECIMALS, { maxFraction: 4 })} NEAR). Send it a little NEAR first, or choose another wallet.`,
        )
    }
    return { asset: 'wnear', unwrap, blocked: null, fix: null, code: null }
  }

  function toHttp(e: unknown, product: BridgeProduct = 'buy-kits'): HttpError {
    if (e instanceof HttpError) return e
    if (e instanceof OneClickError) {
      if (e.kind === 'below-minimum') return new HttpError(400, 'minimum', e.message, { minimum: e.minimum?.toString() ?? null, minimumUsd: e.minimumUsd })
      if (e.kind === 'no-route') return new HttpError(502, 'no-route', e.message)
      if (e.kind === 'invalid') return new HttpError(502, 'route', 'Route temporarily unavailable. Nothing was sent.')
      return new HttpError(503, 'unavailable', e.message)
    }
    log.error('bridge request failed', { error: e })
    return new HttpError(503, 'unavailable', `${productName(product)} can’t answer right now. Try again in a moment.`)
  }

  /**
   * $KITS for `nearIn` of NEAR, priced by NEARKITS' own route (Rhea or DCL, the trading fee and
   * $KITS' buy tax in its figures): what stage 2 would buy now. Null with a reason when it can't be priced.
   */
  async function estimateKits(nearIn: bigint, slippagePct: number, account: string): Promise<{ kits: BridgeKitsEstimate | null; reason: string | null }> {
    if (nearIn < STAGE2_MIN_NEAR) return { kits: null, reason: 'Too little NEAR arrives to buy $KITS after network fees.' }
    try {
      const r = await router.route({ tokenIn: NATIVE_TOKEN_ID, tokenOut: token, amountIn: decimal(nearIn, NEAR_DECIMALS), slippagePct, walletId: account }, account, false)
      return {
        kits: {
          amountOut: r.amountOut.toString(),
          minOut: r.minOut.toString(),
          tradingFeeBps: NEARKIT_FEE_BPS,
          nearIn: nearIn.toString(),
          slippagePct,
          priceImpactPct: null,
        },
        reason: null,
      }
    } catch (e) {
      log.info('bridge: $KITS estimate failed', { error: e })
      return { kits: null, reason: 'NEARKITS can’t price $KITS right now.' }
    }
  }

  function quoteView(
    chain: BridgeChain,
    q: OneClickQuote,
    nearkitsBps: number,
    intentsBps: number,
    est: { kits: BridgeKitsEstimate | null; reason: string | null },
    delivery: BridgeDelivery | null,
  ): BridgeQuoteView {
    return {
      chain: chain.id,
      amountIn: q.amountIn.toString(),
      amountInUsd: q.amountInUsd,
      nearOut: q.amountOut.toString(),
      nearMinOut: q.minAmountOut.toString(),
      nearOutUsd: q.amountOutUsd,
      fee: { nearkitsBps, intentsBps, nearkitsRaw: bpsOf(q.amountIn, nearkitsBps).toString(), intentsRaw: bpsOf(q.amountIn, intentsBps).toString() },
      timeEstimateSec: q.timeEstimateSec,
      refundFee: q.refundFee?.toString() ?? null,
      kits: est.kits,
      kitsUnavailable: est.reason,
      ...(delivery ? { delivery } : {}),
      quotedAt: deps.now(),
    }
  }

  /**
   * One 1Click quote for this input, checked (fee included), with stage 2's estimate (Bridge & Buy)
   * or whether the destination can receive the wNEAR and who unwraps it (Bridge).
   */
  async function quoteFor(input: BridgeQuoteInput, dry: boolean) {
    const { product } = input
    const chain = await chainOf(input.chain, product)
    const parsed = tryParseUnits(input.amount.trim(), chain.decimals)
    if (!parsed.ok || parsed.value <= 0n) throw new HttpError(400, 'amount', `Enter an amount of ${chain.symbol} above 0, with at most ${chain.decimals} decimals.`)
    const slippage = input.kitsSlippagePct ?? Number.NaN
    if (product === 'buy-kits' && !(Number.isFinite(slippage) && slippage > 0 && slippage <= MAX_SLIPPAGE))
      throw new HttpError(400, 'slippage', `Slippage is above 0 and at most ${MAX_SLIPPAGE}%.`)
    let refundTo: string
    if (input.sourceAddress !== null && input.sourceAddress.trim() !== '') {
      const problem = sourceAddressError(chain, input.sourceAddress)
      if (problem) throw new HttpError(400, 'source', problem)
      refundTo = input.sourceAddress.trim()
    } else {
      if (!dry) throw new HttpError(400, 'source', `Connect your ${chain.name} wallet, or enter the ${chain.name} address you send from.`)
      refundTo = DRY_REFUND[chain.family]
    }
    const dest = await destinationOf(input.destination, product)
    const request: OneClickQuoteRequest = {
      dry,
      swapType: 'EXACT_INPUT',
      slippageTolerance: BRIDGE_SLIPPAGE_BPS,
      originAsset: chain.assetId,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: BRIDGE_NEAR_ASSET,
      amount: parsed.value.toString(),
      refundTo,
      refundType: 'ORIGIN_CHAIN',
      recipient: dest.accountId,
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(deps.now() + BRIDGE_DEADLINE_MS).toISOString(),
      referral: BRIDGE_REFERRAL,
      quoteWaitingTimeMs: 3000,
      appFees: [{ recipient: deps.feeRecipient, fee: bridgeAppFeeRequestBps() }],
    }
    const started = deps.now()
    let q: OneClickQuote
    try {
      q = await oneclick.quote(request)
    } catch (e) {
      log.info('bridge quote refused', { product, chain: chain.id, dry, error: e, ms: deps.now() - started })
      throw toHttp(e, product)
    }
    // The fee as 1Click will really charge it: NEARKITS' share must be exactly the configured fee.
    const split = feeSplitOf(q.appFees, deps.feeRecipient)
    if (!split || split.nearkitsBps !== BRIDGE_FEE_BPS) {
      log.error('bridge: 1Click charges a different NEARKITS fee than configured; quote refused', { product, chain: chain.id, echoed: q.appFees, expected: BRIDGE_FEE_BPS })
      throw new HttpError(503, 'fee', `${productName(product)} is unavailable right now: its fee couldn’t be confirmed. Nothing was sent.`)
    }
    // Bridge & Buy prices its purchase; a Bridge buys nothing, and says instead what arrives and whether it can.
    const est = product === 'buy-kits' ? await estimateKits(q.amountOut, slippage, dest.accountId) : { kits: null, reason: null }
    const receivable = product === 'bridge' ? await receivability(dest, input.destination.kind) : null
    const delivery: BridgeDelivery | null = receivable ? { asset: receivable.asset, unwrap: receivable.unwrap, blocked: receivable.blocked, fix: receivable.fix } : null
    log.info('bridge quote', { product, chain: chain.id, dry, usd: q.amountInUsd, kits: est.kits !== null, ms: deps.now() - started, destination: input.destination.kind })
    return { chain, q, split, est, dest, refundTo, receivable, view: quoteView(chain, q, split.nearkitsBps, split.intentsBps, est, delivery) }
  }

  function view(o: BridgeOrder, wallet?: TradingWallet | null): BridgeOrderView {
    const chain = bridgeChain(o.chain) as BridgeChain
    return {
      id: o.id,
      product: o.product,
      status: o.status,
      chain: o.chain,
      sourceAddress: o.sourceAddress,
      depositAddress: o.depositAddress,
      depositDeadline: o.depositDeadline,
      signBy: o.signBy,
      quote: o.quote,
      destination: { kind: o.kind, accountId: o.recipient, walletId: o.walletId, name: wallet ? walletName(wallet) : null },
      depositTx: o.depositTx ? { hash: o.depositTx, url: chain.explorerTx(o.depositTx) } : null,
      delivered: o.delivered ? { amount: o.delivered.amount, asset: o.delivered.asset, txs: o.delivered.txs } : null,
      kits: o.kits,
      unwrapped: o.stage2.unwrapped ?? null,
      refund: o.refund,
      message: o.message,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
    }
  }

  async function viewOf(o: BridgeOrder): Promise<BridgeOrderView> {
    const wallet = o.walletId && deps.custody ? await deps.custody.store.wallet(o.walletId) : null
    return view(o, wallet)
  }

  /** A transaction on NEAR as FastNEAR records it; null when it isn't there (yet). */
  async function nearTxOf(hash: string): Promise<NormalizedTx | null> {
    const res = await deps.fetch(`${network.discovery.fastnearTxUrl}/v0/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ tx_hashes: [hash] }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`FastNEAR answered ${res.status}`)
    const body = (await res.json()) as { transactions?: unknown[] }
    const raw = body.transactions?.[0]
    return raw ? fromFastnear(raw) : null
  }

  /**
   * The NEAR NEAR Intents delivered to the order's account, read from the delivery transactions on
   * chain: wNEAR (wrap.near's ft_transfer from intents.near) and native NEAR (a transfer from
   * intents.near). 'wait' while they aren't all on chain or show nothing for the account yet.
   */
  async function deliveryOf(o: BridgeOrder, s: OneClickSwapStatus): Promise<Delivered | 'wait'> {
    const hashes = [...new Set([...s.destinationTxs.map((t) => t.hash), ...s.nearTxHashes])].filter((h) => /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(h)).slice(0, 8)
    let wnear = 0n
    let native = 0n
    const txs: BridgeTx[] = []
    for (const h of hashes) {
      const tx = await nearTxOf(h)
      if (!tx) continue
      if (!isComplete(tx)) return 'wait'
      let found = false
      for (const f of flowsOf(tx, { wrapContract: wrap })) {
        if (f.to !== o.recipient || f.from !== INTENTS_CONTRACT) continue
        if (f.asset === wrap && f.kind === 'transfer') {
          wnear += f.amount
          found = true
        } else if (f.asset === 'near' && f.kind === 'native') {
          native += f.amount
          found = true
        }
      }
      if (found) txs.push(nearTx(h))
    }
    const total = wnear + native
    if (!txs.length || total === 0n) return 'wait'
    if (s.amountOut !== null && s.amountOut !== total)
      log.warn('bridge: delivered on chain differs from 1Click’s figure', { order: o.id, chain: total.toString(), oneclick: s.amountOut.toString() })
    return { amount: total.toString(), asset: wnear > 0n ? 'wnear' : 'near', txs, ...(wnear > 0n ? { wnear: wnear.toString() } : {}) }
  }

  /** When to ask again, by status, backing off after failed checks (at most two minutes). */
  function nextCheck(o: Pick<BridgeOrder, 'createdAt' | 'depositTx'>, status: BridgeOrderStatus, failures = 0): number | null {
    const now = deps.now()
    if (failures > 0) return now + Math.min(120_000, 5_000 * 2 ** Math.min(failures, 5))
    switch (status) {
      case 'awaiting-deposit':
        return now + (o.depositTx ? 6_000 : now - o.createdAt < 10 * 60_000 ? 12_000 : 30_000)
      case 'deposit-seen':
      case 'bridging':
        return now + 6_000
      case 'unwrapping':
        return now + 2_000
      case 'incomplete-deposit':
        return now + 60_000
      case 'delivered':
      case 'buying':
        return now + 2_000
      default:
        return null
    }
  }

  /** Stage 1: where NEAR Intents is, recorded; on SUCCESS the delivery checked on chain. */
  async function stepTransit(o: BridgeOrder): Promise<void> {
    let s: OneClickSwapStatus
    try {
      s = await oneclick.status(o.depositAddress)
    } catch (e) {
      const failures = o.checks + 1
      if (e instanceof OneClickError && e.kind === 'not-found' && deps.now() > o.depositDeadline + 60 * 60_000) {
        await store.update(o.id, { status: 'expired', message: 'NEAR Intents has no record of a deposit. Nothing was sent.', nextCheckAt: null }, FOLLOWED)
        return
      }
      log.info('bridge status check failed', { order: o.id, error: e, failures })
      await store.update(o.id, { checks: failures, nextCheckAt: nextCheck(o, o.status, failures) })
      return
    }
    const depositTx = o.depositTx ?? s.originTxs[0]?.hash ?? null
    const base = { intentsStatus: s.status, checks: 0, depositTx }
    switch (s.status) {
      case 'PENDING_DEPOSIT': {
        // Past the deadline with nothing seen: the address no longer takes deposits.
        if (deps.now() > o.depositDeadline + 10 * 60_000 && !depositTx) {
          await store.update(o.id, { ...base, status: 'expired', message: 'Nothing arrived before the deposit address closed. Nothing was bridged.', nextCheckAt: null }, FOLLOWED)
          return
        }
        await store.update(o.id, { ...base, nextCheckAt: nextCheck({ ...o, depositTx }, 'awaiting-deposit') }, FOLLOWED)
        return
      }
      case 'KNOWN_DEPOSIT_TX':
        await moveTo(o, 'deposit-seen', { ...base, message: null })
        return
      case 'PROCESSING':
        await moveTo(o, 'bridging', { ...base, message: null })
        return
      case 'INCOMPLETE_DEPOSIT':
        await moveTo(o, 'incomplete-deposit', {
          ...base,
          message: 'Less arrived than the quote needs. NEAR Intents refunds it to your address after the deadline unless the rest arrives.',
        })
        return
      case 'REFUNDED':
        await store.update(
          o.id,
          {
            ...base,
            status: 'refunded',
            refund: { amount: s.refundedAmount?.toString() ?? null, reason: s.refundReason, txs: s.originTxs.map((t) => ({ hash: t.hash, url: t.url })) },
            message:
              o.product === 'bridge'
                ? 'NEAR Intents couldn’t complete it and refunded your address on the source chain. No NEAR was delivered.'
                : 'NEAR Intents couldn’t complete it and refunded your address on the source chain. No NEAR was delivered and no $KITS was bought.',
            nextCheckAt: null,
          },
          BRIDGE_IN_TRANSIT,
        )
        log.info('bridge order refunded', { order: o.id, reason: s.refundReason })
        return
      case 'FAILED':
        await store.update(
          o.id,
          {
            ...base,
            status: 'failed',
            message: 'NEAR Intents reported the swap as failed. Its refund process returns funds to your address on the source chain; NEARKITS keeps checking.',
            nextCheckAt: deps.now() - o.createdAt < FAILED_FOLLOW_MS ? deps.now() + 5 * 60_000 : null,
          },
          BRIDGE_IN_TRANSIT,
        )
        log.warn('bridge order failed at NEAR Intents', { order: o.id })
        return
      case 'SUCCESS': {
        let d: Delivered | 'wait'
        try {
          d = await deliveryOf(o, s)
        } catch (e) {
          d = 'wait'
          log.info('bridge delivery check failed', { order: o.id, error: e })
        }
        if (d === 'wait') {
          const failures = o.checks + 1
          await store.update(
            o.id,
            {
              ...base,
              status: 'bridging',
              checks: failures,
              message: 'NEAR Intents reports the NEAR delivered; NEARKITS is confirming it on NEAR.',
              nextCheckAt: nextCheck(o, 'bridging', Math.min(failures, 4)),
            },
            FOLLOWED,
          )
          return
        }
        if (o.product === 'bridge') return arrived(o, base, d)
        const connected = o.kind === 'connected'
        await store.update(
          o.id,
          {
            ...base,
            status: 'delivered',
            delivered: d,
            message: connected ? 'NEAR arrived in your wallet. Buy $KITS with it: your wallet signs.' : 'NEAR arrived. NEARKITS is buying $KITS with it.',
            nextCheckAt: connected ? null : deps.now(),
          },
          BRIDGE_IN_TRANSIT,
        )
        log.info('bridge delivered', { order: o.id, asset: d.asset })
        return
      }
    }
  }

  /**
   * A Bridge's NEAR, checked on chain in the destination: native NEAR is the result as it is; wNEAR
   * is unwrapped by NEARKITS for a NEARKITS wallet, waits for its owner's signature in a connected
   * wallet, and is the result for an external address (the page said so before the user confirmed).
   */
  async function arrived(o: BridgeOrder, base: { intentsStatus: string; checks: number; depositTx: string | null }, d: Delivered) {
    const wnear = d.asset === 'wnear'
    const next: Parameters<BridgeStore['update']>[1] =
      !wnear || o.kind === 'external'
        ? {
            status: 'complete',
            message: wnear ? `Delivered as wNEAR to ${o.recipient}: it unwraps to NEAR from that account (wrap.near's near_withdraw).` : null,
            nextCheckAt: null,
          }
        : o.kind === 'nearkits'
          ? { status: 'unwrapping', message: 'wNEAR arrived. NEARKITS is unwrapping it to NEAR in your wallet.', nextCheckAt: deps.now() }
          : { status: 'delivered', message: 'wNEAR arrived in your wallet. Unwrap it to NEAR: your wallet signs.', nextCheckAt: null }
    await store.update(o.id, { ...base, delivered: d, ...next }, BRIDGE_IN_TRANSIT)
    log.info('bridge delivered', { order: o.id, product: o.product, asset: d.asset, next: next.status })
  }

  async function moveTo(o: BridgeOrder, status: BridgeOrderStatus, patch: Parameters<BridgeStore['update']>[1]) {
    await store.update(o.id, { ...patch, status, nextCheckAt: nextCheck(o, status) }, FOLLOWED)
  }

  /** Stage 2 stopped: the NEAR stays in the wallet and the user decides. */
  async function buyNeeded(o: BridgeOrder, message: string, stage2 = o.stage2) {
    await store.update(o.id, { status: 'buy-needed', message, stage2, nextCheckAt: null }, ['delivered', 'buying'])
    log.info('bridge: $KITS purchase needs the user', { order: o.id, reason: message })
  }

  /** The engine's verdict on an intent of this order, once it has one. */
  const settled = (i: Intent | null) => (i && (i.status === 'done' || i.status === 'failed' || i.status === 'cancelled' || i.status === 'expired') ? i : null)
  const failText = (r: IntentResult | null | undefined, fallback: string) => r?.message?.replace(/\s*Nothing was sent\.?$/, '') || fallback

  /**
   * Stage 2 for a NEARKITS wallet: unwrap the wNEAR delivered (if it came as wNEAR), then buy
   * $KITS with it through the engine, once each (the intent ids are saved before anything runs,
   * so a restart follows them instead of starting again). The buy runs only at or above the $KITS
   * per NEAR the user accepted; a price that moved further stops it.
   */
  async function stepPurchase(o: BridgeOrder): Promise<void> {
    const custody = deps.custody
    const d = o.delivered as Delivered | null
    if (!custody || !d || o.kind !== 'nearkits' || o.userId === null || !o.walletId) return buyNeeded(o, 'NEARKITS can’t buy $KITS here. Your NEAR is in your wallet.')
    const wallet = await custody.store.ownedWallet(o.userId, o.walletId)
    if (!wallet) return buyNeeded(o, 'The wallet isn’t one of your active NEARKITS wallets any more. Your NEAR is in it.')
    const stage2 = { ...o.stage2 }
    if (o.status === 'delivered') await store.update(o.id, { status: 'buying', message: 'Buying $KITS with the NEAR received.' }, ['delivered'])

    // 1. wNEAR → NEAR, exactly what was delivered as wNEAR.
    if (d.asset === 'wnear' && d.wnear) {
      if (!stage2.unwrapIntent) {
        const blocked = (await custody.ops.blocked('unwrap', wallet)) ?? null
        if (blocked) return buyNeeded(o, `${blocked} Your NEAR arrived as wNEAR and is in the wallet.`)
        const params: UnwrapParams = { amount: d.wnear }
        const intent = await custody.store.createIntent({ walletId: wallet.id, userId: o.userId, chatId: 0, kind: 'unwrap', params, ttlMs: UNWRAP_TTL_MS, groupId: `bb-${o.id}` })
        stage2.unwrapIntent = intent.id
        await store.update(o.id, { stage2 })
        const r = await custody.engine.execute(intent.id, o.userId)
        if (r.kind === 'refused')
          return busy(o, stage2, intent.id, 'unwrapIntent', 'The wallet stayed busy with another transaction. Your NEAR is in it as wNEAR: unwrap and buy on Swap.')
        if (r.kind === 'pending') return void (await store.update(o.id, { nextCheckAt: deps.now() + 10_000 }))
      }
      const u = settled(await custody.store.intent(stage2.unwrapIntent as string))
      if (!u) return void (await store.update(o.id, { nextCheckAt: deps.now() + 10_000 }))
      if (u.status !== 'done' || !u.result?.ok) return buyNeeded(o, `${failText(u.result, 'Unwrapping the wNEAR failed')}. Your NEAR is in the wallet as wNEAR.`, stage2)
    }

    // 2. NEAR → $KITS.
    if (!stage2.buyIntent) {
      const blocked = custody.ops.blocked ? await custody.ops.blocked('buy', wallet) : null
      if (blocked) return buyNeeded(o, `${blocked} Your NEAR is in the wallet.`, stage2)
      let available: bigint
      try {
        available = (await accountState(near.ctx.rpc, wallet.accountId, 'final')).availableYocto
      } catch {
        return void (await store.update(o.id, { nextCheckAt: deps.now() + 15_000 }))
      }
      const delivered = BigInt(d.amount)
      const room = available - buyReserve(network)
      const spend = room < delivered ? room : delivered
      if (spend < STAGE2_MIN_NEAR)
        return buyNeeded(o, 'Not enough NEAR is left after network fees to buy $KITS. Your NEAR is in the wallet: add a little NEAR for fees, then buy on Swap.', stage2)
      let meta: { symbol: string; decimals: number }
      try {
        meta = await tokenMeta()
      } catch {
        return void (await store.update(o.id, { nextCheckAt: deps.now() + 15_000 }))
      }
      const params: SwapParams = { side: 'buy', token, symbol: meta.symbol, decimals: meta.decimals, amountIn: decimal(spend, NEAR_DECIMALS), slippagePct: o.kitsSlippage }
      let quote: SwapQuote
      try {
        quote = await custody.swaps.quote(params, wallet)
      } catch (e) {
        const tries = (stage2.attempts ?? 0) + 1
        if (tries >= 3)
          return buyNeeded(o, 'NEARKITS couldn’t price $KITS for the purchase. Your NEAR is in the wallet: buy on Swap when you’re ready.', { ...stage2, attempts: tries })
        log.info('bridge: stage-2 quote failed, retrying', { order: o.id, error: e })
        return void (await store.update(o.id, { stage2: { ...stage2, attempts: tries }, nextCheckAt: deps.now() + 20_000 }))
      }
      if (!withinBound(o, spend, BigInt(quote.minOut)))
        return buyNeeded(
          o,
          'The $KITS price moved beyond your slippage while the NEAR was bridging, so nothing was bought. Your NEAR is in the wallet: buy at the new price, or keep it.',
          stage2,
        )
      await custody.store.cancelQuoted(wallet.id, ['buy', 'sell'])
      const intent = await custody.store.createIntent({
        walletId: wallet.id,
        userId: o.userId,
        chatId: 0,
        kind: 'buy',
        params,
        quote,
        ttlMs: SWAP_QUOTE_TTL_MS,
        groupId: `bb-${o.id}`,
      })
      Object.assign(stage2, { buyIntent: intent.id, nearIn: spend.toString() })
      await store.update(o.id, { stage2 })
      let r = await custody.engine.execute(intent.id, o.userId)
      // The route moved between quote and signature: the engine re-quoted without sending. Take the new one only within the bound, once.
      if (r.kind === 'requoted') {
        const next = r.next
        const minOut = BigInt((next.quote as unknown as SwapQuote).minOut)
        if (!withinBound(o, spend, minOut)) {
          await custody.store.setStatus(next.id, ['quoted'], 'cancelled')
          return buyNeeded(o, 'The $KITS price moved beyond your slippage while the NEAR was bridging, so nothing was bought. Your NEAR is in the wallet.', stage2)
        }
        stage2.buyIntent = next.id
        await store.update(o.id, { stage2 })
        r = await custody.engine.execute(next.id, o.userId)
        if (r.kind === 'requoted') {
          await custody.store.setStatus(r.next.id, ['quoted'], 'cancelled')
          return buyNeeded(o, 'The $KITS price kept moving, so nothing was bought. Your NEAR is in the wallet: buy on Swap.', stage2)
        }
      }
      if (r.kind === 'refused')
        return busy(o, stage2, stage2.buyIntent as string, 'buyIntent', 'The wallet stayed busy with another transaction, so nothing was bought. Your NEAR is in it: buy on Swap.')
      if (r.kind === 'pending') return void (await store.update(o.id, { nextCheckAt: deps.now() + 10_000 }))
    }
    const b = settled(await custody.store.intent(stage2.buyIntent as string))
    if (!b) return void (await store.update(o.id, { nextCheckAt: deps.now() + 10_000 }))
    if (b.status !== 'done' || !b.result?.ok) return buyNeeded(o, `${failText(b.result, 'The $KITS purchase failed')}. Your NEAR is in the wallet.`, stage2)
    const facts = b.result.facts ?? {}
    const amount = typeof facts.tokenAmount === 'string' && /^\d+$/.test(facts.tokenAmount) ? facts.tokenAmount : null
    await store.update(
      o.id,
      {
        status: 'complete',
        stage2,
        kits: { amount: amount ?? '0', txs: b.result.hashes.map(nearTx) },
        message: amount ? null : 'The purchase is confirmed; its exact amount is on the explorer.',
        nextCheckAt: null,
      },
      ['buying', 'delivered'],
    )
    log.info('bridge order complete', { order: o.id })
  }

  /** A Bridge's unwrap stopped: the wNEAR stays in the wallet, said as such, and its owner decides (no automatic retry). */
  async function unwrapNeeded(o: BridgeOrder, why: string, stage2 = o.stage2) {
    const d = o.delivered as Delivered | null
    const held = d?.wnear ? `${formatUnits(BigInt(d.wnear), NEAR_DECIMALS, { maxFraction: 4 })} wNEAR` : 'The wNEAR'
    await store.update(o.id, { status: 'unwrap-needed', message: `${why} ${held} is in the wallet: unwrap it when you’re ready.`, stage2, nextCheckAt: null }, ['unwrapping'])
    log.info('bridge: unwrap needs the user', { order: o.id, reason: why })
  }

  /**
   * A Bridge to a NEARKITS wallet: exactly the wNEAR delivered, unwrapped to native NEAR through the
   * engine's existing `unwrap` intent (one near_withdraw, the signer's policy unchanged), once (the
   * intent id is saved before it runs, so a restart follows it instead of starting another).
   */
  async function stepUnwrap(o: BridgeOrder): Promise<void> {
    const custody = deps.custody
    const d = o.delivered as Delivered | null
    if (!custody || !d?.wnear || o.kind !== 'nearkits' || o.userId === null || !o.walletId) return unwrapNeeded(o, 'NEARKITS can’t unwrap it here.')
    const wallet = await custody.store.ownedWallet(o.userId, o.walletId)
    if (!wallet) return unwrapNeeded(o, 'The wallet isn’t one of your active NEARKITS wallets any more.')
    const stage2 = { ...o.stage2 }
    if (!stage2.unwrapIntent) {
      const blocked = await custody.ops.blocked('unwrap', wallet)
      if (blocked) return unwrapNeeded(o, blocked, stage2)
      const params: UnwrapParams = { amount: d.wnear }
      const intent = await custody.store.createIntent({ walletId: wallet.id, userId: o.userId, chatId: 0, kind: 'unwrap', params, ttlMs: UNWRAP_TTL_MS, groupId: `br-${o.id}` })
      stage2.unwrapIntent = intent.id
      await store.update(o.id, { stage2 })
      const r = await custody.engine.execute(intent.id, o.userId)
      if (r.kind === 'refused') {
        await custody.store.setStatus(intent.id, ['quoted'], 'cancelled')
        const tries = (stage2.attempts ?? 0) + 1
        const next = { ...stage2, unwrapIntent: null, attempts: tries }
        if (tries >= BUSY_TRIES) return unwrapNeeded(o, 'The wallet stayed busy with another transaction, so it wasn’t unwrapped.', next)
        return void (await store.update(o.id, { stage2: next, nextCheckAt: deps.now() + 20_000 }))
      }
      if (r.kind === 'pending') return void (await store.update(o.id, { nextCheckAt: deps.now() + 10_000 }))
    }
    const u = settled(await custody.store.intent(stage2.unwrapIntent as string))
    if (!u) return void (await store.update(o.id, { nextCheckAt: deps.now() + 10_000 }))
    if (u.status !== 'done' || !u.result?.ok) return unwrapNeeded(o, `${failText(u.result, 'Unwrapping failed')}.`, stage2)
    const unwrapped = { amount: d.wnear, txs: u.result.hashes.map(nearTx) }
    await store.update(o.id, { status: 'complete', stage2: { ...stage2, unwrapped }, message: null, nextCheckAt: null }, ['unwrapping'])
    log.info('bridge order complete (unwrapped)', { order: o.id })
  }

  /**
   * A connected wallet's own unwrap of a Bridge's wNEAR, from its transaction: signed by the order's
   * account, final, and native NEAR came back to that account from the wrap contract (its
   * near_withdraw succeeded). Only then is the order complete.
   */
  async function settleUnwrap(o: BridgeOrder, txHash: string): Promise<BridgeOrderView> {
    if (o.status !== 'delivered' && o.status !== 'unwrap-needed') throw new HttpError(409, 'state', 'The wNEAR hasn’t arrived yet.')
    const hash = txHash.trim()
    if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(hash)) throw new HttpError(400, 'tx', 'That isn’t a NEAR transaction hash.')
    let tx: NormalizedTx | null
    try {
      tx = await nearTxOf(hash)
    } catch {
      throw new HttpError(503, 'chain', 'NEARKITS can’t read that transaction right now. Try again in a moment.')
    }
    if (!tx || !isComplete(tx)) throw new HttpError(409, 'pending', 'That transaction isn’t final on NEAR yet. Try again in a moment.')
    if (tx.signerId !== o.recipient) throw new HttpError(400, 'tx', `That transaction wasn’t signed by ${o.recipient}.`)
    const native = flowsOf(tx, { wrapContract: wrap })
      .filter((f) => f.asset === 'near' && f.kind === 'native' && f.from === wrap && f.to === o.recipient)
      .reduce((s, f) => s + f.amount, 0n)
    if (native === 0n) throw new HttpError(400, 'tx', `That transaction didn’t unwrap wNEAR to NEAR in ${o.recipient}.`)
    const unwrapped = { amount: native.toString(), txs: [nearTx(hash)] }
    await store.update(o.id, { status: 'complete', stage2: { ...o.stage2, unwrapped }, message: null, nextCheckAt: null }, ['delivered', 'unwrap-needed'])
    log.info('bridge order complete (connected wallet unwrapped)', { order: o.id })
    return viewOf((await store.get(o.id)) as BridgeOrder)
  }

  /** The engine didn't take the intent (the wallet was busy): nothing ran. Drop it and try again shortly, a few times. */
  async function busy(o: BridgeOrder, stage2: BridgeOrder['stage2'], intentId: string, key: 'unwrapIntent' | 'buyIntent', giveUp: string) {
    await deps.custody?.store.setStatus(intentId, ['quoted'], 'cancelled')
    const tries = (stage2.attempts ?? 0) + 1
    const next = { ...stage2, [key]: null, attempts: tries }
    if (tries >= BUSY_TRIES) return buyNeeded(o, giveUp, next)
    await store.update(o.id, { stage2: next, nextCheckAt: deps.now() + 20_000 })
  }

  /** The purchase's minimum is at least what the user accepted per NEAR, for what it spends. */
  function withinBound(o: BridgeOrder, spend: bigint, minOut: bigint): boolean {
    if (!o.kitsMinPerNear) return false
    return minOut >= (BigInt(o.kitsMinPerNear) * spend) / ONE_NEAR
  }

  return {
    enabledChains,

    /** Chains and fee, for the page: only what NEAR Intents supports right now. */
    async assets() {
      let on: { chain: BridgeChain; priceUsd: number | null }[]
      try {
        on = await enabledChains()
      } catch (e) {
        throw toHttp(e)
      }
      return {
        chains: on.map(({ chain, priceUsd }) => ({ id: chain.id, name: chain.name, symbol: chain.symbol, decimals: chain.decimals, priceUsd })),
        destination: { token, ...(await tokenMeta().catch(() => ({ symbol: 'KITS', name: 'Near Kits', decimals: 18 }))) },
        feeBps: BRIDGE_FEE_BPS,
        tradingFeeBps: NEARKIT_FEE_BPS,
        custody: deps.custody !== null,
      }
    },

    /** A price for the page (dry: no deposit address, nothing to send to). */
    async preview(input: BridgeQuoteInput): Promise<BridgeQuoteView> {
      return (await quoteFor(input, true)).view
    },

    /**
     * The order: a real quote with its deposit address, bound to the destination, amount and fee.
     * Nothing moves until the user's own wallet sends the amount to the deposit address.
     */
    async start(input: BridgeQuoteInput): Promise<BridgeOrderView> {
      const { product } = input
      const paused = await deps.ops.bridgeBlocked()
      if (paused) throw new HttpError(409, 'paused', product === 'bridge' ? paused.replace(/^Bridge & Buy/, 'Bridge') : paused)
      const dest = await destinationOf(input.destination, product)
      if (product === 'buy-kits') {
        if (dest.wallet && deps.custody) {
          const blocked = await deps.custody.ops.blocked('buy', dest.wallet)
          if (blocked) throw new HttpError(409, 'paused', blocked)
        }
        // NEAR Intents delivers to an existing account: a new NEARKITS wallet needs a first deposit.
        const state = await accountState(near.ctx.rpc, dest.accountId, 'final').catch(() => null)
        if (!state) throw new HttpError(503, 'chain', 'The NEAR network isn’t answering right now. Try again in a moment.')
        if (!state.exists)
          throw new HttpError(409, 'not-on-chain', `${dest.accountId} isn’t on NEAR yet. Send it a little NEAR first: it needs NEAR for the network fees of the $KITS purchase.`)
      }
      // A Bridge goes only where the wNEAR can arrive (and, for a NEARKITS wallet, be unwrapped now): checked
      // before NEAR Intents is asked for a deposit address, so a refused destination never gets one.
      if (product === 'bridge') {
        const pre = await receivability(dest, input.destination.kind)
        if (pre.blocked) {
          const code = pre.code ?? 'destination'
          throw new HttpError(code === 'chain' ? 503 : 409, code, `${pre.blocked} Nothing was sent.`)
        }
      }
      const r = await quoteFor(input, false)
      const okAddress = r.chain.family === 'solana' ? isSolanaAddress(r.q.depositAddress ?? '') : isEvmAddress(r.q.depositAddress ?? '')
      if (!okAddress || r.q.deadline === null) throw new HttpError(502, 'route', 'Route temporarily unavailable. Nothing was sent.')
      const now = deps.now()
      if (r.q.deadline < now + BRIDGE_SIGN_WINDOW_MS + 5 * 60_000) throw new HttpError(502, 'route', 'NEAR Intents offered too short a window. Get a new quote.')
      let kitsMinPerNear: string | null = null
      if (product === 'buy-kits') {
        if (!r.est.kits) throw new HttpError(503, 'kits-price', `${r.est.reason ?? 'NEARKITS can’t price $KITS right now.'} Nothing was sent.`)
        kitsMinPerNear = ((BigInt(r.est.kits.minOut) * ONE_NEAR) / BigInt(r.est.kits.nearIn)).toString()
      }
      const order = await store
        .create({
          network: network.id,
          product,
          kind: input.destination.kind,
          userId: dest.userId,
          walletId: dest.wallet?.id ?? null,
          recipient: dest.accountId,
          chain: r.chain.id,
          originAsset: r.chain.assetId,
          sourceAddress: r.refundTo,
          amountIn: r.q.amountIn.toString(),
          depositAddress: r.q.depositAddress as string,
          depositDeadline: r.q.deadline,
          signBy: Math.min(now + BRIDGE_SIGN_WINDOW_MS, r.q.deadline - 10 * 60_000),
          quote: r.view,
          oneclick: r.q.raw,
          kitsMinPerNear,
          kitsSlippage: product === 'buy-kits' ? (input.kitsSlippagePct as number) : 0,
          nextCheckAt: now + 12_000,
        })
        .catch((e: unknown) => {
          // One deposit address is one order: 1Click handing out one twice is refused, never merged.
          log.error('bridge: could not save the order', { chain: r.chain.id, error: e })
          throw new HttpError(502, 'route', 'Route temporarily unavailable. Nothing was sent.')
        })
      log.info('bridge order created', { order: order.id, product, chain: r.chain.id, usd: r.q.amountInUsd, destination: order.kind })
      return view(order, dest.wallet)
    },

    /**
     * A Bridge whose unwrap stopped (unwrap-needed): its owner asks NEARKITS to unwrap it now. Once
     * per request, never by itself: the order moves back to unwrapping and the worker runs one new
     * unwrap intent of exactly the wNEAR delivered (or what the wallet still holds of it, if less).
     */
    async retryUnwrap(o: BridgeOrder): Promise<BridgeOrderView> {
      if (o.product !== 'bridge' || o.kind !== 'nearkits' || o.status !== 'unwrap-needed')
        throw new HttpError(409, 'state', 'Only a Bridge to a NEARKITS wallet whose wNEAR wasn’t unwrapped can be unwrapped here.')
      const d = o.delivered as Delivered | null
      if (!d?.wnear || !deps.custody || !o.walletId || o.userId === null) throw new HttpError(409, 'state', 'There’s no wNEAR to unwrap for this order.')
      const wallet = await deps.custody.store.ownedWallet(o.userId, o.walletId)
      if (!wallet) throw new HttpError(409, 'state', 'The wallet isn’t one of your active NEARKITS wallets any more.')
      const blocked = await deps.custody.ops.blocked('unwrap', wallet)
      if (blocked) throw new HttpError(409, 'paused', blocked)
      let held: bigint
      try {
        held = await near.ctx.reader.balanceOf(wrap, wallet.accountId)
      } catch {
        throw new HttpError(503, 'chain', 'NEARKITS can’t read the wallet on NEAR right now. Try again in a moment.')
      }
      const amount = held < BigInt(d.wnear) ? held : BigInt(d.wnear)
      if (amount === 0n) throw new HttpError(409, 'state', 'The wallet holds no wNEAR now: it was unwrapped or used already.')
      const moved = await store.update(
        o.id,
        {
          status: 'unwrapping',
          delivered: { ...d, wnear: amount.toString() } as BridgeOrder['delivered'],
          stage2: { ...o.stage2, unwrapIntent: null, attempts: 0 },
          message: 'Unwrapping the wNEAR to NEAR.',
          nextCheckAt: deps.now(),
        },
        ['unwrap-needed'],
      )
      if (!moved) throw new HttpError(409, 'state', 'This order moved on already.')
      log.info('bridge: unwrap asked again by its owner', { order: o.id })
      return viewOf((await store.get(o.id)) as BridgeOrder)
    },

    /** The user's source transaction, after their wallet sent it (or as they paste it): followed sooner. */
    async recordDeposit(o: BridgeOrder, txHash: string): Promise<BridgeOrderView> {
      const chain = bridgeChain(o.chain) as BridgeChain
      const hash = txHash.trim()
      if (!isSourceTxHash(chain, hash)) throw new HttpError(400, 'tx', `That isn’t a ${chain.name} transaction hash.`)
      if (o.depositTx && o.depositTx !== hash) throw new HttpError(409, 'tx', 'A different transaction is already recorded for this order.')
      if (o.depositTx !== hash) {
        if (!(await store.update(o.id, { depositTx: hash, nextCheckAt: deps.now() + 3_000 }, BRIDGE_IN_TRANSIT)))
          throw new HttpError(409, 'state', 'This order isn’t waiting for a transfer any more.')
        // Optional for NEAR Intents (it finds deposits itself): it only makes it notice sooner.
        void oneclick.submitDeposit(o.depositAddress, hash).catch((e) => log.info('bridge: deposit submit failed (optional)', { order: o.id, error: e }))
        log.info('bridge deposit recorded', { order: o.id, chain: chain.id })
      }
      return viewOf((await store.get(o.id)) as BridgeOrder)
    },

    /**
     * A connected wallet's purchase, from its transaction: signed by the order's account, succeeded,
     * and $KITS arrived in that account. Only then is the order complete.
     */
    async settleConnected(o: BridgeOrder, txHash: string): Promise<BridgeOrderView> {
      if (o.kind !== 'connected')
        throw new HttpError(409, 'state', o.product === 'bridge' ? 'Only a connected wallet’s unwrap is checked here.' : 'NEARKITS buys $KITS for NEARKITS wallets itself.')
      if (o.status === 'complete') return viewOf(o)
      if (o.product === 'bridge') return settleUnwrap(o, txHash)
      if (o.status !== 'delivered' && o.status !== 'buy-needed') throw new HttpError(409, 'state', 'The NEAR hasn’t arrived yet.')
      const hash = txHash.trim()
      if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(hash)) throw new HttpError(400, 'tx', 'That isn’t a NEAR transaction hash.')
      let tx: NormalizedTx | null
      try {
        tx = await nearTxOf(hash)
      } catch {
        throw new HttpError(503, 'chain', 'NEARKITS can’t read that transaction right now. Try again in a moment.')
      }
      if (!tx) throw new HttpError(409, 'pending', 'That transaction isn’t on NEAR yet. Try again in a moment.')
      if (tx.signerId !== o.recipient) throw new HttpError(400, 'tx', `That transaction wasn’t signed by ${o.recipient}.`)
      const kits = flowsOf(tx, { wrapContract: wrap })
        .filter((f) => f.asset === token && f.to === o.recipient && f.kind === 'transfer')
        .reduce((s, f) => s + f.amount, 0n)
      if (kits === 0n) throw new HttpError(400, 'tx', `That transaction didn’t bring $KITS to ${o.recipient}.`)
      await store.update(o.id, { status: 'complete', kits: { amount: kits.toString(), txs: [nearTx(hash)] }, message: null, nextCheckAt: null }, ['delivered', 'buy-needed'])
      log.info('bridge order complete (connected wallet)', { order: o.id })
      return viewOf((await store.get(o.id)) as BridgeOrder)
    },

    /** One step of an order: NEAR Intents' status while in transit, the purchase once NEAR arrived. */
    async step(o: BridgeOrder): Promise<void> {
      if (BRIDGE_IN_TRANSIT.includes(o.status) || o.status === 'failed') return stepTransit(o)
      if (o.product === 'bridge') {
        if (o.status === 'unwrapping' && o.kind === 'nearkits') return stepUnwrap(o)
      } else if ((o.status === 'delivered' || o.status === 'buying') && o.kind === 'nearkits') return stepPurchase(o)
      await store.update(o.id, { nextCheckAt: null })
    },

    view: viewOf,

    /** An order by id: a NEARKITS order only for its own user; a connected or external one for whoever holds its id. */
    async orderFor(id: string, userId: number | null): Promise<BridgeOrder> {
      const o = typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id) ? await store.get(id) : null
      if (!o || o.network !== network.id || (o.kind === 'nearkits' && o.userId !== userId)) throw new HttpError(404, 'not-found', 'That bridge order isn’t yours, or it’s gone.')
      return o
    },

    async ordersOf(userId: number): Promise<BridgeOrderView[]> {
      return Promise.all((await store.ofUser(userId, network.id)).map(viewOf))
    },
  }
}

export type BridgeService = ReturnType<typeof bridgeFor>
