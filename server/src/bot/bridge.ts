import { BRIDGE_CHAINS, BRIDGE_DEADLINE_MS, BRIDGE_SIGN_WINDOW_MS, bridgeChain, type BridgeChain, type BridgeChainId } from '@/config/bridge'
import { NEAR_DECIMALS } from '@/config/networks'
import { formatUnits, tryParseUnits } from '@/lib/amounts'
import { sourceAddressError } from '@/lib/bridge/addresses'
import { BRIDGE_FINAL, type BridgeOrderStatus, type BridgeOrderView, type BridgeQuoteView, type BridgeTx } from '@/lib/bridge/types'
import { BRIDGE_FEE_LABEL } from '@/lib/fees'
import { HttpError } from '../api/http'
import type { BridgeQuoteInput } from '../bridge/service'
import type { BridgeOrder } from '../bridge/store'
import { walletName } from '../custody/limits'
import type { TradingWallet } from '../custody/store'
import { randomToken } from '../ids'
import { bold, code, esc, link, plainText, shortAccount } from '../telegram/html'
import type { InlineKeyboard } from '../telegram/types'
import { btn, copyBtn, documented, FLOW_TTL_MS, keyboard, urlBtn, type BotCtx, type BotDeps, type BotModule } from './context'
import { Buckets } from './ratelimit'
import { flowWallet, newWalletButton, tradingWallet } from './tradingWallet'

/**
 * The Bridge to NEAR in Telegram: SOL, ETH or BNB → NEAR in the user's own NEARKITS wallet, through
 * NEAR Intents, on exactly the web's Bridge (server/src/bridge/): its quote and fee check (0.25% for
 * NEARKITS, confirmed from every quote; NEAR Intents' own fee as its quote charges it), its orders, its
 * worker, its on-chain delivery check and NEARKITS' unwrap of the wNEAR NEAR Intents delivers. The bot
 * only asks and shows; it adds no fee, no order kind and no second way to move funds.
 *
 * Two ways in:
 * - Connect wallet: NEARKITS' Mini App (the /tg page, Telegram's signed launch data naming the user)
 *   opens its Bridge, where the user's own Solana or EVM wallet sends.
 * - Send manually: the bot asks the chain, the wallet, the amount and the user's refund address,
 *   prices it live, and only on Create asks NEAR Intents for a deposit address: the order's own,
 *   once per review (the review's request key), shown with what to send, where, by when, and what
 *   happens to anything else. Funds sent there are followed by the worker; nothing here marks a
 *   deposit as paid, and nothing replaces an order's address.
 *
 * Every screen reads the order again and shows it only to its own Telegram user (a NEARKITS wallet's
 * order); an id someone guessed shows nothing. Notices follow the worker's status changes, each once.
 */

const NS = 'brg'
const CALLBACK_TTL_MS = 30 * 60_000
/** A review older than this is priced again before any deposit address is asked for. */
export const REVIEW_TTL_MS = 3 * 60_000
const PER_PAGE = 6

interface Draft {
  chain: BridgeChainId
  walletId: string
  amount?: string
  source?: string
}

interface Review {
  chain: BridgeChainId
  walletId: string
  amount: string
  source: string
  /** The review's request key: Create asks with it, so pressing it twice makes one order. */
  key: string
  quotedAt: number
}

// Per user: quotes ask NEAR Intents (6 a minute, as a trade's), a deposit address is a real order (5, then one every 2 minutes).
const limits = new WeakMap<object, { quotes: Buckets; orders: Buckets }>()
function allowed(ctx: BotCtx, kind: 'quotes' | 'orders'): boolean {
  let l = limits.get(ctx.deps)
  if (!l) {
    l = { quotes: new Buckets(6, 6 / 60, ctx.deps.now), orders: new Buckets(5, 1 / 120, ctx.deps.now) }
    limits.set(ctx.deps, l)
  }
  return l[kind].take(String(ctx.user.id))
}

const menuRow = [btn('« Menu', 'menu:home')]
const cancelRow = [btn('✖ Cancel', `${NS}:x`)]
const chainOf = (id: string): BridgeChain | null => bridgeChain(id)
const exact = (raw: string | bigint, decimals: number) => formatUnits(BigInt(raw), decimals)
const shown = (raw: string | bigint, decimals: number, maxFraction = 6) => formatUnits(BigInt(raw), decimals, { maxFraction, group: true })
const nearShown = (yocto: string | bigint) => shown(yocto, NEAR_DECIMALS, 4)
const utc = (ms: number) => `${new Date(ms).toISOString().slice(11, 16)} UTC`
const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`
const eta = (seconds: number) => (seconds < 60 ? `~${Math.max(1, Math.round(seconds))} s` : `~${Math.round(seconds / 60)} min`)
const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`
const txLine = (label: string, txs: readonly BridgeTx[]) => (txs.length ? `${label}: ${txs.map((t, i) => link(t.url, txs.length > 1 ? `tx ${i + 1}` : 'view')).join(', ')}` : null)

