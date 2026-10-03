import { NEAR_DECIMALS } from '@/config/networks'
import { formatUnits, formatUnitsUp } from '@/lib/amounts'
import { NEARKIT_FEE_LABEL } from '@/lib/fees'
import { GAS_RESERVE_LABEL, GAS_RESERVE_NOT_FEE, GAS_RESERVE_NOTE, gasReserveYocto } from '@/lib/gasReserve'
import { ROUTE_SOURCE_LABEL } from '@/services/routing/select'
import { NETWORK_BUSY_WARNING } from '@/services/near/congestion'
import { formatPct } from '@/lib/format'
import type { Intent } from '../custody/store'
import { SWAP_QUOTE_TTL_MS, type SwapParams, type SwapQuote } from '../custody/swap'
import { UNWRAP_TTL_MS, type UnwrapParams } from '../custody/unwrap'
import { bold, code, esc } from '../telegram/html'
import { btn, keyboard, type BotCtx, type BotDeps, type BotModule } from './context'
import { intentKeyboard, registerIntentScreens, txLinks } from './intents'
import { refreshPortfolio } from './portfolio'
import { flowWallet, tradingWallet, walletLine } from './tradingWallet'
import { friendlyError, nearText, UNKNOWN } from './ui'

/**
 * Buy and Sell from the NearKit wallet: the quote screen with its Confirm button,
 * and the result read from chain. Confirm goes to the intent engine (intents.ts):
 * a fresh route right before signing, one transaction per step, never twice.
 */

const CALLBACK_TTL_MS = 30 * 60_000
const fmt = (raw: bigint, decimals: number, maxFraction = 6) => formatUnits(raw, decimals, { maxFraction, group: true })
const taxPct = (bps: number) => String(bps / 100)

export async function nativeQuoteText(deps: BotDeps, intent: Intent): Promise<string> {
  const p = intent.params as unknown as SwapParams
  const q = intent.quote as unknown as SwapQuote
  const buy = p.side === 'buy'
  const outDecimals = buy ? p.decimals : NEAR_DECIMALS
  const outSymbol = buy ? p.symbol : 'NEAR'
  const wallet = await deps.custody?.store.wallet(intent.walletId)
  const feeAmount = q.fee.charged && q.fee.amountRaw !== null ? BigInt(q.fee.amountRaw) : null
  const fee =
    feeAmount === null
      ? `none on ${deps.config.network.id}`
      : q.fee.routerShareBps === 0
        ? `${NEARKIT_FEE_LABEL} (${q.fee.token === p.token ? `${fmt(feeAmount, p.decimals)} ${p.symbol}` : `${fmt(feeAmount, NEAR_DECIMALS)} NEAR`}, sent with the swap)`
        : `${NEARKIT_FEE_LABEL} (included in the rate)`
  const registration = BigInt(q.registration)
  const need = q.need !== undefined ? BigInt(q.need) : null
  const available = q.available !== undefined ? BigInt(q.available) : null
  const up = (yocto: bigint) => formatUnitsUp(yocto, NEAR_DECIMALS, 4)
  const seconds = Math.max(0, Math.round((intent.expiresAt - deps.now()) / 1000))
  return [
    `${buy ? '🟢' : '🔴'} ${bold(`${buy ? 'Buy' : 'Sell'} ${p.symbol}`)}`,
    code(p.token),
    '',
    ...(wallet ? [`From ${walletLine(wallet)}`] : []),
    `You pay ${bold(`${p.amountIn} ${buy ? 'NEAR' : p.symbol}`)}`,
    `You receive ${bold(`≈ ${fmt(BigInt(q.amountOut), outDecimals)} ${outSymbol}`)}`,
    `Minimum ${esc(`${fmt(BigInt(q.minOut), outDecimals)} ${outSymbol}`)} · ${p.slippagePct}% slippage`,
    `Price impact ${q.priceImpactPct === null ? `${UNKNOWN} (no prices on ${esc(deps.config.network.id)})` : esc(formatPct(q.priceImpactPct, { decimals: 2 }))}`,
    `NearKit fee ${esc(fee)}`,
    `Actual network fee ≈ ${esc(nearText(BigInt(q.networkFeeNear)))} NEAR`,
    ...(registration > 0n ? [`Registration ${esc(nearText(registration, 5))} NEAR · first time with a token here`] : []),
    ...(need !== null
      ? [
          `${esc(GAS_RESERVE_LABEL)} ${bold(`${up(gasReserveYocto(need, buy ? BigInt(q.amountInRaw) : 0n, registration))} NEAR`)}`,
          esc(`${GAS_RESERVE_NOTE} ${GAS_RESERVE_NOT_FEE}`),
          `Needs ${bold(`${up(need)} NEAR`)} available in all, gas reserve included`,
        ]
      : []),
    ...(need !== null && available !== null && available < need
      ? [`⚠️ Your NearKit wallet has ${esc(fmt(available, NEAR_DECIMALS, 4))} NEAR. Deposit at least ${up(need - available)} NEAR more first.`]
      : []),
    ...(q.tax?.inBps ? [`Token tax ${taxPct(q.tax.inBps)}% on tokens entering the pool (${esc(p.symbol)}’s own), already in the figures`] : []),
    ...(q.tax?.outBps ? [`Token tax ${taxPct(q.tax.outBps)}% on tokens leaving the pool (${esc(p.symbol)}’s own), already in the figures`] : []),
    `Route ${esc(q.path.join(' → '))} · ${esc(q.source ? ROUTE_SOURCE_LABEL[q.source] : 'Rhea')}`,
    ...(q.busy ? [`⚠️ ${esc(NETWORK_BUSY_WARNING)}`] : []),
    '',
    `⏱ Valid for ${seconds}s. Right before sending, NearKit checks the price again; if you’d get less than the minimum, it asks you first.`,
  ].join('\n')
}

