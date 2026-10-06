import { NATIVE_TOKEN_ID, NEAR_DECIMALS } from '@/config/networks'
import { formatUnits, fractionOf, tryParseUnits } from '@/lib/amounts'
import { GAS_RESERVE_YOCTO, NEARKIT_FEE_LABEL } from '@/lib/fees'
import { formatNumber, formatPct, formatUsdCompact, formatUsdPrice } from '@/lib/format'
import { readTransferTax } from '@/services/dcl/tax'
import { explorerTokenUrl } from '@/services/near/explorer'
import type { MarketFigure, Quote, TokenListing, TokenMarket } from '@/types/domain'
import { walletName } from '../custody/limits'
import type { TradingWallet } from '../custody/store'
import { buyReserve, sellReserve, type SwapParams } from '../custody/swap'
import { bold, code, esc, plainText } from '../telegram/html'
import { ROUTE_SOURCE_LABEL } from '@/services/routing/select'
import { looksLikeContract, resolveToken } from '../trade/tokens'
import { btn, copyBtn, documented, FLOW_TTL_MS, keyboard, urlBtn, type BotCtx, type BotModule } from './context'
import { Buckets } from './ratelimit'
import { sendNativeQuote } from './nativeTrade'
import { amountText, friendlyError, nearText, UNKNOWN } from './ui'
import { flowWallet, showWalletHome, tradingWallet, walletLine } from './tradingWallet'
import { linkedAccount, needAccount } from './wallet'

/**
 * /buy, /sell, /quote, /token and /balance. Quotes come from NearKit's own router
 * (every route check the web app runs, the same NearKit fee).
 *
 * - With a NearKit wallet, the trade runs right here: Confirm goes to the intent
 *   engine, which re-quotes and signs (nativeTrade.ts).
 * - Without one, Confirm opens the NearKit web app with the trade filled in, where it
 *   is quoted again and the user's own wallet signs (the non-custodial handoff).
 */

type Side = 'buy' | 'sell'

interface TradeState {
  side: Side
  token?: string
  account: string
  /** From a NearKit wallet, executed here (else: the linked wallet, signed in the web app). */
  native?: boolean
  /** That NearKit wallet (its ID): the trade stays on it, whatever the user selects meanwhile. */
  walletId?: string
}

const CALLBACK_TTL_MS = 30 * 60_000
/** A button pressed again this soon is a double tap: it does not prepare a second trade. */
const DOUBLE_TAP_MS = 10_000
/** Quotes hit Rhea's free quote server: at most 6 a minute per user. */
const quoteLimits = new WeakMap<object, Buckets>()
const recentTaps = new WeakMap<object, Map<string, number>>()

function quotesAllowed(ctx: BotCtx): boolean {
  let b = quoteLimits.get(ctx.deps)
  if (!b) {
    b = new Buckets(6, 6 / 60, ctx.deps.now)
    quoteLimits.set(ctx.deps, b)
  }
  return b.take(String(ctx.user.id))
}

/** True when this user pressed this very button a moment ago. */
function doubleTap(ctx: BotCtx, button: string): boolean {
  let taps = recentTaps.get(ctx.deps)
  if (!taps) {
    taps = new Map()
    recentTaps.set(ctx.deps, taps)
  }
  const key = `${ctx.user.id}:${button}`
  const now = ctx.deps.now()
  for (const [k, at] of taps) if (now - at > DOUBLE_TAP_MS) taps.delete(k)
  if (taps.has(key)) return true
  taps.set(key, now)
  return false
}

async function userTokens(ctx: BotCtx, account: string): Promise<string[]> {
  const held = await ctx.deps.near.ctx.balances
    .get(account)
    .then((b) => b.fts.map((f) => f.contract))
    .catch(() => [])
  return [...new Set([...(await ctx.deps.store.userTokens(ctx.user.id, ctx.deps.config.network.id)), ...held])]
}

const fmt = (raw: bigint, decimals: number, maxFraction = 6) => formatUnits(raw, decimals, { maxFraction, group: true })
const errorText = (ctx: BotCtx, e: unknown, side?: Side) => esc(friendlyError(e, { network: ctx.deps.config.network.id, side, log: ctx.deps.log, context: 'trade failed' }))