/** The Mini App's Bridge: NEARKITS' bot opens its Mini App with the start parameter "bridge" (Telegram signs it). */
export const miniAppBridgeUrl = (deps: Pick<BotDeps, 'me'>) => `https://t.me/${deps.me.username}?startapp=bridge`

/** Whether the bridge runs here (mainnet, with NEAR Intents set up). */
const bridgeOf = (ctx: BotCtx) => ctx.deps.bridge ?? null

async function activeWallets(ctx: BotCtx): Promise<TradingWallet[]> {
  return ctx.deps.custody ? ctx.deps.custody.store.activeWallets(ctx.user.id, ctx.deps.config.network.id) : []
}

/** What the server refused, in its own words (the bridge's errors are written for people). */
function refusal(e: unknown, ctx: BotCtx): string {
  if (e instanceof HttpError) return e.message
  ctx.deps.log.warn('bridge (Telegram) failed', { error: e })
  return 'The Bridge can’t answer right now. Nothing was sent. Try again in a moment.'
}

// ─── the Bridge's home ───────────────────────────────────────────────────────

export async function bridgeHome(ctx: BotCtx) {
  const b = bridgeOf(ctx)
  if (!b) {
    return ctx.show(
      [`🌉 ${bold('Bridge to NEAR')}`, '', `The Bridge runs on NEAR mainnet. This NEARKITS bot runs on NEAR ${esc(ctx.deps.config.network.label)}.`].join('\n'),
      keyboard(menuRow),
    )
  }
  const paused = await b.service.pausedReason('bridge').catch(() => null)
  const wallets = await activeWallets(ctx)
  const lines = [
    `🌉 ${bold('Bridge to NEAR')}`,
    'Move SOL, ETH or BNB from Solana, Ethereum or BNB Chain into your NEARKITS wallet, through NEAR Intents.',
    '',
    `🔗 ${bold('Connect wallet')}: opens the NEARKITS Mini App for a live quote. Inside Telegram there’s usually no wallet to connect: you enter the address you send from, then send from your wallet app.`,
    `✍️ ${bold('Send manually')}: get a deposit address for one order and send from any wallet you control.`,
    '',
    `Fee: NEARKITS ${esc(BRIDGE_FEE_LABEL)}, plus NEAR Intents’ own fee, both shown in the live quote. NEAR arrives as wNEAR; NEARKITS unwraps it to native NEAR in your wallet.`,
  ]
  if (paused) lines.push('', `⏸ ${esc(paused)} Orders already under way are still followed.`)
  const rows: (ReturnType<typeof btn> | null)[][] = []
  if (!paused && wallets.length) rows.push([urlBtn('🔗 Connect wallet', miniAppBridgeUrl(ctx.deps))], [btn('✍️ Send manually', `${NS}:man`)])
  if (!wallets.length) {
    lines.push('', 'You need a NEARKITS wallet to bridge into. Create one first: it takes a tap.')
    if (ctx.deps.custody) rows.push([newWalletButton('💼 Create wallet')])
  }
  rows.push([btn('📋 My bridge orders', `${NS}:list`)], [btn('« Back', 'menu:home')])
  await ctx.show(lines.join('\n'), keyboard(...rows))
}

// ─── Send manually: chain, wallet, amount, refund address ───────────────────

async function chooseChain(ctx: BotCtx) {
  const b = bridgeOf(ctx)
  if (!b) return bridgeHome(ctx)
  const paused = await b.service.pausedReason('bridge').catch(() => null)
  if (paused) return ctx.show(`⏸ ${esc(paused)} Nothing can be started now.`, keyboard([btn('📋 My bridge orders', `${NS}:list`)], menuRow))
  if (!(await activeWallets(ctx)).length) return bridgeHome(ctx)
  let offered: string[]
  try {
    offered = (await b.service.assets()).chains.map((c) => c.id)
  } catch (e) {
    return ctx.show(`⚠️ ${esc(refusal(e, ctx))}`, keyboard([btn('🔄 Try again', `${NS}:man`)], menuRow))
  }
  const down = BRIDGE_CHAINS.filter((c) => !offered.includes(c.id))
  await ctx.show(
    [
      `✍️ ${bold('Send manually')} · step 1 of 4`,
      'Which coin do you send, and from which network?',
      ...(down.length ? ['', `Not available from NEAR Intents right now: ${esc(down.map((c) => `${c.symbol} (${c.name})`).join(', '))}.`] : []),
    ].join('\n'),
    keyboard(...BRIDGE_CHAINS.filter((c) => offered.includes(c.id)).map((c) => [btn(`${c.name} · ${c.symbol}`, `${NS}:ch:${c.id}`)]), [btn('« Back', `${NS}:home`)]),
  )
}

