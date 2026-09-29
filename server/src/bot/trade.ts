import { NATIVE_TOKEN_ID, NEAR_DECIMALS } from '@/config/networks'
import { formatUnits, fractionOf, tryParseUnits } from '@/lib/amounts'
import { NEARKIT_FEE_LABEL, NEARKIT_FEE_RECEIVED_LABEL, RHEA_APP_FEE_SHARE_LABEL } from '@/lib/fees'
import { formatPct, formatUsdPrice } from '@/lib/format'
import { describeError } from '@/services/errors'
import { explorerTokenUrl } from '@/services/near/explorer'
import type { Quote, TokenListing } from '@/types/domain'
import { bold, code, esc, link, plainText } from '../telegram/html'
import { looksLikeContract, resolveToken } from '../trade/tokens'
import { btn, documented, FLOW_TTL_MS, keyboard, urlBtn, type BotCtx, type BotModule } from './context'
import { Buckets } from './ratelimit'

/**
 * /buy, /sell, /quote, /token and /balance. Quotes come from NearKit's own trading
 * service (Rhea's router with every route check the web app runs, the same
 * NearKit fee). Nothing is signed here: "Review & sign" opens the NearKit web app
 * with the trade filled in, where it is quoted again and the wallet signs.
 */

type Side = 'buy' | 'sell'

interface TradeState {
  side: Side
  token?: string
  account: string
}

const CALLBACK_TTL_MS = 30 * 60_000
/** Quotes hit Rhea's free quote server: at most 6 a minute per user. */
const quoteLimits = new WeakMap<object, Buckets>()

function quotesAllowed(ctx: BotCtx): boolean {
  let b = quoteLimits.get(ctx.deps)
  if (!b) {
    b = new Buckets(6, 6 / 60, ctx.deps.now)
    quoteLimits.set(ctx.deps, b)
  }
  return b.take(String(ctx.user.id))
}

function linkedAccount(ctx: BotCtx): string | null {
  const { store, config } = ctx.deps
  const links = store.linksOf(ctx.user.id, config.network.id)
  const def = store.getSettings(ctx.user.id).defaultAccount
  return links.find((l) => l.accountId === def)?.accountId ?? links[0]?.accountId ?? null
}

async function needAccount(ctx: BotCtx): Promise<string | null> {
  const account = linkedAccount(ctx)
  if (!account) {
    await ctx.reply('Link a NEAR account first: you sign a free message in your wallet, no keys involved.', keyboard([btn('🔗 Link wallet', 'acct:link')]))
    return null
  }
  return account
}

async function userTokens(ctx: BotCtx, account: string): Promise<string[]> {
  const held = await ctx.deps.near.ctx.balances
    .get(account)
    .then((b) => b.fts.map((f) => f.contract))
    .catch(() => [])
  return [...new Set([...ctx.deps.store.userTokens(ctx.user.id, ctx.deps.config.network.id), ...held])]
}

const fmt = (raw: bigint, decimals: number, maxFraction = 6) => formatUnits(raw, decimals, { maxFraction, group: true })

/** Exact balance of a token (or NEAR available to spend) in raw units. */
async function balanceOf(ctx: BotCtx, account: string, tokenId: string): Promise<bigint> {
  const b = await ctx.deps.near.ctx.balances.get(account)
  if (tokenId === NATIVE_TOKEN_ID) return b.state?.availableYocto ?? 0n
  return b.fts.find((f) => f.contract === tokenId)?.raw ?? 0n
}

function tokenLine(t: TokenListing): string {
  return t.contract ? `${bold(t.symbol)} · ${esc(t.name)}\n${code(t.contract)}` : bold('NEAR')
}

