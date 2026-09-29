import { NATIVE_TOKEN_ID, NEAR_DECIMALS } from '@/config/networks'
import { fractionOf, tryParseUnits } from '@/lib/amounts'
import type { TokenListing } from '@/types/domain'
import type { Intent, TradingWallet } from '../custody/store'
import { ownerKeyNow } from '../custody/recovery'
import { createTradingWallet, readWallet, WalletLimitError, type WalletView } from '../custody/wallets'
import { checkDestinationSyntax, maxNearWithdraw, reviewWithdraw, WITHDRAW_TTL_MS, type WithdrawInput, type WithdrawReview } from '../custody/withdraw'
import { bold, code, esc, plainText, shortAccount } from '../telegram/html'
import { btn, documented, FLOW_TTL_MS, keyboard, type BotCtx, type BotDeps, type BotModule } from './context'
import { intentKeyboard, registerIntentScreens, txLinks } from './intents'
import { amountText, nearText, UNKNOWN, walletErrorText } from './ui'
import { linkedAccount, nearAvailable, needAccount, showWallet } from './wallet'

/**
 * The NearKit wallet in Telegram: create it, deposit, see what it holds (read
 * from chain every time), withdraw NEAR or tokens to any valid address. The
 * linked wallet stays what it was: proof of who you are, never controlled by
 * NearKit, one tap away.
 */

const CALLBACK_TTL_MS = 30 * 60_000

interface Asset {
  asset: string
  symbol: string
  decimals: number
}

export async function tradingWallet(deps: BotDeps, userId: number): Promise<TradingWallet | null> {
  return (await deps.custody?.store.activeWallet(userId, deps.config.network.id)) ?? null
}

const networkName = (deps: BotDeps) => `NEAR ${deps.config.network.label}`
const walletRow = [btn('👛 Wallet', 'cw:home'), btn('« Menu', 'menu:home')]
const errorText = (ctx: BotCtx, e: unknown) => esc(walletErrorText(e, { network: ctx.deps.config.network.id, log: ctx.deps.log, context: 'wallet action failed' }))

async function tokensOf(ctx: BotCtx, view: WalletView) {
  const listed = await ctx.deps.near.market.listTokens(view.tokens.map((t) => t.contract)).catch(() => [] as TokenListing[])
  return view.tokens
    .filter((t) => t.raw > 0n)
    .map((t) => ({ ...t, token: listed.find((l) => l.id === t.contract) ?? null }))
    .filter((t): t is typeof t & { token: TokenListing } => t.token !== null)
}

async function offerCreate(ctx: BotCtx) {
  const linked = await linkedAccount(ctx)
  const near = linked ? await nearAvailable(ctx, linked) : null
  await ctx.show(
    [
      bold('👛 Wallet'),
      '',
      `${bold('NearKit wallet')}: not created yet.`,
      'Trade right here in Telegram: no browser and no wallet pop-up for each trade. It’s a separate wallet: you move in only what you want to trade.',
      '',
      linked
        ? `🔗 Linked wallet ${code(linked)}${near !== null ? ` · ${esc(near)} NEAR` : ''}`
        : 'Link your own wallet first: it proves the NearKit wallet is yours and becomes its backup key.',
    ].join('\n'),
    keyboard(
      [linked ? btn('✨ Create NearKit wallet', 'cw:create') : btn('🔗 Link wallet', 'acct:link')],
      [...(linked ? [btn('🔗 Linked wallet', 'menu:linked')] : []), btn('« Menu', 'menu:home')],
    ),
  )
}