async function chooseWallet(ctx: BotCtx, chain: BridgeChain) {
  const all = await activeWallets(ctx)
  const wallets = all.filter((w) => w.frozenAt === null)
  if (!all.length) return bridgeHome(ctx)
  // Every wallet frozen: none is a destination (the server refuses one too), and the bot says why.
  if (!wallets.length)
    return ctx.show(
      '⚠️ Your NEARKITS wallets are frozen by NEARKITS for your protection, so none can receive a bridge now.',
      keyboard([btn('👛 Wallet', 'cw:home')], [btn('« Back', `${NS}:home`)]),
    )
  if (wallets.length === 1) return askAmount(ctx, { chain: chain.id, walletId: (wallets[0] as TradingWallet).id })
  const selected = (await tradingWallet(ctx.deps, ctx.user.id))?.id
  const ids = await Promise.all(wallets.map((w) => ctx.deps.store.putCallback({ chain: chain.id, walletId: w.id } satisfies Draft, ctx.user.id, ctx.chat.id, CALLBACK_TTL_MS)))
  await ctx.show(
    [`✍️ ${bold('Send manually')} · step 2 of 4`, `Which NEARKITS wallet receives the NEAR?`].join('\n'),
    keyboard(...wallets.map((w, i) => [btn(`${w.id === selected ? '✅ ' : ''}${w.slot}. ${walletName(w)} · ${shortAccount(w.accountId, 18)}`, `${NS}:w:${ids[i]}`)]), [
      btn('« Back', `${NS}:man`),
    ]),
  )
}

async function askAmount(ctx: BotCtx, draft: Draft) {
  const chain = chainOf(draft.chain) as BridgeChain
  const wallet = await flowWallet(ctx, draft.walletId)
  if (!wallet) return bridgeHome(ctx)
  await ctx.deps.store.setSession(ctx.chat.id, ctx.user.id, 'bridge.amount', { chain: draft.chain, walletId: draft.walletId } satisfies Draft, FLOW_TTL_MS)
  await ctx.show(
    [
      `✍️ ${bold('Send manually')} · step 3 of 4`,
      `How much ${esc(chain.symbol)} do you send from ${esc(chain.name)}? Send the amount, e.g. 0.5.`,
      '',
      `To: ${bold(walletName(wallet))} ${esc(shortAccount(wallet.accountId))}`,
      'NEAR Intents sets a minimum per route: a smaller amount is refused with the minimum.',
    ].join('\n'),
    keyboard(cancelRow),
  )
}

async function askSource(ctx: BotCtx, draft: Draft & { amount: string }) {
  const chain = chainOf(draft.chain) as BridgeChain
  const last = await bridgeOf(ctx)
    ?.store.lastSourceAddress(ctx.user.id, ctx.deps.config.network.id, chain.id)
    .catch(() => null)
  await ctx.deps.store.setSession(ctx.chat.id, ctx.user.id, 'bridge.source', draft, FLOW_TTL_MS)
  const use = last ? await ctx.deps.store.putCallback({ ...draft, source: last } satisfies Draft, ctx.user.id, ctx.chat.id, CALLBACK_TTL_MS) : null
  await ctx.show(
    [
      `✍️ ${bold('Send manually')} · step 4 of 4`,
      `Send your own ${esc(chain.name)} address for refunds.`,
      '',
      `If NEAR Intents can’t complete the bridge, or more than the quote arrives, it refunds there. Use an address you control, not an exchange deposit address.`,
    ].join('\n'),
    keyboard(...(use && last ? [[btn(`Use ${shortAccount(last, 20)}`, `${NS}:src:${use}`)]] : []), cancelRow),
  )
}

// ─── the review: a live price, nothing to send to yet ───────────────────────

function inputOf(ctx: BotCtx, r: Pick<Review, 'chain' | 'walletId' | 'amount' | 'source'>): BridgeQuoteInput {
  return {
    product: 'bridge',
    chain: r.chain,
    amount: r.amount,
    sourceAddress: r.source,
    destination: { kind: 'nearkits', userId: ctx.user.id, walletId: r.walletId },
    kitsSlippagePct: null,
  }
}

function feeLines(chain: BridgeChain, q: BridgeQuoteView): string[] {
  return [
    `NEARKITS bridge fee (${esc(pct(q.fee.nearkitsBps))}): ${bold(`${shown(q.fee.nearkitsRaw, chain.decimals)} ${chain.symbol}`)}`,
    `NEAR Intents fee (${esc(pct(q.fee.intentsBps))}): ${bold(`${shown(q.fee.intentsRaw, chain.decimals)} ${chain.symbol}`)}`,
    `${esc(chain.name)} network fee: paid by the wallet that sends`,
  ]
}