async function chooseToken(ctx: BotCtx, state: TradeState, query: string) {
  const match = await resolveToken(ctx.deps.near, query, await userTokens(ctx, state.account))
  if (match.kind === 'none') {
    ctx.deps.store.setSession(ctx.chat.id, ctx.user.id, 'trade.token', state, FLOW_TTL_MS)
    await ctx.reply(`⚠️ ${esc(match.message)}\n\nSend another symbol or contract, or /cancel.`)
    return
  }
  if (match.kind === 'many') {
    const rows = match.tokens.map((t) => [
      btn(
        `${t.symbol}${t.contract ? ` · ${t.contract.length > 28 ? `${t.contract.slice(0, 12)}…${t.contract.slice(-10)}` : t.contract}` : ''}`,
        `tr:pick:${ctx.deps.store.putCallback({ ...state, token: t.id }, ctx.user.id, ctx.chat.id, CALLBACK_TTL_MS)}`,
      ),
    ])
    await ctx.reply('Several tokens match. Check the contract and pick one:', keyboard(...rows))
    return
  }
  const token = match.token
  if (token.id === NATIVE_TOKEN_ID) {
    await ctx.reply(state.side === 'buy' ? 'You pay with NEAR: pick the token to buy.' : 'Choose the token to sell for NEAR.')
    ctx.deps.store.setSession(ctx.chat.id, ctx.user.id, 'trade.token', state, FLOW_TTL_MS)
    return
  }
  if (token.contract && looksLikeContract(query.trim().toLowerCase())) ctx.deps.store.addUserToken(ctx.user.id, ctx.deps.config.network.id, token.contract)
  await askAmount(ctx, { ...state, token: token.id }, token)
}

async function askAmount(ctx: BotCtx, state: Required<TradeState>, token: TokenListing) {
  const settings = ctx.deps.store.getSettings(ctx.user.id)
  const pay = state.side === 'buy' ? NATIVE_TOKEN_ID : state.token
  const balance = await balanceOf(ctx, state.account, pay).catch(() => null)
  const decimals = state.side === 'buy' ? NEAR_DECIMALS : token.decimals
  const unit = state.side === 'buy' ? 'NEAR' : token.symbol
  const put = (amount: string) => ctx.deps.store.putCallback({ ...state, amount }, ctx.user.id, ctx.chat.id, CALLBACK_TTL_MS)
  const buttons =
    state.side === 'buy'
      ? settings.buyPresets.map((p) => btn(`${p} NEAR`, `tr:amt:${put(p)}`))
      : balance && balance > 0n
        ? settings.sellPresets.map((pct) => btn(`${pct}%`, `tr:amt:${put(formatUnits(fractionOf(balance, pct, 100), decimals))}`))
        : []
  ctx.deps.store.setSession(ctx.chat.id, ctx.user.id, 'trade.amount', state, FLOW_TTL_MS)
  await ctx.reply(
    [
      `${state.side === 'buy' ? '🟢 Buy' : '🔴 Sell'} ${tokenLine(token)}`,
      '',
      `Account ${code(state.account)}: ${balance === null ? 'balance unavailable right now' : `${fmt(balance, decimals, 4)} ${esc(unit)} ${state.side === 'buy' ? 'available' : 'held'}`}`,
      '',
      state.side === 'buy' ? 'How much NEAR? Pick one or send an amount.' : `How much ${esc(token.symbol)}? Pick a share or send an amount.`,
    ].join('\n'),
    keyboard(buttons.slice(0, 3), buttons.slice(3, 6), [btn('Cancel', 'tr:cancel')]),
  )
}

function quoteText(side: Side, token: TokenListing, amountIn: string, account: string, q: Quote, networkId: string): string {
  const outDecimals = side === 'buy' ? token.decimals : NEAR_DECIMALS
  const outSymbol = side === 'buy' ? token.symbol : 'NEAR'
  const inSymbol = side === 'buy' ? 'NEAR' : token.symbol
  const out = q.amountOutRaw ? fmt(BigInt(q.amountOutRaw), outDecimals) : String(q.amountOut)
  const min = q.minAmountOutRaw ? fmt(BigInt(q.minAmountOutRaw), outDecimals) : String(q.minAmountOut)
  const fee = q.nearkitFee.charged
    ? `NearKit fee ${NEARKIT_FEE_LABEL}${q.nearkitFee.amountNear !== null ? ` (≈${q.nearkitFee.amountNear.toFixed(5)} NEAR)` : ''}: NearKit keeps ${NEARKIT_FEE_RECEIVED_LABEL}, Rhea ${RHEA_APP_FEE_SHARE_LABEL}. Rhea’s own fee ${q.nearkitFee.routerFeeBps !== null ? `${(q.nearkitFee.routerFeeBps / 100).toFixed(2)}%` : 'applies'} too.`
    : 'No NearKit fee on testnet.'
  return [
    bold(`${side === 'buy' ? 'Buy' : 'Sell'} ${token.symbol} ${side === 'buy' ? `with ${amountIn} NEAR` : `· ${amountIn} ${token.symbol}`}`),
    `From ${code(account)} · ${esc(networkId)}`,
    '',
    `You get ≈ ${bold(`${out} ${outSymbol}`)}`,
    `At least ${esc(`${min} ${outSymbol}`)} with ${q.request.slippagePct}% slippage`,
    `Route: ${esc(q.path.join(' → '))} (${q.router === 'aggregator' ? 'Rhea aggregator' : 'Rhea'})`,
    `Price impact: ${q.priceImpactPct === null ? 'not estimated (no USD prices on this network)' : esc(formatPct(q.priceImpactPct, { decimals: 2 }))}`,
    esc(fee),
    `Network fee ≈ ${q.networkFeeNear.toFixed(4)} NEAR · rate ${esc(`${q.rate.toPrecision(6)} ${outSymbol} per ${inSymbol}`)}`,
    '',
    'This is a quote, not a trade. Open NearKit to review the exact transaction and sign it in your wallet. NearKit quotes again right before you sign.',
  ].join('\n')
}