/** The Wallet button: the NearKit wallet when trading wallets run here, else the linked wallet. */
export async function showWalletHome(ctx: BotCtx, details = false) {
  if (!ctx.deps.custody) return showWallet(ctx, { details })
  const w = await tradingWallet(ctx.deps, ctx.user.id)
  if (!w) return offerCreate(ctx)
  const view = await readWallet(ctx.deps.near, w)
  const held = await tokensOf(ctx, view)
  const linked = await linkedAccount(ctx)
  const mine = await ownerKeyNow(ctx.deps.store, w)
  const backup = mine !== null && view.keys?.includes(mine)
  const wnear = view.tokens.some((t) => t.contract === ctx.deps.config.network.wrapContract && t.raw > 0n)
  const balance =
    view.exists === false
      ? ['Empty: send testnet NEAR here to start (📥 Deposit).']
      : [
          view.near === null ? `NEAR ${UNKNOWN} (couldn’t read the chain)` : `${bold(nearText(view.near))} NEAR`,
          ...held.map((t) =>
            details
              ? `${esc(amountText(t.raw, t.token.decimals))} ${bold(t.token.symbol)} · ${code(t.contract)}`
              : `${esc(amountText(t.raw, t.token.decimals))} ${bold(t.token.symbol)}`,
          ),
        ]
  await ctx.show(
    [
      `👛 ${bold('NearKit wallet')} · ${esc(ctx.deps.config.network.label)}`,
      code(w.accountId),
      '',
      ...balance,
      '',
      backup ? '🔐 Backup key: your own wallet can control this one ✓' : view.exists ? '🔐 Backup key: not added yet' : null,
      linked ? `🔗 Linked wallet ${code(linked)}` : '🔗 No linked wallet',
      ...(details
        ? [
            '',
            `NearKit’s key ${code(w.publicKey)}`,
            view.totalNear !== null ? `NEAR total ${esc(amountText(view.totalNear, NEAR_DECIMALS))} · storage ${esc(amountText(view.storageNear ?? 0n, NEAR_DECIMALS))}` : null,
            'Balances are read from chain every time you open this.',
          ]
        : []),
    ]
      .filter((l): l is string => l !== null)
      .join('\n'),
    keyboard(
      [btn('📥 Deposit', 'cw:dep'), btn('📤 Withdraw', 'cw:wd')],
      [btn('🟢 Buy', 'tr:buy'), btn('🔴 Sell', 'tr:sell')],
      wnear ? [btn('🔁 Unwrap wNEAR', 'cu:unwrap')] : [],
      [btn('🔐 Recovery', 'cr:show'), btn('⚙️ Settings', 'set:show')],
      [btn('🔄 Refresh', 'cw:home'), btn(details ? '🔎 Less' : '🔎 Details', details ? 'cw:home' : 'cw:details')],
      [btn('🔗 Linked wallet', 'menu:linked'), btn('« Menu', 'menu:home')],
    ),
  )
}

async function create(ctx: BotCtx) {
  const custody = ctx.deps.custody
  if (!custody) return ctx.answer('NearKit wallets aren’t available on this server.', true)
  const linked = await needAccount(ctx)
  const link = linked ? await ctx.deps.store.linkOf(ctx.deps.config.network.id, linked) : null
  if (!link) return
  await ctx.answer()
  let result
  try {
    // The linked wallet it is created with becomes its owner: export, backup key and revoke answer to it alone.
    result = await createTradingWallet(custody, ctx.user.id, ctx.deps.config.network.id, ctx.deps.now(), { accountId: link.accountId, publicKey: link.publicKey })
  } catch (e) {
    if (e instanceof WalletLimitError) return ctx.show(`⚠️ ${esc(e.message)}`, keyboard(walletRow))
    throw e
  }
  const { wallet, created } = result
  await ctx.show(
    [
      created ? `✅ ${bold('NearKit wallet created')}` : `👛 ${bold('Your NearKit wallet')}`,
      code(wallet.accountId),
      '',
      'It’s empty. Send testnet NEAR to this address to start trading here. Tap the address to copy it.',
      'Once it’s funded, add your linked wallet as its backup key (🔐 Recovery): then it’s yours even without NearKit.',
    ].join('\n'),
    keyboard([btn('📥 Deposit', 'cw:dep'), btn('👛 Wallet', 'cw:home')]),
  )
}