/** What NEAR Intents does with a transfer that isn't exactly the order's (its 1Click API's own rules). */
function depositRules(chain: BridgeChain, amount: string, closesAt: string | null): string[] {
  return [
    `• Send only ${bold(chain.symbol)} on ${bold(chain.name)}. Another coin or another network isn’t this order’s and can be lost.`,
    `• Send exactly ${bold(`${amount} ${chain.symbol}`)}. Less: NEAR Intents refunds it to your refund address by the deadline. More: it bridges the order and refunds the excess there.`,
    `• ${closesAt ? `The address closes at ${bold(closesAt)}` : `The address takes deposits for ${minutes(BRIDGE_DEADLINE_MS)}`}: anything sent after that may be lost.`,
    '• A blockchain transfer can’t be reversed. Check the address before you send.',
  ]
}

async function review(ctx: BotCtx, draft: Required<Draft>, note?: string) {
  const b = bridgeOf(ctx)
  if (!b) return bridgeHome(ctx)
  const chain = chainOf(draft.chain) as BridgeChain
  const wallet = await flowWallet(ctx, draft.walletId)
  if (!wallet) return bridgeHome(ctx)
  const again = await ctx.deps.store.putCallback(draft, ctx.user.id, ctx.chat.id, CALLBACK_TTL_MS)
  if (!allowed(ctx, 'quotes')) return ctx.show('⏳ Too many quotes in a minute. Wait a moment, then refresh.', keyboard([btn('🔄 Refresh quote', `${NS}:rq:${again}`)], cancelRow))
  let q: BridgeQuoteView
  try {
    q = await b.service.preview(inputOf(ctx, draft))
  } catch (e) {
    return ctx.show(`⚠️ ${esc(refusal(e, ctx))}`, keyboard([btn('🔄 Try again', `${NS}:rq:${again}`)], [btn('✏️ Change amount', `${NS}:amt:${again}`)], cancelRow))
  }
  const blocked = q.delivery?.blocked ?? null
  const reviewed: Review = { ...draft, key: `tg-${randomToken(16)}`, quotedAt: ctx.deps.now() }
  const go = await ctx.deps.store.putCallback(reviewed, ctx.user.id, ctx.chat.id, CALLBACK_TTL_MS)
  await ctx.show(
    [
      `🌉 ${bold(`Review · ${chain.symbol} → NEAR`)}`,
      ...(note ? [esc(note)] : []),
      '',
      `You send: ${bold(`${exact(q.amountIn, chain.decimals)} ${chain.symbol}`)} on ${esc(chain.name)}`,
      ...feeLines(chain, q),
      `You receive: ${bold(`≈ ${nearShown(q.nearOut)} NEAR`)} (at least ${esc(nearShown(q.nearMinOut))})`,
      'It arrives as wNEAR; NEARKITS unwraps it to native NEAR in your wallet (≈ 0.0005 NEAR network fee, on NEAR).',
      `To: ${bold(walletName(wallet))} ${esc(shortAccount(wallet.accountId))}`,
      `Refunds go to: ${esc(shortAccount(draft.source, 24))}`,
      `Estimated time: ${esc(eta(q.timeEstimateSec))} after your deposit`,
      '',
      ...(blocked
        ? [`⚠️ ${esc(blocked)}`]
        : [
            bold('Before you create the deposit address'),
            ...depositRules(chain, exact(q.amountIn, chain.decimals), null),
            `• Send within ${minutes(BRIDGE_SIGN_WINDOW_MS)} of creating it, so the quote still holds.`,
          ]),
    ].join('\n'),
    keyboard(
      blocked ? [] : [btn('✅ Create deposit address', `${NS}:go:${go}`)],
      [btn('🔄 Refresh quote', `${NS}:rq:${again}`), btn('✏️ Change amount', `${NS}:amt:${again}`)],
      cancelRow,
    ),
  )
}

/** Create: the order and its deposit address, once per review (its request key), from a fresh quote. */
async function create(ctx: BotCtx, r: Review) {
  const b = bridgeOf(ctx)
  if (!b) return bridgeHome(ctx)
  // This review already made its order (a double tap, a press after a restart): show that one.
  const made = await b.store.byRequestKey(r.key)
  if (made) return made.userId === ctx.user.id ? orderScreen(ctx, made) : ctx.answer('That button isn’t yours.', true)
  if (ctx.deps.now() - r.quotedAt > REVIEW_TTL_MS)
    return review(ctx, { chain: r.chain, walletId: r.walletId, amount: r.amount, source: r.source }, 'That quote was over 3 minutes old. Here is a fresh one.')
  if (!allowed(ctx, 'orders')) return ctx.show('⏳ Too many deposit addresses in a short time. Wait a couple of minutes, then try again.', keyboard(menuRow))
  let v: BridgeOrderView
  try {
    v = await b.service.start(inputOf(ctx, r), { requestKey: r.key })
  } catch (e) {
    const again = await ctx.deps.store.putCallback(
      { chain: r.chain, walletId: r.walletId, amount: r.amount, source: r.source } satisfies Draft,
      ctx.user.id,
      ctx.chat.id,
      CALLBACK_TTL_MS,
    )
    return ctx.show(`⚠️ ${esc(refusal(e, ctx))}`, keyboard([btn('🔄 New quote', `${NS}:rq:${again}`)], cancelRow))
  }
  const o = await b.store.get(v.id)
  if (o) await orderScreen(ctx, o)
}