/** Exact balance of a token (or NEAR available to spend) in raw units. */
async function balanceOf(ctx: BotCtx, account: string, tokenId: string): Promise<bigint> {
  const b = await ctx.deps.near.ctx.balances.get(account)
  if (tokenId === NATIVE_TOKEN_ID) return b.state?.availableYocto ?? 0n
  return b.fts.find((f) => f.contract === tokenId)?.raw ?? 0n
}

/** How long the BUY screen waits for the market before saying it didn't load (the market service keeps reading). */
const MARKET_WAIT_MS = 3_000

/** `p`, or null when it fails or takes longer than `ms`. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([p.catch(() => null), new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))])
  } finally {
    clearTimeout(timer)
  }
}

/** A figure's value as the screen shows it; null when no source has it. */
const figure = (f: MarketFigure, format: (v: number) => string): string | null => (f.state === 'known' || f.state === 'stale' ? format(f.value) : null)

/**
 * The token's market, from the shared market service (DEX Screener, GeckoTerminal, CoinGecko, as
 * Token Detail reads it). Market Cap only where a source knows the circulating supply, with FDV
 * beside it; with FDV alone, FDV (never called a market cap); with neither, "unavailable".
 */
function marketLines(m: TokenMarket | null): string[] {
  if (!m) return ['📊 Market data didn’t load. Refresh to try again.']
  if (m.priceUsd.state === 'not-applicable' && m.marketCapUsd.state === 'not-applicable') return [`📊 ${esc(m.priceUsd.reason)}`]
  const mcap = figure(m.marketCapUsd, (v) => formatUsdCompact(v, 2))
  const fdv = figure(m.fdvUsd, (v) => formatUsdCompact(v, 2))
  const liquidity = figure(m.liquidityUsd, (v) => formatUsdCompact(v, 1))
  const price = figure(m.priceUsd, formatUsdPrice)
  const change = figure(m.change24hPct, (v) => formatPct(v, { signed: true, decimals: 2 }))
  const caps = mcap ? `📊 Market Cap ${bold(mcap)}${fdv ? ` · FDV ${bold(fdv)}` : ''}` : fdv ? `📊 FDV ${bold(fdv)}` : '📊 Market Cap unavailable'
  return [caps, ...(liquidity ? [`💧 Liquidity ${bold(liquidity)}`] : []), `💵 Price ${price ? bold(price) : 'unavailable'}${change ? ` · 24h ${bold(change)}` : ''}`]
}

/** The token's own transfer tax to its DCL pair (what the route quotes after), or null when it has none. */
async function taxLine(ctx: BotCtx, token: TokenListing): Promise<string | null> {
  if (!token.contract) return null
  const tax = await readTransferTax(ctx.deps.near.ctx.rpc, token.contract, ctx.deps.config.network.dex.dcl.contract).catch(() => null)
  if (!tax || (tax.buyBps === 0 && tax.sellBps === 0)) return null
  const pct = (bps: number) => `${formatNumber(bps / 100, 0, 2)}%`
  return `🧾 Tax buy ${bold(pct(tax.buyBps))} · sell ${bold(pct(tax.sellBps))}`
}

function tokenHeader(side: Side, t: TokenListing): string {
  return `${side === 'buy' ? '🟢' : '🔴'} ${bold(`${side === 'buy' ? 'Buy' : 'Sell'} ${t.symbol}`)}${t.contract ? `\n${code(t.contract)}` : ''}`
}

/**
 * The token step of a trade. `pasted`: the query was a contract pasted on its own, outside any
 * flow, so a miss says "Token not found" and leaves no step waiting for a retry.
 */