async function deposit(ctx: BotCtx) {
  const w = await tradingWallet(ctx.deps, ctx.user.id)
  if (!w) return showWalletHome(ctx)
  await ctx.show(
    [
      `📥 ${bold('Deposit to your NearKit wallet')}`,
      '',
      code(w.accountId),
      '',
      `Network: ${bold(networkName(ctx.deps))}`,
      ctx.deps.config.network.id === 'testnet' ? 'Send testnet NEAR or testnet tokens only.' : 'Send NEAR or NEAR tokens only.',
      'Tap the address to copy it. The balance updates once the transfer is on chain.',
    ].join('\n'),
    keyboard([btn('🔄 Refresh balance', 'cw:home'), btn('« Wallet', 'cw:home')]),
  )
}

// ─── withdraw ───────────────────────────────────────────────────────────────

async function withdrawStart(ctx: BotCtx) {
  const w = await tradingWallet(ctx.deps, ctx.user.id)
  if (!w) return showWalletHome(ctx)
  const view = await readWallet(ctx.deps.near, w)
  if (!view.exists) return ctx.show('Your NearKit wallet is empty: nothing to withdraw yet.', keyboard([btn('📥 Deposit', 'cw:dep')], walletRow))
  const held = await tokensOf(ctx, view)
  const put = (a: Asset) => ctx.deps.store.putCallback(a, ctx.user.id, ctx.chat.id, CALLBACK_TTL_MS)
  const nearMax = view.near !== null ? maxNearWithdraw(view.near) : 0n
  const nearId = nearMax > 0n ? await put({ asset: NATIVE_TOKEN_ID, symbol: 'NEAR', decimals: NEAR_DECIMALS }) : null
  const heldIds = await Promise.all(held.map((t) => put({ asset: t.contract, symbol: t.token.symbol, decimals: t.token.decimals })))
  const rows = [
    ...(nearId ? [[btn(`NEAR · ${nearText(view.near ?? 0n)}`, `cw:wa:${nearId}`)]] : []),
    ...held.map((t, i) => [btn(`${t.token.symbol} · ${amountText(t.raw, t.token.decimals)}`, `cw:wa:${heldIds[i]}`)]),
  ]
  if (!rows.length) return ctx.show('Nothing to withdraw: the wallet only holds what it needs for fees.', keyboard(walletRow))
  await ctx.show(`📤 ${bold('Withdraw')} · what?`, keyboard(...rows, [btn('✖ Cancel', 'cw:home')]))
}

async function available(ctx: BotCtx, w: TradingWallet, a: Asset): Promise<bigint | null> {
  if (a.asset === NATIVE_TOKEN_ID) {
    const view = await readWallet(ctx.deps.near, w)
    return view.near === null ? null : maxNearWithdraw(view.near)
  }
  return ctx.deps.near.ctx.reader.balanceOf(a.asset, w.accountId).catch(() => null)
}

async function askWithdrawAmount(ctx: BotCtx, a: Asset) {
  const w = await tradingWallet(ctx.deps, ctx.user.id)
  if (!w) return showWalletHome(ctx)
  const max = await available(ctx, w, a)
  if (max === null) return ctx.show(`⚠️ ${esc('The NEAR network isn’t answering right now. Try again in a moment.')}`, keyboard(walletRow))
  if (max === 0n) return ctx.show(`Nothing of ${esc(a.symbol)} to withdraw.`, keyboard(walletRow))
  const put = (amount: bigint) => ctx.deps.store.putCallback({ ...a, amount: amount.toString() }, ctx.user.id, ctx.chat.id, CALLBACK_TTL_MS)
  const [q1, q2, qMax] = await Promise.all([put(fractionOf(max, 25, 100)), put(fractionOf(max, 50, 100)), put(max)])
  await ctx.deps.store.setSession(ctx.chat.id, ctx.user.id, 'wd.amount', { ...a, max: max.toString() }, FLOW_TTL_MS)
  await ctx.show(
    [
      `📤 ${bold(`Withdraw ${a.symbol}`)}`,
      `Available ${bold(`${amountText(max, a.decimals, 6)} ${a.symbol}`)}${a.asset === NATIVE_TOKEN_ID ? ' (a little stays for the network fee)' : ''}`,
      '',
      `How much? Tap or send an amount.`,
    ].join('\n'),
    keyboard([btn('25%', `cw:wm:${q1}`), btn('50%', `cw:wm:${q2}`), btn(`MAX · ${amountText(max, a.decimals, 4)}`, `cw:wm:${qMax}`)], [btn('✖ Cancel', 'cw:home')]),
  )
}