// ─── an order: its deposit instructions while open, then its progress ───────

/** The order, only for its own Telegram user (a NEARKITS wallet's order on this network); null for anything else. */
async function ownOrder(ctx: BotCtx, id: string): Promise<BridgeOrder | null> {
  const b = bridgeOf(ctx)
  if (!b || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) return null
  const o = await b.store.get(id)
  return o && o.network === ctx.deps.config.network.id && o.kind === 'nearkits' && o.userId === ctx.user.id ? o : null
}

/** The order's state in a few words, from what NEARKITS' server recorded (never from a press or a reply). */
export function bridgeStatusLabel(v: Pick<BridgeOrderView, 'status' | 'product' | 'depositTx' | 'depositDeadline' | 'delivered' | 'destination'>, now: number): string {
  const s: BridgeOrderStatus = v.status
  switch (s) {
    case 'awaiting-deposit':
      if (v.depositTx) return '⏳ Transfer sent, waiting for NEAR Intents'
      return now > v.depositDeadline ? '⌛ Deposit address closed, nothing seen yet' : '⏳ Waiting for deposit'
    case 'deposit-seen':
      return '📥 Deposit detected'
    case 'bridging':
      return '🔄 Bridge processing'
    case 'incomplete-deposit':
      return '⚠️ Less arrived than quoted'
    case 'delivered':
      return v.product === 'bridge' ? '📦 Received on NEAR as wNEAR' : '📦 NEAR received'
    case 'unwrapping':
      return '🔄 Unwrapping wNEAR to NEAR'
    case 'unwrap-needed':
      return '⚠️ Bridged, not unwrapped'
    case 'buying':
      return '🔄 Buying $KITS'
    case 'buy-needed':
      return '⚠️ Bridged, $KITS not bought'
    case 'complete':
      if (v.product !== 'bridge') return '✅ $KITS purchase complete'
      return v.delivered?.asset === 'wnear' && v.destination.kind === 'external' ? '✅ Delivered as wNEAR' : '✅ Completed: native NEAR available'
    case 'refunded':
      return '↩️ Refunded'
    case 'failed':
      return '⚠️ Failed at NEAR Intents: refund processing'
    case 'expired':
      return '⌛ Expired: nothing arrived'
  }
}

function summary(v: BridgeOrderView): string {
  const chain = chainOf(v.chain)
  const symbol = chain?.symbol ?? v.chain.toUpperCase()
  const sent = chain ? shown(v.quote.amountIn, chain.decimals, 4) : v.quote.amountIn
  return v.product === 'bridge' ? `${sent} ${symbol} → NEAR` : `${sent} ${symbol} → $KITS`
}