async function chooseToken(ctx: BotCtx, state: TradeState, query: string, pasted = false) {
  const match = await resolveToken(ctx.deps.near, query, await userTokens(ctx, state.account))
  if (match.kind === 'none') {
    const why = match.error ? errorText(ctx, match.error) : esc(match.message)
    if (pasted) {
      await ctx.reply(`⚠️ Token not found: ${why}\n\nPaste a token’s exact contract ID, or send /buy.`)
      return
    }
    await ctx.deps.store.setSession(ctx.chat.id, ctx.user.id, 'trade.token', state, FLOW_TTL_MS)
    await ctx.reply(`⚠️ ${why}\n\nSend another symbol or contract, or /cancel.`)
    return
  }
  if (match.kind === 'many') {
    const ids = await Promise.all(match.tokens.map((t) => ctx.deps.store.putCallback({ ...state, token: t.id }, ctx.user.id, ctx.chat.id, CALLBACK_TTL_MS)))
    const rows = match.tokens.map((t, i) => [
      btn(`${t.symbol}${t.contract ? ` · ${t.contract.length > 28 ? `${t.contract.slice(0, 12)}…${t.contract.slice(-10)}` : t.contract}` : ''}`, `tr:pick:${ids[i]}`),
    ])
    await ctx.reply('Several tokens match. Check the contract and pick one:', keyboard(...rows, [btn('✖ Cancel', 'tr:cancel')]))
    return
  }
  const token = match.token
  if (token.id === NATIVE_TOKEN_ID) {
    await ctx.reply(state.side === 'buy' ? 'You pay with NEAR: send the token to buy.' : 'Send the token to sell for NEAR.')
    await ctx.deps.store.setSession(ctx.chat.id, ctx.user.id, 'trade.token', state, FLOW_TTL_MS)
    return
  }
  if (token.contract && looksLikeContract(query.trim().toLowerCase())) await ctx.deps.store.addUserToken(ctx.user.id, ctx.deps.config.network.id, token.contract)
  await askAmount(ctx, { ...state, native: state.native ?? false, walletId: state.walletId ?? '', token: token.id }, token)
}

/**
 * The BUY (or SELL) screen: the token and its live market first, then the wallet the trade runs
 * from, its balance and the slippage, then the amounts and the quick actions. NearKit's fee is
 * not repeated here: the quote states it before anything is confirmed. `edit`: replace the
 * message (Refresh, a wallet switch) instead of sending a new one.
 */