async function askDestination(ctx: BotCtx, a: Asset & { amount: string }) {
  const linked = await linkedAccount(ctx)
  const linkedId = linked ? await ctx.deps.store.putCallback({ ...a, to: linked, linked: true }, ctx.user.id, ctx.chat.id, CALLBACK_TTL_MS) : null
  await ctx.deps.store.setSession(ctx.chat.id, ctx.user.id, 'wd.to', a, FLOW_TTL_MS)
  await ctx.show(
    [
      `📤 ${bold(`Withdraw ${amountText(BigInt(a.amount), a.decimals, 6)} ${a.symbol}`)} · where to?`,
      '',
      linked
        ? `Your linked wallet is ready below, or send any NEAR ${esc(ctx.deps.config.network.id)} address.`
        : `Send the NEAR ${esc(ctx.deps.config.network.id)} address to withdraw to.`,
    ].join('\n'),
    keyboard([...(linked && linkedId ? [btn(`🔗 ${shortAccount(linked, 28)} (linked)`, `cw:wt:${linkedId}`)] : [])], [btn('✖ Cancel', 'cw:home')]),
  )
}

export function withdrawReviewText(deps: BotDeps, input: WithdrawInput, review: WithdrawReview): string {
  const native = input.asset === NATIVE_TOKEN_ID
  return [
    `📤 ${bold('Review withdrawal')}`,
    '',
    `Asset ${bold(input.symbol)}${native ? '' : ` · ${code(input.asset)}`}`,
    `Amount ${bold(`${amountText(BigInt(input.amount), input.decimals, 8)} ${input.symbol}`)}`,
    `To ${code(input.to)}${input.linked ? ' · your linked wallet' : ''}`,
    `Network ${esc(networkName(deps))}`,
    `Network fee ≈ ${esc(nearText(BigInt(review.feeNear)))} NEAR`,
    ...(review.registration !== null ? [`Registration ${esc(nearText(BigInt(review.registration), 5))} NEAR · the address has no ${esc(input.symbol)} account yet`] : []),
    ...(review.fresh ? [`⚠️ This address has never been used on ${esc(deps.config.network.id)}. Check it carefully.`] : []),
    '',
    'Check the address: transfers can’t be undone.',
    '⏱ Valid for 5 minutes.',
  ].join('\n')
}

async function reviewAndConfirm(ctx: BotCtx, input: WithdrawInput) {
  const custody = ctx.deps.custody
  const w = await tradingWallet(ctx.deps, ctx.user.id)
  if (!custody || !w) return showWalletHome(ctx)
  let review: WithdrawReview
  try {
    review = await reviewWithdraw(ctx.deps.near, ctx.deps.config.network, w, input)
  } catch (e) {
    await ctx.deps.store.setSession(ctx.chat.id, ctx.user.id, 'wd.to', { asset: input.asset, symbol: input.symbol, decimals: input.decimals, amount: input.amount }, FLOW_TTL_MS)
    await ctx.reply(`⚠️ ${errorText(ctx, e)}\n\nSend another address, or /cancel.`, keyboard([btn('✖ Cancel', 'cw:home')]))
    return
  }
  await ctx.deps.store.clearSession(ctx.chat.id, ctx.user.id)
  const intent = await custody.store.createIntent({
    walletId: w.id,
    userId: ctx.user.id,
    chatId: ctx.chat.id,
    kind: 'withdraw',
    params: input,
    quote: review,
    ttlMs: WITHDRAW_TTL_MS,
  })
  await ctx.reply(withdrawReviewText(ctx.deps, input, review), intentKeyboard(intent, '✅ Confirm withdraw'))
}