export async function orderScreen(ctx: BotCtx, o: BridgeOrder) {
  const b = bridgeOf(ctx)
  if (!b) return bridgeHome(ctx)
  const v = await b.service.view(o)
  const chain = chainOf(v.chain) as BridgeChain
  const now = ctx.deps.now()
  const q = v.quote
  const amount = exact(q.amountIn, chain.decimals)
  const open = v.status === 'awaiting-deposit' && now < v.depositDeadline
  const late = open && now > v.signBy && !v.depositTx
  const lines: string[] = [
    `🌉 ${bold(v.product === 'bridge' ? `Bridge · ${chain.symbol} → NEAR` : `Bridge & Buy · ${chain.symbol} → $KITS`)}`,
    `${bold(bridgeStatusLabel(v, now))}`,
  ]
  if (v.message) lines.push(esc(v.message))
  lines.push('')
  if (open && !v.depositTx) {
    lines.push(
      `📥 Send exactly ${code(amount)} ${bold(chain.symbol)} on ${bold(chain.name)} to this order’s deposit address:`,
      code(v.depositAddress),
      '',
      late
        ? `⚠️ The quote’s ${minutes(BRIDGE_SIGN_WINDOW_MS)} window passed at ${utc(v.signBy)}. Haven’t sent yet? Don’t: start a new bridge. Already sent? NEARKITS keeps following this order.`
        : `Send by ${bold(utc(v.signBy))} (within ${minutes(Math.max(60_000, v.signBy - now))}).`,
      ...depositRules(chain, amount, utc(v.depositDeadline)),
      '',
    )
  }
  lines.push(`Send: ${bold(`${amount} ${chain.symbol}`)} (${esc(chain.name)})`, `Expected: ≈ ${esc(nearShown(q.nearOut))} NEAR (at least ${esc(nearShown(q.nearMinOut))})`)
  if (v.product === 'bridge' && v.unwrapped) lines.push(`Received: ${bold(`${nearShown(v.unwrapped.amount)} NEAR`)} (native)`)
  else if (v.delivered)
    lines.push(
      `Received: ${bold(`${nearShown(v.delivered.amount)} ${v.delivered.asset === 'wnear' ? 'wNEAR' : 'NEAR'}`)}${v.delivered.asset === 'wnear' && v.status !== 'complete' ? ' (not unwrapped yet)' : ''}`,
    )
  if (v.kits) lines.push(`$KITS received: ${bold(shown(v.kits.amount, 18, 2))}`)
  lines.push(
    `To: ${bold(v.destination.name ?? 'NEARKITS wallet')} ${esc(shortAccount(v.destination.accountId))}`,
    `Fees: NEARKITS ${esc(pct(q.fee.nearkitsBps))} · NEAR Intents ${esc(pct(q.fee.intentsBps))}`,
    `Refunds go to: ${esc(shortAccount(v.sourceAddress, 24))}`,
  )
  if (v.refund)
    lines.push(
      `Refund: ${v.refund.amount ? bold(`${shown(v.refund.amount, chain.decimals)} ${chain.symbol}`) : 'amount not reported'}${v.refund.reason ? ` · ${esc(v.refund.reason)}` : ''}`,
    )
  const links = [
    v.depositTx ? txLine(`${chain.name} transfer`, [v.depositTx]) : null,
    v.delivered ? txLine('NEAR delivery', v.delivered.txs) : null,
    v.unwrapped ? txLine('Unwrap', v.unwrapped.txs) : null,
    v.refund ? txLine('Refund', v.refund.txs) : null,
  ].filter((l): l is string => l !== null)
  if (links.length) lines.push(...links)
  lines.push(`Order ${code(v.id)} · created ${utc(v.createdAt)}`)

  const rows: (ReturnType<typeof btn> | null)[][] = []
  if (open && !v.depositTx) rows.push([copyBtn('📋 Copy address', v.depositAddress), copyBtn('📋 Copy amount', amount)])
  if (v.status === 'unwrap-needed' && v.product === 'bridge') rows.push([btn('⬇️ Unwrap to NEAR now', `${NS}:uw:${v.id}`)])
  if (v.status === 'complete' && v.product === 'bridge') rows.push([btn('🟢 Buy', 'tr:buy'), btn('👛 Wallet', 'cw:home')])
  if (v.product === 'buy-kits' && !BRIDGE_FINAL.includes(v.status))
    rows.push([urlBtn('🌐 Open on NEARKITS web', `${ctx.deps.config.webUrl}/bridge?order=${encodeURIComponent(v.id)}`)])
  rows.push([btn('🔄 Refresh', `${NS}:o:${v.id}`), btn('📋 My bridge orders', `${NS}:list`)], menuRow)
  await ctx.show(lines.join('\n'), keyboard(...rows))
}

async function listOrders(ctx: BotCtx, page: number) {
  const b = bridgeOf(ctx)
  if (!b) return bridgeHome(ctx)
  const all = await b.service.ordersOf(ctx.user.id)
  if (!all.length) {
    return ctx.show([`📋 ${bold('My bridge orders')}`, '', 'No bridge orders yet.'].join('\n'), keyboard([btn('✍️ Send manually', `${NS}:man`)], [btn('« Back', `${NS}:home`)]))
  }
  const pages = Math.ceil(all.length / PER_PAGE)
  const p = Math.min(Math.max(0, page), pages - 1)
  const shownOrders = all.slice(p * PER_PAGE, (p + 1) * PER_PAGE)
  const now = ctx.deps.now()
  await ctx.show(
    [
      `📋 ${bold('My bridge orders')}${pages > 1 ? ` · page ${p + 1} of ${pages}` : ''}`,
      '',
      ...shownOrders.map((v, i) => `${p * PER_PAGE + i + 1}. ${esc(summary(v))} · ${esc(bridgeStatusLabel(v, now))} · ${utc(v.createdAt)}`),
    ].join('\n'),
    keyboard(
      ...shownOrders.map((v, i) => [btn(`${p * PER_PAGE + i + 1}. ${summary(v)}`, `${NS}:o:${v.id}`)]),
      [p > 0 ? btn('« Newer', `${NS}:list:${p - 1}`) : null, p < pages - 1 ? btn('Older »', `${NS}:list:${p + 1}`) : null],
      [btn('« Back', `${NS}:home`)],
    ),
  )
}

