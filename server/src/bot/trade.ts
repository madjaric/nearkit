import { NATIVE_TOKEN_ID, NEAR_DECIMALS } from '@/config/networks'
import { formatUnits, fractionOf, tryParseUnits } from '@/lib/amounts'
import { GAS_RESERVE_YOCTO, NEARKIT_FEE_LABEL } from '@/lib/fees'
import { formatPct, formatUsdPrice } from '@/lib/format'
import { explorerTokenUrl } from '@/services/near/explorer'
import type { Quote, TokenListing } from '@/types/domain'
import { bold, code, esc, plainText } from '../telegram/html'
import { looksLikeContract, resolveToken } from '../trade/tokens'
import { btn, documented, FLOW_TTL_MS, keyboard, urlBtn, type BotCtx, type BotModule } from './context'
import { Buckets } from './ratelimit'
import { amountText, friendlyError, UNKNOWN } from './ui'
import { showWalletHome } from './tradingWallet'
import { linkedAccount, needAccount } from './wallet'

/**
 * /buy, /sell, /quote, /token and /balance. Quotes come from NearKit's own trading
 * service (Rhea's router with every route check the web app runs, the same
 * NearKit fee). Nothing is signed here: the confirm button opens the NearKit web app
 * with the trade filled in, where it is quoted again and the wallet signs.
 */

type Side = 'buy' | 'sell'

interface TradeState {
  side: Side
  token?: string
  account: string
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
  return [...new Set([...ctx.deps.store.userTokens(ctx.user.id, ctx.deps.config.network.id), ...held])]
}

const fmt = (raw: bigint, decimals: number, maxFraction = 6) => formatUnits(raw, decimals, { maxFraction, group: true })
const errorText = (ctx: BotCtx, e: unknown, side?: Side) => esc(friendlyError(e, { network: ctx.deps.config.network.id, side, log: ctx.deps.log, context: 'trade failed' }))

/** Exact balance of a token (or NEAR available to spend) in raw units. */
async function balanceOf(ctx: BotCtx, account: string, tokenId: string): Promise<bigint> {
  const b = await ctx.deps.near.ctx.balances.get(account)
  if (tokenId === NATIVE_TOKEN_ID) return b.state?.availableYocto ?? 0n
  return b.fts.find((f) => f.contract === tokenId)?.raw ?? 0n
}

function tokenHeader(side: Side, t: TokenListing): string {
  return `${side === 'buy' ? '🟢' : '🔴'} ${bold(`${side === 'buy' ? 'Buy' : 'Sell'} ${t.symbol}`)}${t.contract ? `\n${code(t.contract)}` : ''}`
}

async function chooseToken(ctx: BotCtx, state: TradeState, query: string) {
  const match = await resolveToken(ctx.deps.near, query, await userTokens(ctx, state.account))
  if (match.kind === 'none') {
    ctx.deps.store.setSession(ctx.chat.id, ctx.user.id, 'trade.token', state, FLOW_TTL_MS)
    await ctx.reply(`⚠️ ${match.error ? errorText(ctx, match.error) : esc(match.message)}\n\nSend another symbol or contract, or /cancel.`)
    return
  }
  if (match.kind === 'many') {
    const rows = match.tokens.map((t) => [
      btn(
        `${t.symbol}${t.contract ? ` · ${t.contract.length > 28 ? `${t.contract.slice(0, 12)}…${t.contract.slice(-10)}` : t.contract}` : ''}`,
        `tr:pick:${ctx.deps.store.putCallback({ ...state, token: t.id }, ctx.user.id, ctx.chat.id, CALLBACK_TTL_MS)}`,
      ),
    ])
    await ctx.reply('Several tokens match. Check the contract and pick one:', keyboard(...rows, [btn('✖ Cancel', 'tr:cancel')]))
    return
  }
  const token = match.token
  if (token.id === NATIVE_TOKEN_ID) {
    await ctx.reply(state.side === 'buy' ? 'You pay with NEAR: send the token to buy.' : 'Send the token to sell for NEAR.')
    ctx.deps.store.setSession(ctx.chat.id, ctx.user.id, 'trade.token', state, FLOW_TTL_MS)
    return
  }
  if (token.contract && looksLikeContract(query.trim().toLowerCase())) ctx.deps.store.addUserToken(ctx.user.id, ctx.deps.config.network.id, token.contract)
  await askAmount(ctx, { ...state, token: token.id }, token)
}