async function askAmount(ctx: BotCtx, state: Required<TradeState>, token: TokenListing, edit = false) {
  const buy = state.side === 'buy'
  const [settings, near, held, market, tax, wallet, wallets] = await Promise.all([
    ctx.deps.store.getSettings(ctx.user.id),
    balanceOf(ctx, state.account, NATIVE_TOKEN_ID).catch(() => null),
    token.contract ? balanceOf(ctx, state.account, state.token).catch(() => null) : Promise.resolve(null),
    within(ctx.deps.near.tokens.getMarketData(token.id), MARKET_WAIT_MS),
    taxLine(ctx, token),
    state.native ? flowWallet(ctx, state.walletId) : Promise.resolve(null),
    state.native && ctx.deps.custody ? ctx.deps.custody.store.activeWallets(ctx.user.id, ctx.deps.config.network.id) : Promise.resolve([] as TradingWallet[]),
  ])
  const balance = buy ? near : held
  const decimals = buy ? NEAR_DECIMALS : token.decimals
  const put = (amount: string) => ctx.deps.store.putCallback({ ...state, amount }, ctx.user.id, ctx.chat.id, CALLBACK_TTL_MS)
  const send = (html: string, markup: Parameters<BotCtx['show']>[1]) => (edit ? ctx.show(html, markup) : ctx.reply(html, markup).then(() => undefined))
  const nearShown = near === null ? UNKNOWN : bold(`${fmt(near, NEAR_DECIMALS, 4)} NEAR`)
  const pair = market?.pair
  const head = [
    `${buy ? '🟢' : '🔴'} ${bold(`${buy ? 'Buy' : 'Sell'} ${token.symbol}`)}${token.name && token.name !== token.symbol ? ` · ${esc(token.name)}` : ''}`,
    ...(token.contract ? [code(token.contract)] : []),
    ...(pair ? [`${esc(pair.baseSymbol)}/${esc(pair.quoteSymbol)} on ${esc(pair.dex)}`] : []),
    '',
    ...marketLines(market),
    ...(tax ? [tax] : []),
    '',
    wallet ? `👛 ${walletLine(wallet)} · ${nearShown}` : `👛 Wallet ${code(state.account)} · ${nearShown}`,
    ...(token.contract && held !== null && (!buy || held > 0n) ? [`🪙 You hold ${bold(`${fmt(held, token.decimals, 4)} ${esc(token.symbol)}`)}`] : []),
    `⚙️ Slippage ${bold(`${formatNumber(settings.slippagePct, 0, 2)}%`)}`,
  ]
  const network = ctx.deps.config.network
  if (!buy && state.native) {
    const gas = await balanceOf(ctx, state.account, NATIVE_TOKEN_ID).catch(() => null)
    if (gas !== null && gas < sellReserve(network))
      head.push(
        `⚠️ Selling needs up to ${esc(nearText(sellReserve(network)))} NEAR available, mostly a gas reserve: NEAR holds it while the swap runs and refunds unused gas automatically. Deposit NEAR first.`,
      )
  }
  if (buy && state.native && balance !== null && balance < buyReserve(network))
    head.push(
      `⚠️ Buying needs up to ${esc(nearText(buyReserve(network)))} NEAR available besides the amount, mostly a gas reserve: NEAR holds it while the swap runs and refunds unused gas automatically. The quote shows the exact amount.`,
    )

  if (!buy && balance === 0n) {
    await ctx.deps.store.clearSession(ctx.chat.id, ctx.user.id)
    await send([...head, '', `You don’t hold any ${esc(token.symbol)} in this wallet.`].join('\n'), keyboard([btn('« Menu', 'menu:home')]))
    return
  }
  await ctx.deps.store.setSession(ctx.chat.id, ctx.user.id, 'trade.amount', state, FLOW_TTL_MS)
  let rows
  if (buy) {
    const buttons = settings.buyPresets.slice(0, 3)
    const ids = await Promise.all(buttons.map((p) => put(p)))
    const presets = buttons.map((p, i) => btn(`${p} NEAR`, `tr:amt:${ids[i]}`))
    // MAX keeps NEAR back for gas bought upfront and registrations; everything is checked again before signing.
    const reserve = state.native ? buyReserve(network) : GAS_RESERVE_YOCTO
    const max = balance !== null && balance > reserve ? balance - reserve : null
    const maxId = max !== null ? await put(formatUnits(max, NEAR_DECIMALS)) : null
    rows = [presets, [...(max !== null && maxId ? [btn(`MAX · ${fmt(max, NEAR_DECIMALS, 2)}`, `tr:amt:${maxId}`)] : []), btn('✏️ Custom', 'tr:custom')]]
  } else {
    const pcts = balance ? settings.sellPresets.slice(0, 4) : []
    const ids = await Promise.all(pcts.map((pct) => put(formatUnits(fractionOf(balance ?? 0n, pct, 100), decimals))))
    const shares = pcts.map((pct, i) => btn(`${pct}%`, `tr:amt:${ids[i]}`))
    rows = [shares, [btn('✏️ Custom', 'tr:custom')]]
  }
  const here = await ctx.deps.store.putCallback(state, ctx.user.id, ctx.chat.id, CALLBACK_TTL_MS)
  await send(
    [...head, '', buy ? 'How much NEAR?' : `How much ${esc(token.symbol)}?`].join('\n'),
    keyboard(
      ...rows,
      [...(wallets.length > 1 ? [btn('👛 Switch wallet', `tr:wal:${here}`)] : []), btn('🔄 Refresh', `tr:ref:${here}`)],
      [urlBtn('📈 Chart', `${ctx.deps.config.webUrl}/token/${encodeURIComponent(token.id)}`), ...(token.contract ? [copyBtn('📋 Copy CA', token.contract)] : [])],
      [btn('📊 Positions', 'pf:positions'), btn('✖ Close', 'tr:cancel')],
    ),
  )
}

