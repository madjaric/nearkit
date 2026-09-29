import { NEAR_DECIMALS } from '@/config/networks'
import { formatUnits } from '@/lib/amounts'
import { NEARKIT_FEE_LABEL } from '@/lib/fees'
import { formatPct } from '@/lib/format'
import type { Intent } from '../custody/store'
import { SWAP_QUOTE_TTL_MS, type SwapParams, type SwapQuote } from '../custody/swap'
import { UNWRAP_TTL_MS, type UnwrapParams } from '../custody/unwrap'
import { bold, code, esc, shortAccount } from '../telegram/html'
import { btn, keyboard, type BotCtx, type BotDeps, type BotModule } from './context'
import { intentKeyboard, registerIntentScreens, txLinks } from './intents'
import { refreshPortfolio } from './portfolio'
import { tradingWallet } from './tradingWallet'
import { friendlyError, nearText, UNKNOWN } from './ui'

/**
 * Buy and Sell from the NearKit wallet: the quote screen with its Confirm button,
 * and the result read from chain. Confirm goes to the intent engine (intents.ts):
 * a fresh route right before signing, one transaction per step, never twice.
 */

const CALLBACK_TTL_MS = 30 * 60_000
const fmt = (raw: bigint, decimals: number, maxFraction = 6) => formatUnits(raw, decimals, { maxFraction, group: true })

export function nativeQuoteText(deps: BotDeps, intent: Intent): string {
  const p = intent.params as unknown as SwapParams
  const q = intent.quote as unknown as SwapQuote
  const buy = p.side === 'buy'
  const outDecimals = buy ? p.decimals : NEAR_DECIMALS
  const outSymbol = buy ? p.symbol : 'NEAR'
  const wallet = deps.custody?.store.wallet(intent.walletId)
  const fee = q.fee.charged && q.fee.amountRaw !== null ? `${NEARKIT_FEE_LABEL} (included in the rate)` : `none on ${deps.config.network.id}`
  const registration = BigInt(q.registration)
  const seconds = Math.max(0, Math.round((intent.expiresAt - deps.now()) / 1000))
  return [
    `${buy ? '🟢' : '🔴'} ${bold(`${buy ? 'Buy' : 'Sell'} ${p.symbol}`)}`,
    code(p.token),
    '',
    ...(wallet ? [`From your NearKit wallet ${code(shortAccount(wallet.accountId))}`] : []),
    `You pay ${bold(`${p.amountIn} ${buy ? 'NEAR' : p.symbol}`)}`,
    `You receive ${bold(`≈ ${fmt(BigInt(q.amountOut), outDecimals)} ${outSymbol}`)}`,
    `Minimum ${esc(`${fmt(BigInt(q.minOut), outDecimals)} ${outSymbol}`)} · ${p.slippagePct}% slippage`,
    `Price impact ${q.priceImpactPct === null ? `${UNKNOWN} (no prices on ${esc(deps.config.network.id)})` : esc(formatPct(q.priceImpactPct, { decimals: 2 }))}`,
    `NearKit fee ${esc(fee)}`,
    `Network fee ≈ ${esc(nearText(BigInt(q.networkFeeNear)))} NEAR`,
    ...(registration > 0n ? [`Registration ${esc(nearText(registration, 5))} NEAR · first time with a token here`] : []),
    `Route ${esc(q.path.join(' → '))} · Rhea`,
    '',
    `⏱ Valid for ${seconds}s. Right before sending, NearKit checks the price again; if you’d get less than the minimum, it asks you first.`,
  ].join('\n')
}

const confirmLabel = (p: SwapParams) => (p.side === 'buy' ? `✅ Confirm buy` : `✅ Confirm sell`)