async function askAmount(ctx: BotCtx, state: Required<TradeState>, token: TokenListing) {
  const settings = ctx.deps.store.getSettings(ctx.user.id)
  const buy = state.side === 'buy'
  const balance = await balanceOf(ctx, state.account, buy ? NATIVE_TOKEN_ID : state.token).catch(() => null)
  const decimals = buy ? NEAR_DECIMALS : token.decimals
  const unit = buy ? 'NEAR' : token.symbol
  const put = (amount: string) => ctx.deps.store.putCallback({ ...state, amount }, ctx.user.id, ctx.chat.id, CALLBACK_TTL_MS)
  const head = [tokenHeader(state.side, token), '', `Wallet ${code(state.account)}`, `Balance ${balance === null ? UNKNOWN : bold(`${fmt(balance, decimals, 4)} ${esc(unit)}`)}`]

  if (!buy && balance === 0n) {
    ctx.deps.store.clearSession(ctx.chat.id, ctx.user.id)
    await ctx.reply([...head, '', `You don’t hold any ${esc(token.symbol)} in this wallet.`].join('\n'), keyboard([btn('« Menu', 'menu:home')]))
    return
  }
  ctx.deps.store.setSession(ctx.chat.id, ctx.user.id, 'trade.amount', state, FLOW_TTL_MS)
  let rows
  if (buy) {
    const presets = settings.buyPresets.slice(0, 3).map((p) => btn(`${p} NEAR`, `tr:amt:${put(p)}`))
    // MAX keeps NEAR back for gas; the review checks storage and fees again before signing.
    const max = balance !== null && balance > GAS_RESERVE_YOCTO ? balance - GAS_RESERVE_YOCTO : null
    rows = [presets, [...(max !== null ? [btn(`MAX · ${fmt(max, NEAR_DECIMALS, 2)}`, `tr:amt:${put(formatUnits(max, NEAR_DECIMALS))}`)] : []), btn('✏️ Custom', 'tr:custom')]]
  } else {
    const shares = balance ? settings.sellPresets.slice(0, 4).map((pct) => btn(`${pct}%`, `tr:amt:${put(formatUnits(fractionOf(balance, pct, 100), decimals))}`)) : []
    rows = [shares, [btn('✏️ Custom', 'tr:custom')]]
  }
  await ctx.reply([...head, '', buy ? 'How much NEAR?' : `How much ${esc(token.symbol)}?`].join('\n'), keyboard(...rows, [btn('✖ Cancel', 'tr:cancel')]))
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
    `NearKit fee ${esc(fee)}`,
    ...(f.charged && f.routerFeeBps !== null ? [`Rhea fee ${esc(`${(f.routerFeeBps / 100).toFixed(2)}%`)} · pool fees are in the rate`] : []),
    `Network fee ≈ ${esc(q.networkFeeNear.toFixed(4))} NEAR`,
    `Route ${esc(q.path.join(' → '))} · Rhea`,
    '',
    `⏱ Quote for ${seconds}s. NearKit quotes again right before you sign in your wallet.`,
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
    store.setSession(ctx.chat.id, ctx.user.id, 'trade.amount', state, FLOW_TTL_MS)
    return
  }
  const balance = await balanceOf(ctx, state.account, buy ? NATIVE_TOKEN_ID : state.token).catch(() => null)
  if (balance !== null && balance < parsed.value) {
    const unit = buy ? 'NEAR' : token.symbol
    await ctx.reply(
      `⚠️ ${buy ? 'Not enough NEAR for this trade plus gas.' : `Not enough ${esc(token.symbol)}.`} ${code(state.account)} has ${esc(fmt(balance, decimals, 4))} ${esc(unit)}, less than ${esc(state.amount)} ${esc(unit)}.`,
      keyboard([btn('✏️ Another amount', `tr:start:${store.putCallback(state, ctx.user.id, ctx.chat.id, CALLBACK_TTL_MS)}`), btn('✖ Cancel', 'tr:cancel')]),
    )
    return
  }
  if (!quotesAllowed(ctx)) {
    await ctx.reply('⏳ Too many quotes in a row. Wait a few seconds and try again.')
    return
  }
  store.clearSession(ctx.chat.id, ctx.user.id)
  const request = {
    tokenIn: buy ? NATIVE_TOKEN_ID : state.token,
    tokenOut: buy ? state.token : NATIVE_TOKEN_ID,
    amountIn: state.amount,
    slippagePct: store.getSettings(ctx.user.id).slippagePct,
    walletId: state.account,
  }
  let quote: Quote
  try {
    quote = await near.trading.quote(request)
  } catch (e) {
    // Rhea's answer, in plain words: no route is said plainly, never replaced with a guess.
    await ctx.reply(`⚠️ ${errorText(ctx, e, state.side)}\n\nNothing was prepared.`, keyboard([btn('« Menu', 'menu:home')]))
    return
  }
  const { url } = ctx.deps.handoffs.create({
    userId: ctx.user.id,
    chatId: ctx.chat.id,
    accountId: state.account,
    side: state.side,
    tokenIn: request.tokenIn,
    tokenOut: request.tokenOut,
    amountIn: state.amount,
    slippagePct: request.slippagePct,
  })
  const again = store.putCallback(state, ctx.user.id, ctx.chat.id, CALLBACK_TTL_MS)
  await ctx.reply(
    quoteText(ctx, state.side, token, state.amount, quote),
    keyboard([urlBtn('✍️ Confirm & sign in NearKit', url)], [btn('🔄 Refresh', `tr:again:${again}`), btn('✖ Cancel', 'tr:cancel')]),
  )
}