async function unwrapNow(ctx: BotCtx, id: string) {
  const b = bridgeOf(ctx)
  const o = await ownOrder(ctx, id)
  if (!b || !o) return ctx.answer('That bridge order isn’t yours, or it’s gone.', true)
  try {
    await b.service.retryUnwrap(o)
  } catch (e) {
    return ctx.answer(refusal(e, ctx), true)
  }
  // The answer promises a message: how this unwrap ends is announced even if it stops again.
  await b.store.claimNotice(o.id, UNWRAP_ASKED, [])
  await ctx.answer('Unwrapping: NEARKITS messages you when it’s done.')
  await orderScreen(ctx, (await b.store.get(o.id)) as BridgeOrder)
}

// ─── notices: what the worker saw, each once ────────────────────────────────

/** Which notice a status is, and the notices that come after it (a later one already sent stops an earlier one). */
const NOTICE: Partial<Record<BridgeOrderStatus, string>> = {
  'deposit-seen': 'deposit',
  bridging: 'deposit',
  delivered: 'deposit',
  unwrapping: 'deposit',
  'incomplete-deposit': 'incomplete',
  complete: 'complete',
  'unwrap-needed': 'unwrap-needed',
  refunded: 'refunded',
  failed: 'failed',
  expired: 'expired',
}
const FINAL_NOTICES = ['complete', 'unwrap-needed', 'refunded', 'failed', 'expired']
/**
 * Not a notice: what the order records when its user presses Unwrap to NEAR now, so that how that
 * unwrap ends is said too (complete, or unwrap-needed once more), and nothing said before it is repeated.
 */
const UNWRAP_ASKED = 'unwrap-asked'
const LATER: Record<string, readonly string[]> = { deposit: ['incomplete', UNWRAP_ASKED, ...FINAL_NOTICES], incomplete: [UNWRAP_ASKED, ...FINAL_NOTICES] }

export function bridgeNoticeText(v: BridgeOrderView): { text: string; markup: InlineKeyboard } | null {
  const chain = chainOf(v.chain)
  if (!chain) return null
  const amount = `${shown(v.quote.amountIn, chain.decimals)} ${chain.symbol}`
  const to = v.destination.name ?? 'your NEARKITS wallet'
  const view = btn('🌉 View order', `${NS}:o:${v.id}`)
  switch (NOTICE[v.status]) {
    case 'deposit':
      return {
        text: [`📥 ${bold('Deposit detected')} · ${esc(amount)} → NEAR`, `NEAR Intents is bridging it to ${bold(to)}. I’ll message you when the NEAR is there.`].join('\n'),
        markup: keyboard([view]),
      }
    case 'incomplete':
      return { text: [`⚠️ ${bold('Less arrived than quoted')} · ${esc(amount)} → NEAR`, esc(v.message ?? '')].join('\n'), markup: keyboard([view]) }
    case 'complete': {
      const got = v.unwrapped?.amount ?? v.delivered?.amount ?? null
      return {
        text: [
          `✅ ${bold('Bridge complete')} · ${esc(amount)} → NEAR`,
          got ? `${bold(`${nearShown(got)} NEAR`)} is in ${bold(to)}, native NEAR, ready for gas and trading.` : `The NEAR is in ${bold(to)}.`,
        ].join('\n'),
        markup: keyboard([btn('🟢 Buy', 'tr:buy'), btn('👛 Wallet', 'cw:home')], [view]),
      }
    }
    case 'unwrap-needed':
      return {
        text: [`⚠️ ${bold('Bridged, not unwrapped')} · ${esc(amount)} → NEAR`, esc(v.message ?? 'The wNEAR is in the wallet.')].join('\n'),
        markup: keyboard([btn('⬇️ Unwrap to NEAR now', `${NS}:uw:${v.id}`)], [view]),
      }
    case 'refunded':
      return {
        text: [
          `↩️ ${bold('Refunded')} · ${esc(amount)} → NEAR`,
          `NEAR Intents refunded ${v.refund?.amount ? bold(`${shown(v.refund.amount, chain.decimals)} ${chain.symbol}`) : 'it'} to ${esc(shortAccount(v.sourceAddress, 24))}. No NEAR was delivered.`,
        ].join('\n'),
        markup: keyboard([view]),
      }
    case 'failed':
      return { text: [`⚠️ ${bold('Bridge failed at NEAR Intents')} · ${esc(amount)} → NEAR`, esc(v.message ?? '')].join('\n'), markup: keyboard([view]) }
    case 'expired':
      return {
        text: [
          `⌛ ${bold('Bridge order expired')} · ${esc(amount)} → NEAR`,
          'Nothing arrived before its deposit address closed. Don’t send to that address any more: start a new bridge instead.',
        ].join('\n'),
        markup: keyboard([btn('🌉 Bridge to NEAR', `${NS}:home`)], [view]),
      }
    default:
      return null
  }
}