const confirmLabel = (p: SwapParams) => (p.side === 'buy' ? `✅ Confirm buy` : `✅ Confirm sell`)

/**
 * Creates the intent for this quote (replacing that wallet's older open quotes) and shows
 * it with Confirm. `walletId`: the NearKit wallet the trade started on; it stays the one
 * that trades, whatever the user selects meanwhile.
 */
export async function sendNativeQuote(ctx: BotCtx, params: SwapParams, againData: string, walletId: string): Promise<void> {
  const custody = ctx.deps.custody
  const wallet = await flowWallet(ctx, walletId)
  if (!custody) return
  if (!wallet) {
    await ctx.reply('That NearKit wallet is closed or not yours any more. Nothing was prepared.', keyboard([btn('👛 Wallet', 'cw:home')]))
    return
  }
  const blocked = await custody.ops.blocked(params.side, wallet)
  if (blocked) {
    await ctx.reply(`⏸ ${esc(blocked)}`, keyboard([btn('👛 Wallet', 'cw:home')]))
    return
  }
  let quote: SwapQuote
  try {
    quote = await custody.swaps.quote(params, wallet)
  } catch (e) {
    await ctx.reply(
      `⚠️ ${esc(friendlyError(e, { network: ctx.deps.config.network.id, side: params.side, log: ctx.deps.log, context: 'quote failed' }))}\n\nNothing was prepared.`,
      keyboard([btn('« Menu', 'menu:home')]),
    )
    return
  }
  // One live quote per wallet: an older Confirm button can't trade any more.
  await custody.store.cancelQuoted(wallet.id, ['buy', 'sell'])
  const intent = await custody.store.createIntent({ walletId: wallet.id, userId: ctx.user.id, chatId: ctx.chat.id, kind: params.side, params, quote, ttlMs: SWAP_QUOTE_TTL_MS })
  await ctx.reply(
    await nativeQuoteText(ctx.deps, intent),
    keyboard([btn(confirmLabel(params), `cx:ok:${intent.id}`)], [btn('🔄 Refresh', againData), btn('✖ Cancel', `cx:no:${intent.id}`)]),
  )
}

async function tradeResult(deps: BotDeps, intent: Intent) {
  const p = intent.params as unknown as SwapParams
  const r = intent.result
  const facts = (r?.facts ?? {}) as { tokenAmount?: string; nearAmount?: string | null; fee?: { token: string; raw: string } | null }
  const wallet = await deps.custody?.store.wallet(intent.walletId)
  if (wallet) refreshPortfolio(deps, wallet.accountId)
  const links = r?.hashes.length ? txLinks(deps, r.hashes) : null
  const token = facts.tokenAmount ? `${fmt(BigInt(facts.tokenAmount), p.decimals)} ${p.symbol}` : UNKNOWN
  const near = facts.nearAmount ? `${fmt(BigInt(facts.nearAmount), NEAR_DECIMALS)} NEAR` : UNKNOWN
  const feeToken = facts.fee?.token
  const fee = facts.fee
    ? feeToken === p.token
      ? `${fmt(BigInt(facts.fee.raw), p.decimals)} ${p.symbol}`
      : feeToken === deps.config.network.wrapContract || feeToken === 'near'
        ? `${fmt(BigInt(facts.fee.raw), NEAR_DECIMALS)} NEAR`
        : `${facts.fee.raw} raw units of ${feeToken}`
    : `none on ${deps.config.network.id}`
  const again = await deps.store.putCallback({ side: p.side, token: p.token, account: wallet?.accountId ?? '', native: true }, intent.userId, intent.chatId, CALLBACK_TTL_MS)
  const text = r?.ok
    ? [
        `✅ ${bold(p.side === 'buy' ? 'Buy confirmed' : 'Sell confirmed')}`,
        ...(wallet ? [`Wallet ${walletLine(wallet)}`] : []),
        p.side === 'buy' ? `Spent ${bold(near)}` : `Sold ${bold(token)}`,
        p.side === 'buy' ? `Received ${bold(token)}` : `Received ${bold(near)}`,
        `NearKit fee ${esc(fee)}`,
        ...(links ? [`Tx ${links}`] : []),
      ].join('\n')
    : [`❌ ${bold(p.side === 'buy' ? 'Buy failed' : 'Sell failed')}`, esc(r?.message ?? 'Nothing was sent.'), ...(links ? [`Tx ${links}`] : [])].join('\n')
  const unwrap = !r?.ok && p.side === 'buy' && r?.hashes.length ? [btn('🔁 Unwrap wNEAR', `cu:unwrap:${intent.walletId}`)] : []
  return {
    text,
    markup: keyboard([btn(p.side === 'buy' ? `🟢 Buy ${p.symbol} again` : `🔴 Sell ${p.symbol} again`, `tr:start:${again}`), btn('📊 Positions', 'pf:positions')], unwrap, [
      btn('👛 Wallet', 'cw:home'),
      btn('« Menu', 'menu:home'),
    ]),
  }
}