/** Which of the user's own active NearKit wallets this trade runs from (the pick becomes the selected wallet). */
async function chooseWallet(ctx: BotCtx, state: Required<TradeState>, token: TokenListing) {
  const custody = ctx.deps.custody
  const wallets = custody ? await custody.store.activeWallets(ctx.user.id, ctx.deps.config.network.id) : []
  const ids = await Promise.all(
    wallets.map((w) => ctx.deps.store.putCallback({ ...state, native: true, walletId: w.id, account: w.accountId }, ctx.user.id, ctx.chat.id, CALLBACK_TTL_MS)),
  )
  const back = await ctx.deps.store.putCallback(state, ctx.user.id, ctx.chat.id, CALLBACK_TTL_MS)
  await ctx.show(
    `👛 ${bold(`${state.side === 'buy' ? 'Buy' : 'Sell'} ${token.symbol}`)} from which NEARKITS wallet?`,
    keyboard(...wallets.map((w, i) => [btn(`${w.id === state.walletId ? '✅ ' : ''}${w.slot}. ${walletName(w)}`, `tr:use:${ids[i]}`)]), [btn('« Back', `tr:ref:${back}`)]),
  )
}

function quoteText(ctx: BotCtx, side: Side, token: TokenListing, amountIn: string, q: Quote): string {
  const buy = side === 'buy'
  const outDecimals = buy ? token.decimals : NEAR_DECIMALS
  const outSymbol = buy ? token.symbol : 'NEAR'
  const inSymbol = buy ? 'NEAR' : token.symbol
  const out = q.amountOutRaw ? fmt(BigInt(q.amountOutRaw), outDecimals) : String(q.amountOut)
  const min = q.minAmountOutRaw ? fmt(BigInt(q.minAmountOutRaw), outDecimals) : String(q.minAmountOut)
  const f = q.nearkitFee
  const fee = f.charged ? `${NEARKIT_FEE_LABEL}${f.amountNear !== null ? ` · ≈${f.amountNear.toFixed(5)} NEAR` : ''}` : `none on ${ctx.deps.config.network.id}`
  const seconds = Math.max(0, Math.round((q.expiresAt - ctx.deps.now()) / 1000))
  return [
    tokenHeader(side, token),
    '',
    `You pay ${bold(`${amountIn} ${inSymbol}`)}`,
    `You receive ${bold(`≈ ${out} ${outSymbol}`)}`,
    `Minimum ${esc(`${min} ${outSymbol}`)} · ${q.request.slippagePct}% slippage`,
    `Price impact ${q.priceImpactPct === null ? `${UNKNOWN} (no prices on ${esc(ctx.deps.config.network.id)})` : esc(formatPct(q.priceImpactPct, { decimals: 2 }))}`,
    `NEARKITS fee ${esc(fee)}`,
    ...(f.charged && f.routerFeeBps !== null ? [`Rhea fee ${esc(`${(f.routerFeeBps / 100).toFixed(2)}%`)} · pool fees are in the rate`] : []),
    `Actual network fee ≈ ${esc(q.networkFeeNear.toFixed(4))} NEAR`,
    `Route ${esc(q.path.join(' → '))} · ${esc(q.source ? ROUTE_SOURCE_LABEL[q.source] : 'Rhea')}`,
    '',
    `⏱ Quote for ${seconds}s. NEARKITS quotes again right before you sign in your wallet.`,
  ].join('\n')
}