registerIntentScreens('withdraw', {
  review: (deps, intent) => ({
    text: withdrawReviewText(deps, intent.params as unknown as WithdrawInput, intent.quote as unknown as WithdrawReview),
    confirm: '✅ Confirm withdraw',
  }),
  result: (deps, intent: Intent) => {
    const input = intent.params as unknown as WithdrawInput
    const r = intent.result
    const links = r?.hashes.length ? txLinks(deps, r.hashes) : null
    const text = r?.ok
      ? [
          `✅ ${bold('Withdrawal confirmed')}`,
          `Sent ${bold(`${amountText(BigInt(input.amount), input.decimals, 8)} ${input.symbol}`)}`,
          `To ${code(input.to)}`,
          ...(links ? [`Tx ${links}`] : []),
        ].join('\n')
      : [`❌ ${bold('Withdrawal failed')}`, esc(r?.message ?? 'Nothing was sent.'), ...(links ? [`Tx ${links}`] : [])].join('\n')
    return { text, markup: keyboard(walletRow) }
  },
  again: () => ({ text: '📤 Withdraw again', data: 'cw:wd' }),
})

export function tradingWalletModule(): BotModule {
  const payload = <T>(ctx: BotCtx, id: string) => ctx.deps.store.getCallback<T>(id, ctx.user.id)
  return {
    commands: {
      wallet: { ...documented('wallet'), run: (ctx) => showWalletHome(ctx) },
      deposit: { ...documented('deposit'), run: deposit },
      withdraw: { ...documented('withdraw'), run: withdrawStart },
    },
    flows: {
      'wd.amount': async (ctx, text, data) => {
        const a = data as unknown as Asset & { max: string }
        const parsed = tryParseUnits(plainText(text, 40).replace(',', '.').replace(/\s/g, ''), a.decimals)
        if (!parsed.ok || parsed.value <= 0n || parsed.value > BigInt(a.max)) {
          await ctx.reply(`⚠️ Send an amount above 0 and at most ${esc(amountText(BigInt(a.max), a.decimals, 6))} ${esc(a.symbol)}, or /cancel.`)
          return
        }
        await askDestination(ctx, { asset: a.asset, symbol: a.symbol, decimals: a.decimals, amount: parsed.value.toString() })
      },
      'wd.to': async (ctx, text, data) => {
        const a = data as unknown as Asset & { amount: string }
        const w = await tradingWallet(ctx.deps, ctx.user.id)
        if (!w) return showWalletHome(ctx)
        let to: string
        try {
          to = checkDestinationSyntax(plainText(text, 80), ctx.deps.config.network, w, a.asset)
        } catch (e) {
          await ctx.reply(`⚠️ ${errorText(ctx, e)}\n\nSend another address, or /cancel.`)
          return
        }
        await reviewAndConfirm(ctx, { ...a, to, linked: to === (await linkedAccount(ctx)) })
      },
    },
    callbacks: {
      cw: async (ctx, action, arg) => {
        switch (action) {
          case 'home':
            await ctx.answer()
            await ctx.deps.store.clearSession(ctx.chat.id, ctx.user.id)
            return showWalletHome(ctx)
          case 'details':
            await ctx.answer()
            return showWalletHome(ctx, true)
          case 'create':
            return create(ctx)
          case 'dep':
            await ctx.answer()
            return deposit(ctx)
          case 'wd':
            await ctx.answer()
            return withdrawStart(ctx)
          case 'wa': {
            const a = await payload<Asset>(ctx, arg)
            if (!a) return ctx.answer('That button expired. Open the wallet again.', true)
            await ctx.answer()
            return askWithdrawAmount(ctx, a)
          }
          case 'wm': {
            const a = await payload<Asset & { amount: string }>(ctx, arg)
            if (!a) return ctx.answer('That button expired. Open the wallet again.', true)
            await ctx.answer()
            return askDestination(ctx, a)
          }
          case 'wt': {
            const a = await payload<WithdrawInput>(ctx, arg)
            if (!a) return ctx.answer('That button expired. Open the wallet again.', true)
            await ctx.answer()
            return reviewAndConfirm(ctx, a)
          }
          default:
            await ctx.answer()
        }
      },
    },
  }
}