for (const side of ['buy', 'sell'] as const) {
  registerIntentScreens(side, {
    review: async (deps, intent) => ({ text: await nativeQuoteText(deps, intent), confirm: confirmLabel(intent.params as unknown as SwapParams) }),
    result: tradeResult,
  })
}

// ─── unwrap ───────────────────────────────────────────────────────────────────

async function unwrapReview(deps: BotDeps, intent: Intent): Promise<string> {
  const p = intent.params as unknown as UnwrapParams
  const w = await deps.custody?.store.wallet(intent.walletId)
  return [
    `🔁 ${bold('Unwrap wNEAR')}${w ? ` · ${walletLine(w)}` : ''}`,
    '',
    `Amount ${bold(`${fmt(BigInt(p.amount), NEAR_DECIMALS)} wNEAR → NEAR`)}`,
    `Network ${esc(`NEAR ${deps.config.network.label}`)}`,
    'Network fee ≈ 0.0005 NEAR',
  ].join('\n')
}

registerIntentScreens('unwrap', {
  review: async (deps, intent) => ({ text: await unwrapReview(deps, intent), confirm: '✅ Confirm unwrap' }),
  result: (deps, intent) => {
    const p = intent.params as unknown as UnwrapParams
    const r = intent.result
    const links = r?.hashes.length ? txLinks(deps, r.hashes) : null
    const text = r?.ok
      ? [`✅ ${bold('Unwrapped')}`, `${bold(`${fmt(BigInt(p.amount), NEAR_DECIMALS)} wNEAR`)} is now NEAR.`, ...(links ? [`Tx ${links}`] : [])].join('\n')
      : [`❌ ${bold('Unwrap failed')}`, esc(r?.message ?? 'Nothing was sent.'), ...(links ? [`Tx ${links}`] : [])].join('\n')
    return { text, markup: keyboard([btn('👛 Wallet', 'cw:home'), btn('« Menu', 'menu:home')]) }
  },
})

/** Offers to unwrap a wallet's whole wNEAR balance: the wallet the button was for, else the selected one. */
async function startUnwrap(ctx: BotCtx, walletId: string) {
  const custody = ctx.deps.custody
  const wallet = walletId ? await flowWallet(ctx, walletId) : await tradingWallet(ctx.deps, ctx.user.id)
  const raw = wallet ? await ctx.deps.near.ctx.reader.balanceOf(ctx.deps.config.network.wrapContract, wallet.accountId).catch(() => 0n) : 0n
  if (!custody || !wallet || raw <= 0n) return ctx.show('No wNEAR to unwrap.', keyboard([btn('👛 Wallet', 'cw:home')]))
  await custody.store.cancelQuoted(wallet.id, ['unwrap'])
  const intent = await custody.store.createIntent({
    walletId: wallet.id,
    userId: ctx.user.id,
    chatId: ctx.chat.id,
    kind: 'unwrap',
    params: { amount: raw.toString() } satisfies UnwrapParams,
    ttlMs: UNWRAP_TTL_MS,
  })
  await ctx.show(await unwrapReview(ctx.deps, intent), intentKeyboard(intent, '✅ Confirm unwrap'))
}

export function nativeTradeModule(): BotModule {
  return {
    callbacks: {
      cu: async (ctx, action, arg) => {
        await ctx.answer()
        if (action === 'unwrap') return startUnwrap(ctx, arg)
      },
    },
  }
}