async function quoteAndConfirm(ctx: BotCtx, state: Required<TradeState> & { amount: string }) {
  const { near, store } = ctx.deps
  const token = (await near.market.listTokens([state.token])).find((t) => t.id === state.token)
  if (!token) {
    await ctx.reply('⚠️ That token can’t be read from chain right now. Try again in a moment.')
    return
  }
  const buy = state.side === 'buy'
  const decimals = buy ? NEAR_DECIMALS : token.decimals
  const parsed = tryParseUnits(state.amount, decimals)
  if (!parsed.ok || parsed.value <= 0n) {
    await ctx.reply(`⚠️ ${esc(state.amount)} is not an amount above 0 with at most ${decimals} decimals. Send another, or /cancel.`)
    await store.setSession(ctx.chat.id, ctx.user.id, 'trade.amount', state, FLOW_TTL_MS)
    return
  }
  const balance = await balanceOf(ctx, state.account, buy ? NATIVE_TOKEN_ID : state.token).catch(() => null)
  if (balance !== null && balance < parsed.value) {
    const unit = buy ? 'NEAR' : token.symbol
    await ctx.reply(
      `⚠️ ${buy ? 'Not enough NEAR for this trade plus gas.' : `Not enough ${esc(token.symbol)}.`} ${code(state.account)} has ${esc(fmt(balance, decimals, 4))} ${esc(unit)}, less than ${esc(state.amount)} ${esc(unit)}.`,
      keyboard([btn('✏️ Another amount', `tr:start:${await store.putCallback(state, ctx.user.id, ctx.chat.id, CALLBACK_TTL_MS)}`), btn('✖ Cancel', 'tr:cancel')]),
    )
    return
  }
  if (!quotesAllowed(ctx)) {
    await ctx.reply('⏳ Too many quotes in a row. Wait a few seconds and try again.')
    return
  }
  await store.clearSession(ctx.chat.id, ctx.user.id)
  const request = {
    tokenIn: buy ? NATIVE_TOKEN_ID : state.token,
    tokenOut: buy ? state.token : NATIVE_TOKEN_ID,
    amountIn: state.amount,
    slippagePct: (await store.getSettings(ctx.user.id)).slippagePct,
    walletId: state.account,
  }
  if (state.native && token.contract) {
    const again = await store.putCallback(state, ctx.user.id, ctx.chat.id, CALLBACK_TTL_MS)
    const params: SwapParams = { side: state.side, token: token.contract, symbol: token.symbol, decimals: token.decimals, amountIn: state.amount, slippagePct: request.slippagePct }
    await sendNativeQuote(ctx, params, `tr:again:${again}`, state.walletId ?? '')
    return
  }
  let quote: Quote
  try {
    quote = await near.trading.quote(request)
  } catch (e) {
    // Rhea's answer, in plain words: no route is said plainly, never replaced with a guess.
    await ctx.reply(`⚠️ ${errorText(ctx, e, state.side)}\n\nNothing was prepared.`, keyboard([btn('« Menu', 'menu:home')]))
    return
  }
  const { url } = await ctx.deps.handoffs.create({
    userId: ctx.user.id,
    chatId: ctx.chat.id,
    accountId: state.account,
    side: state.side,
    tokenIn: request.tokenIn,
    tokenOut: request.tokenOut,
    amountIn: state.amount,
    slippagePct: request.slippagePct,
  })
  const again = await store.putCallback(state, ctx.user.id, ctx.chat.id, CALLBACK_TTL_MS)
  const tip = ctx.deps.custody ? '\n\n💡 A NEARKITS wallet trades right here, without the browser: 👛 Wallet.' : ''
  await ctx.reply(
    quoteText(ctx, state.side, token, state.amount, quote) + tip,
    keyboard([urlBtn('✍️ Confirm & sign in NEARKITS', url)], [btn('🔄 Refresh', `tr:again:${again}`), btn('✖ Cancel', 'tr:cancel')]),
  )
}

/** The wallet a trade runs on, and the state it starts with; null after asking the user to link one. */
async function tradeStart(ctx: BotCtx, side: Side): Promise<TradeState | null> {
  const nearkit = await tradingWallet(ctx.deps, ctx.user.id)
  const account = nearkit?.accountId ?? (await needAccount(ctx))
  if (!account) return null
  return { side, account, native: nearkit !== null, ...(nearkit ? { walletId: nearkit.id } : {}) }
}

/**
 * A token contract pasted on its own is the token to buy: the /buy flow from its token step,
 * through the same resolver, quote, confirmation and checks. Only an exact contract (an account
 * ID with a dot, or an implicit account) counts; a bare word could be anything, so a symbol
 * alone keeps the /help pointer. Nothing is quoted or sent here: the amount step comes next.
 */
async function buyPastedContract(ctx: BotCtx, text: string): Promise<boolean> {
  const contract = text.trim().toLowerCase()
  if (!looksLikeContract(contract)) return false
  const state = await tradeStart(ctx, 'buy')
  if (state) await chooseToken(ctx, state, contract, true)
  return true
}