async function startTrade(ctx: BotCtx, side: Side, args: string) {
  const account = await needAccount(ctx)
  if (!account) return
  const [tokenArg = '', amountArg = ''] = plainText(args, 200).split(' ')
  const state: TradeState = { side, account }
  if (!tokenArg) {
    ctx.deps.store.setSession(ctx.chat.id, ctx.user.id, 'trade.token', state, FLOW_TTL_MS)
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
  await quoteAndConfirm(ctx, { side, account, token: token.id, amount })
}

async function showToken(ctx: BotCtx, args: string) {
  const query = plainText(args, 80)
  if (!query) {
    await ctx.reply('Send /token with a symbol or an exact contract ID, e.g. /token wrap.near')
    return
  }
  const account = linkedAccount(ctx)
  const match = await resolveToken(ctx.deps.near, query, account ? await userTokens(ctx, account) : ctx.deps.store.userTokens(ctx.user.id, ctx.deps.config.network.id))
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
  const [supply, held] = await Promise.all([ctx.deps.near.ctx.reader.totalSupply(t.contract).catch(() => null), account ? balanceOf(ctx, account, t.id).catch(() => null) : null])
  const state = (side: Side) => ctx.deps.store.putCallback({ side, account: account ?? '', token: t.id }, ctx.user.id, ctx.chat.id, CALLBACK_TTL_MS)
  await ctx.reply(
    [
      `${bold(t.symbol)} · ${esc(t.name)}`,
      code(t.contract),
      '',
      `Price ${t.market ? esc(formatUsdPrice(t.market.priceUsd)) : `${UNKNOWN} (not listed by Rhea)`}`,
      `Supply ${supply !== null ? esc(fmt(supply, t.decimals, 0)) : UNKNOWN} · ${t.decimals} decimals`,
      ...(account ? [`You hold ${held !== null ? bold(`${esc(amountText(held, t.decimals))} ${esc(t.symbol)}`) : UNKNOWN}`] : []),
    ].join('\n'),
    keyboard(...(account ? [[btn(`🟢 Buy ${t.symbol}`, `tr:start:${state('buy')}`), btn(`🔴 Sell ${t.symbol}`, `tr:start:${state('sell')}`)]] : []), [
      urlBtn('🔗 Explorer', explorerTokenUrl(ctx.deps.config.network, t.contract)),
    ]),
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
        ctx.deps.store.clearSession(ctx.chat.id, ctx.user.id)
        await chooseToken(ctx, data as unknown as TradeState, plainText(text, 80))
      },
      'trade.amount': async (ctx, text, data) => {
        const state = data as unknown as Required<TradeState>
        await quoteAndConfirm(ctx, { ...state, amount: plainText(text, 40).replace(',', '.').replace(/\s/g, '') })
      },
    },
    callbacks: {
      tr: async (ctx, action, arg) => {
        const { store } = ctx.deps
        if (action === 'cancel') {
          store.clearSession(ctx.chat.id, ctx.user.id)
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
        const payload = store.getCallback<Required<TradeState> & { amount?: string }>(arg, ctx.user.id)
        if (!payload) return ctx.answer('That button expired. Start again with /buy or /sell.', true)
        const account = linkedAccount(ctx)
        if (!account) {
          await ctx.answer()
          return void (await needAccount(ctx))
        }
        const state = { ...payload, account }
        if (action === 'pick' || action === 'start') {
          await ctx.answer()
          const token = (await ctx.deps.near.market.listTokens([state.token])).find((t) => t.id === state.token)
          if (!token) return void (await ctx.reply('⚠️ That token can’t be read from chain right now.'))
          return askAmount(ctx, state, token)
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