async function quoteAndConfirm(ctx: BotCtx, state: Required<TradeState> & { amount: string }) {
  const { near, config, store } = ctx.deps
  const token = (await near.market.listTokens([state.token])).find((t) => t.id === state.token)
  if (!token) {
    await ctx.reply('⚠️ That token can’t be read from chain right now. Try again in a moment.')
    return
  }
  const decimals = state.side === 'buy' ? NEAR_DECIMALS : token.decimals
  const parsed = tryParseUnits(state.amount, decimals)
  if (!parsed.ok || parsed.value <= 0n) {
    await ctx.reply(`⚠️ ${esc(state.amount)} is not an amount above 0 with at most ${decimals} decimals. Send another, or /cancel.`)
    store.setSession(ctx.chat.id, ctx.user.id, 'trade.amount', state, FLOW_TTL_MS)
    return
  }
  const pay = state.side === 'buy' ? NATIVE_TOKEN_ID : state.token
  const balance = await balanceOf(ctx, state.account, pay).catch(() => null)
  if (balance !== null && balance < parsed.value) {
    const unit = state.side === 'buy' ? 'NEAR' : token.symbol
    await ctx.reply(
      `⚠️ ${code(state.account)} has ${esc(fmt(balance, decimals, 4))} ${esc(unit)} ${state.side === 'buy' ? 'available' : ''}, less than ${esc(state.amount)} ${esc(unit)}.`,
    )
    return
  }
  if (!quotesAllowed(ctx)) {
    await ctx.reply('⏳ Too many quotes in a row. Wait a few seconds and try again.')
    return
  }
  store.clearSession(ctx.chat.id, ctx.user.id)
  const request = {
    tokenIn: state.side === 'buy' ? NATIVE_TOKEN_ID : state.token,
    tokenOut: state.side === 'buy' ? state.token : NATIVE_TOKEN_ID,
    amountIn: state.amount,
    slippagePct: store.getSettings(ctx.user.id).slippagePct,
    walletId: state.account,
  }
  let quote: Quote
  try {
    quote = await near.trading.quote(request)
  } catch (e) {
    // Rhea's answer, as it is: no route is said plainly, never replaced with a guess.
    await ctx.reply(`⚠️ ${esc(describeError(e).message)}\n\nNothing was prepared.`)
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
    quoteText(state.side, token, state.amount, state.account, quote, config.network.label),
    keyboard([urlBtn('✍️ Review & sign in NearKit', url)], [btn('🔄 New quote', `tr:again:${again}`), btn('Cancel', 'tr:cancel')]),
  )
}