async function startTrade(ctx: BotCtx, side: Side, args: string) {
  const state = await tradeStart(ctx, side)
  if (!state) return
  const { account } = state
  const [tokenArg = '', amountArg = ''] = plainText(args, 200).split(' ')
  if (!tokenArg) {
    await ctx.deps.store.setSession(ctx.chat.id, ctx.user.id, 'trade.token', state, FLOW_TTL_MS)
    await ctx.reply(`${side === 'buy' ? '🟢 Buy' : '🔴 Sell'}: which token? Send its symbol or exact contract ID.`, keyboard([btn('✖ Cancel', 'tr:cancel')]))
    return
  }
  if (!amountArg) return chooseToken(ctx, state, tokenArg)
  const match = await resolveToken(ctx.deps.near, tokenArg, await userTokens(ctx, account))
  if (match.kind !== 'one' || match.token.id === NATIVE_TOKEN_ID) return chooseToken(ctx, state, tokenArg)
  const token = match.token
  let amount = amountArg
  if (side === 'sell' && /^(\d{1,3})%$/.test(amountArg)) {
    const pct = Number(amountArg.slice(0, -1))
    const held = await balanceOf(ctx, account, token.id).catch(() => 0n)
    if (pct <= 0 || pct > 100 || held === 0n) {
      await ctx.reply(`⚠️ ${code(account)} holds no ${esc(token.symbol)} to sell, or ${esc(amountArg)} isn’t a share between 1% and 100%.`)
      return
    }
    amount = formatUnits(fractionOf(held, pct, 100), token.decimals)
  }
  await quoteAndConfirm(ctx, { ...state, native: state.native ?? false, walletId: state.walletId ?? '', token: token.id, amount })
}

async function showToken(ctx: BotCtx, args: string) {
  const query = plainText(args, 80)
  if (!query) {
    await ctx.reply('Send /token with a symbol or an exact contract ID, e.g. /token wrap.near')
    return
  }
  const nearkit = await tradingWallet(ctx.deps, ctx.user.id)
  const account = nearkit?.accountId ?? (await linkedAccount(ctx))
  const match = await resolveToken(ctx.deps.near, query, account ? await userTokens(ctx, account) : await ctx.deps.store.userTokens(ctx.user.id, ctx.deps.config.network.id))
  if (match.kind === 'none') {
    await ctx.reply(`⚠️ ${match.error ? errorText(ctx, match.error) : esc(match.message)}`)
    return
  }
  if (match.kind === 'many') {
    await ctx.reply(
      ['Several tokens match:', ...match.tokens.map((t) => `• ${bold(t.symbol)} ${t.contract ? code(t.contract) : ''}`), '', 'Send /token with the exact contract.'].join('\n'),
    )
    return
  }
  const t = match.token
  if (!t.contract) {
    await ctx.reply(`${bold('NEAR')}\nPrice ${t.market ? esc(formatUsdPrice(t.market.priceUsd)) : UNKNOWN}`)
    return
  }
  const [supply, held, market, tax] = await Promise.all([
    ctx.deps.near.ctx.reader.totalSupply(t.contract).catch(() => null),
    account ? balanceOf(ctx, account, t.id).catch(() => null) : null,
    within(ctx.deps.near.tokens.getMarketData(t.id), MARKET_WAIT_MS),
    taxLine(ctx, t),
  ])
  const pair = market?.pair
  const state = (side: Side) => ctx.deps.store.putCallback({ side, account: account ?? '', token: t.id, native: nearkit !== null }, ctx.user.id, ctx.chat.id, CALLBACK_TTL_MS)
  const [buyId, sellId] = account ? await Promise.all([state('buy'), state('sell')]) : ['', '']
  await ctx.reply(
    [
      `${bold(t.symbol)} · ${esc(t.name)}`,
      code(t.contract),
      ...(pair ? [`${esc(pair.baseSymbol)}/${esc(pair.quoteSymbol)} on ${esc(pair.dex)}`] : []),
      '',
      ...marketLines(market),
      ...(tax ? [tax] : []),
      `Supply ${supply !== null ? esc(fmt(supply, t.decimals, 0)) : UNKNOWN} · ${t.decimals} decimals`,
      ...(account ? [`You hold ${held !== null ? bold(`${esc(amountText(held, t.decimals))} ${esc(t.symbol)}`) : UNKNOWN}`] : []),
    ].join('\n'),
    keyboard(
      ...(account ? [[btn(`🟢 Buy ${t.symbol}`, `tr:start:${buyId}`), btn(`🔴 Sell ${t.symbol}`, `tr:start:${sellId}`)]] : []),
      [urlBtn('📈 Chart', `${ctx.deps.config.webUrl}/token/${encodeURIComponent(t.id)}`), copyBtn('📋 Copy CA', t.contract)],
      [urlBtn('🔗 Explorer', explorerTokenUrl(ctx.deps.config.network, t.contract))],
    ),
  )
}