/**
 * Tells an order's Telegram user what the worker just saw (a Bridge to their NEARKITS wallet), once
 * per notice, whichever instance gets there first (the order records what it told). True when sent.
 */
export async function notifyBridgeOrder(deps: BotDeps, o: BridgeOrder, notify: (userId: number, html: string, markup?: InlineKeyboard) => Promise<boolean>): Promise<boolean> {
  const b = deps.bridge
  const key = NOTICE[o.status]
  if (!b || !key || o.product !== 'bridge' || o.kind !== 'nearkits' || o.userId === null) return false
  if (!(await b.store.claimNotice(o.id, key, LATER[key] ?? []))) return false
  const n = bridgeNoticeText(await b.service.view(o))
  if (!n) return false
  const sent = await notify(o.userId, n.text, n.markup)
  if (!sent) deps.log.info('bridge notice not delivered', { order: o.id, notice: key })
  return sent
}

// ─── the module ──────────────────────────────────────────────────────────────

export function bridgeModule(): BotModule {
  return {
    commands: {
      bridge: { ...documented('bridge'), run: (ctx) => bridgeHome(ctx) },
    },
    flows: {
      'bridge.amount': async (ctx, text, data) => {
        const draft = data as unknown as Draft
        const chain = chainOf(draft.chain)
        if (!chain) return void (await ctx.deps.store.clearSession(ctx.chat.id, ctx.user.id))
        const amount = plainText(text, 40).replace(',', '.').replace(/\s/g, '')
        const parsed = tryParseUnits(amount, chain.decimals)
        if (!parsed.ok || parsed.value <= 0n) {
          await ctx.reply(`Send an amount of ${esc(chain.symbol)} above 0, with at most ${chain.decimals} decimals, e.g. 0.5. /cancel to stop.`)
          return
        }
        await askSource(ctx, { ...draft, amount: formatUnits(parsed.value, chain.decimals) })
      },
      'bridge.source': async (ctx, text, data) => {
        const draft = data as unknown as Draft & { amount: string }
        const chain = chainOf(draft.chain)
        if (!chain) return void (await ctx.deps.store.clearSession(ctx.chat.id, ctx.user.id))
        const address = plainText(text, 128).trim()
        const problem = sourceAddressError(chain, address)
        if (problem) {
          await ctx.reply(`${esc(problem)} Send your own ${esc(chain.name)} address, or /cancel.`)
          return
        }
        await ctx.deps.store.clearSession(ctx.chat.id, ctx.user.id)
        await review(ctx, { ...draft, source: address })
      },
    },
    callbacks: {
      [NS]: async (ctx, action, arg) => {
        const { store } = ctx.deps
        switch (action) {
          case 'home':
            await ctx.answer()
            return bridgeHome(ctx)
          case 'man':
            await ctx.answer()
            await store.clearSession(ctx.chat.id, ctx.user.id)
            return chooseChain(ctx)
          case 'x':
            await store.clearSession(ctx.chat.id, ctx.user.id)
            await ctx.answer()
            return ctx.show('Cancelled. No deposit address was made.', keyboard([btn('🌉 Bridge to NEAR', `${NS}:home`)], menuRow))
          case 'ch': {
            await ctx.answer()
            const chain = chainOf(arg)
            if (!chain) return chooseChain(ctx)
            return chooseWallet(ctx, chain)
          }
          case 'list':
            await ctx.answer()
            return listOrders(ctx, Number.parseInt(arg || '0', 10) || 0)
          case 'o': {
            const o = await ownOrder(ctx, arg)
            if (!o) return ctx.answer('That bridge order isn’t yours, or it’s gone.', true)
            await ctx.answer()
            return orderScreen(ctx, o)
          }
          case 'uw':
            return unwrapNow(ctx, arg)
        }
        // Buttons that carry a step's data (kept server-side, for this user only).
        const payload = await store.getCallback<Draft & Partial<Review>>(arg, ctx.user.id)
        if (!payload || !chainOf(payload.chain)) return ctx.answer('That button expired. Start again with /bridge.', true)
        if (!(await flowWallet(ctx, payload.walletId))) {
          await ctx.answer()
          return bridgeHome(ctx)
        }
        await ctx.answer()
        switch (action) {
          case 'w':
          case 'amt':
            return askAmount(ctx, payload)
          case 'src':
          case 'rq':
            if (payload.amount && payload.source) {
              await store.clearSession(ctx.chat.id, ctx.user.id)
              return review(ctx, payload as Required<Draft>)
            }
            return askAmount(ctx, payload)
          case 'go':
            if (payload.amount && payload.source && payload.key && payload.quotedAt) return create(ctx, payload as Review)
            return askAmount(ctx, payload)
        }
      },
    },
  }
}