async function startTrade(ctx: BotCtx, side: Side, args: string) {
  const account = await needAccount(ctx)
  if (!account) return
  const [tokenArg = '', amountArg = ''] = plainText(args, 200).split(' ')
  const state: TradeState = { side, account }
  if (!tokenArg) {
    ctx.deps.store.setSession(ctx.chat.id, ctx.user.id, 'trade.token', state, FLOW_TTL_MS)
    await ctx.reply(`${side === 'buy' ? '🟢 Buy' : '🔴 Sell'}: which token? Send its symbol or exact contract ID.`)
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
    await ctx.reply(`⚠️ ${esc(match.message)}`)
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
    await ctx.reply(`${bold('NEAR')}${t.market ? `\nPrice ${esc(formatUsdPrice(t.market.priceUsd))}` : ''}`)
    return
  }
  const [supply, held] = await Promise.all([ctx.deps.near.ctx.reader.totalSupply(t.contract).catch(() => null), account ? balanceOf(ctx, account, t.id).catch(() => null) : null])
  const state = (side: Side) => ctx.deps.store.putCallback({ side, account: account ?? '', token: t.id }, ctx.user.id, ctx.chat.id, CALLBACK_TTL_MS)
  await ctx.reply(
    [
      tokenLine(t),
      '',
      `Decimals: ${t.decimals}`,
      ...(supply !== null ? [`Total supply: ${esc(fmt(supply, t.decimals, 0))}`] : []),
      `Price: ${t.market ? `${esc(formatUsdPrice(t.market.priceUsd))} (Rhea price list)` : 'not listed by Rhea'}`,
      ...(account && held !== null ? [`You hold: ${esc(fmt(held, t.decimals, 4))} ${esc(t.symbol)} in ${code(account)}`] : []),
      link(explorerTokenUrl(ctx.deps.config.network, t.contract), 'Explorer'),
      '',
      'Read from the token contract. Whether it trades shows in the quote.',
    ].join('\n'),
    account ? keyboard([btn(`🟢 Buy ${t.symbol}`, `tr:start:${state('buy')}`), btn(`🔴 Sell ${t.symbol}`, `tr:start:${state('sell')}`)]) : undefined,
  )
}

async function showBalance(ctx: BotCtx) {
  const account = await needAccount(ctx)
  if (!account) return
  let b
  try {
    b = await ctx.deps.near.ctx.balances.get(account)
  } catch (e) {
    await ctx.reply(`⚠️ ${esc(describeError(e).message)}`)
    return
  }
  const tokens = (await ctx.deps.near.market.listTokens(b.fts.map((f) => f.contract))).filter((t) => t.contract)
  const lines = b.fts
    .map((f) => ({ f, t: tokens.find((t) => t.id === f.contract) }))
    .filter((x) => x.t)
    .map(({ f, t }) => `• ${esc(fmt(f.raw, (t as TokenListing).decimals, 4))} ${bold((t as TokenListing).symbol)}${f.verified ? '' : ' (indexer)'}`)
  await ctx.reply(
    [
      bold(`Balances · ${account}`),
      '',
      `NEAR available: ${bold(fmt(b.state?.availableYocto ?? 0n, NEAR_DECIMALS, 4))}`,
      ...(lines.length ? ['', ...lines] : ['', 'No tokens held.']),
      '',
      'Read from chain. “(indexer)” means only the indexer reported it.',
    ].join('\n'),
  )
}

export function tradeModule(): BotModule {
  return {
    commands: {
      buy: { ...documented('buy'), run: (ctx, args) => startTrade(ctx, 'buy', args) },
      sell: { ...documented('sell'), run: (ctx, args) => startTrade(ctx, 'sell', args) },
      quote: { ...documented('quote'), run: (ctx, args) => startTrade(ctx, 'buy', args) },
      token: { ...documented('token'), run: showToken },
      balance: { ...documented('balance'), run: (ctx) => showBalance(ctx) },
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
          await ctx.show('Cancelled. Nothing was prepared or signed.')
          return
        }
        if (action === 'buy' || action === 'sell') {
          await ctx.answer()
          return startTrade(ctx, action, '')
        }
        const payload = store.getCallback<Required<TradeState> & { amount?: string }>(arg, ctx.user.id)
        if (!payload) return ctx.answer('That button expired. Start again with /buy or /sell.', true)
        await ctx.answer()
        const account = linkedAccount(ctx)
        if (!account) return void (await needAccount(ctx))
        const state = { ...payload, account }
        if (action === 'pick' || action === 'start') {
          const token = (await ctx.deps.near.market.listTokens([state.token])).find((t) => t.id === state.token)
          if (!token) return void (await ctx.reply('⚠️ That token can’t be read from chain right now.'))
          return askAmount(ctx, state, token)
        }
        if ((action === 'amt' || action === 'again') && (payload.amount || action === 'again')) {
          if (!payload.amount) return
          return quoteAndConfirm(ctx, { ...state, amount: payload.amount })
        }
      },
    },
  }
}