/** Creates the intent for this quote (replacing older open quotes) and shows it with Confirm. */
export async function sendNativeQuote(ctx: BotCtx, params: SwapParams, againData: string): Promise<void> {
  const custody = ctx.deps.custody
  const wallet = tradingWallet(ctx.deps, ctx.user.id)
  if (!custody || !wallet) return
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
  custody.store.cancelQuoted(wallet.id, ['buy', 'sell'])
  const intent = custody.store.createIntent({ walletId: wallet.id, userId: ctx.user.id, chatId: ctx.chat.id, kind: params.side, params, quote, ttlMs: SWAP_QUOTE_TTL_MS })
  await ctx.reply(
    nativeQuoteText(ctx.deps, intent),
    keyboard([btn(confirmLabel(params), `cx:ok:${intent.id}`)], [btn('🔄 Refresh', againData), btn('✖ Cancel', `cx:no:${intent.id}`)]),
  )
}

function tradeResult(deps: BotDeps, intent: Intent) {
  const p = intent.params as unknown as SwapParams
  const r = intent.result
  const facts = (r?.facts ?? {}) as { tokenAmount?: string; nearAmount?: string | null; fee?: { token: string; raw: string } | null }
  const wallet = deps.custody?.store.wallet(intent.walletId)
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
  const again = deps.store.putCallback({ side: p.side, token: p.token, account: wallet?.accountId ?? '', native: true }, intent.userId, intent.chatId, CALLBACK_TTL_MS)
  const text = r?.ok
    ? [
        `✅ ${bold(p.side === 'buy' ? 'Buy confirmed' : 'Sell confirmed')}`,
        p.side === 'buy' ? `Spent ${bold(near)}` : `Sold ${bold(token)}`,
        p.side === 'buy' ? `Received ${bold(token)}` : `Received ${bold(near)}`,
        `NearKit fee ${esc(fee)}`,
        ...(links ? [`Tx ${links}`] : []),
      ].join('\n')
    : [`❌ ${bold(p.side === 'buy' ? 'Buy failed' : 'Sell failed')}`, esc(r?.message ?? 'Nothing was sent.'), ...(links ? [`Tx ${links}`] : [])].join('\n')
  const unwrap = !r?.ok && p.side === 'buy' && r?.hashes.length ? [btn('🔁 Unwrap wNEAR', 'cu:unwrap')] : []
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
    review: (deps, intent) => ({ text: nativeQuoteText(deps, intent), confirm: confirmLabel(intent.params as unknown as SwapParams) }),
    result: tradeResult,
  })
}

// ─── unwrap ───────────────────────────────────────────────────────────────────

function unwrapReview(deps: BotDeps, intent: Intent): string {
  const p = intent.params as unknown as UnwrapParams
  return [
    `🔁 ${bold('Unwrap wNEAR')}`,
    '',
    `Amount ${bold(`${fmt(BigInt(p.amount), NEAR_DECIMALS)} wNEAR → NEAR`)}`,
    `Network ${esc(`NEAR ${deps.config.network.label}`)}`,
    'Network fee ≈ 0.0005 NEAR',
  ].join('\n')
}

registerIntentScreens('unwrap', {
  review: (deps, intent) => ({ text: unwrapReview(deps, intent), confirm: '✅ Confirm unwrap' }),
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

/** Offers to unwrap the wallet's whole wNEAR balance. */
async function startUnwrap(ctx: BotCtx) {
  const custody = ctx.deps.custody
  const wallet = tradingWallet(ctx.deps, ctx.user.id)
  const raw = wallet ? await ctx.deps.near.ctx.reader.balanceOf(ctx.deps.config.network.wrapContract, wallet.accountId).catch(() => 0n) : 0n
  if (!custody || !wallet || raw <= 0n) return ctx.show('No wNEAR to unwrap.', keyboard([btn('👛 Wallet', 'cw:home')]))
  custody.store.cancelQuoted(wallet.id, ['unwrap'])
  const intent = custody.store.createIntent({
    walletId: wallet.id,
    userId: ctx.user.id,
    chatId: ctx.chat.id,
    kind: 'unwrap',
    params: { amount: raw.toString() } satisfies UnwrapParams,
    ttlMs: UNWRAP_TTL_MS,
  })
  await ctx.show(unwrapReview(ctx.deps, intent), intentKeyboard(intent, '✅ Confirm unwrap'))
}

export function nativeTradeModule(): BotModule {
  return {
    callbacks: {
      cu: async (ctx, action) => {
        await ctx.answer()
        if (action === 'unwrap') return startUnwrap(ctx)
      },
    },
  }
}