export function tradeModule(): BotModule {
  return {
    commands: {
      buy: { ...documented('buy'), run: (ctx, args) => startTrade(ctx, 'buy', args) },
      sell: { ...documented('sell'), run: (ctx, args) => startTrade(ctx, 'sell', args) },
      quote: { ...documented('quote'), run: (ctx, args) => startTrade(ctx, 'buy', args) },
      token: { ...documented('token'), run: showToken },
      balance: { ...documented('balance'), run: (ctx, args) => showWalletHome(ctx, /details/i.test(args)) },
    },
    flows: {
      'trade.token': async (ctx, text, data) => {
        await ctx.deps.store.clearSession(ctx.chat.id, ctx.user.id)
        await chooseToken(ctx, data as unknown as TradeState, plainText(text, 80))
      },
      'trade.amount': async (ctx, text, data) => {
        const state = data as unknown as Required<TradeState>
        await quoteAndConfirm(ctx, { ...state, amount: plainText(text, 40).replace(',', '.').replace(/\s/g, '') })
      },
    },
    onText: buyPastedContract,
    callbacks: {
      tr: async (ctx, action, arg) => {
        const { store } = ctx.deps
        if (action === 'cancel') {
          await store.clearSession(ctx.chat.id, ctx.user.id)
          await ctx.answer()
          await ctx.show('Cancelled. Nothing was prepared or signed.', keyboard([btn('« Menu', 'menu:home')]))
          return
        }
        if (action === 'buy' || action === 'sell') {
          await ctx.answer()
          return startTrade(ctx, action, '')
        }
        if (action === 'custom') {
          await ctx.answer()
          // The amount step is already waiting for text; this only says so.
          await ctx.reply('Send the amount, e.g. 0.25. /cancel to stop.')
          return
        }
        const payload = await store.getCallback<Required<TradeState> & { amount?: string }>(arg, ctx.user.id)
        if (!payload) return ctx.answer('That button expired. Start again with /buy or /sell.', true)
        // A native trade stays on the NearKit wallet it started on (if it is still the user's and active).
        const account = payload.native ? ((await flowWallet(ctx, payload.walletId))?.accountId ?? null) : await linkedAccount(ctx)
        if (!account) {
          await ctx.answer()
          if (payload.native) return showWalletHome(ctx)
          return void (await needAccount(ctx))
        }
        const state = { ...payload, native: payload.native ?? false, account }
        if (action === 'pick' || action === 'start' || action === 'ref' || action === 'use' || action === 'wal') {
          await ctx.answer()
          const token = (await ctx.deps.near.market.listTokens([state.token])).find((t) => t.id === state.token)
          if (!token) return void (await ctx.reply('⚠️ That token can’t be read from chain right now.'))
          if (action === 'wal') return chooseWallet(ctx, state, token)
          // The wallet picked (checked above: this user's, active) is the selected one from now on.
          if (action === 'use') await store.updateSettings(ctx.user.id, { activeWallet: state.walletId })
          return askAmount(ctx, state, token, action !== 'pick' && action !== 'start')
        }
        if ((action === 'amt' || action === 'again') && payload.amount) {
          // A double tap would prepare the same trade twice.
          if (doubleTap(ctx, `${action}:${arg}`)) return ctx.answer('Already on it: see the quote above.')
          await ctx.answer()
          return quoteAndConfirm(ctx, { ...state, amount: payload.amount })
        }
        await ctx.answer()
      },
    },
  }
}
