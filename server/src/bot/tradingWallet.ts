import { NATIVE_TOKEN_ID, NEAR_DECIMALS } from '@/config/networks'
import { fractionOf, tryParseUnits } from '@/lib/amounts'
import type { TokenListing } from '@/types/domain'
import { accountState } from '@/services/near/account'
import { MAX_ACTIVE_WALLETS_PER_USER, MAX_WALLET_LABEL, walletName } from '../custody/limits'
import { ownerKeyNow } from '../custody/recovery'
import type { Intent, TradingWallet } from '../custody/store'
import { createTradingWallet, ownerForNewWallet, readWallet, WalletLimitError, type WalletView } from '../custody/wallets'
import { checkDestinationSyntax, maxNearWithdraw, reviewWithdraw, WITHDRAW_TTL_MS, type WithdrawInput, type WithdrawReview } from '../custody/withdraw'
import { randomToken } from '../ids'
import { bold, code, esc, plainText, shortAccount } from '../telegram/html'
import { copyBtn, btn, documented, FLOW_TTL_MS, keyboard, urlBtn, type BotCtx, type BotDeps, type BotModule } from './context'
import { intentKeyboard, registerIntentScreens, txLinks } from './intents'
import { amountText, nearText, UNKNOWN, walletErrorText } from './ui'
import { linkedAccount, nearAvailable, needAccount, showWallet } from './wallet'

/**
 * NearKit wallets in Telegram: up to MAX_ACTIVE_WALLETS_PER_USER per user, each with its
 * own key, balance, history and recovery. One of them is selected for trading; every
 * screen and every confirmation names the wallet it acts on, and a flow started on
 * one wallet stays on it (switching wallets never redirects a withdrawal or a trade).
 * Balances are read from chain every time. The linked wallet stays what it was: proof
 * of who you are, never controlled by NearKit.
 *
 * Withdrawals go to any valid address, with no limit on amounts. A wallet with an owner
 * wallet withdraws to it or to a destination it approved with its own signature in NearKit
 * web, so someone who got into the Telegram account (or the app) can't send the funds
 * anywhere else. A wallet with no owner wallet (linking one is optional) is controlled by
 * the Telegram account that created it: a new address is approved once in NearKit's Mini
 * App, and Telegram signs that approval, so NearKit's app alone can't add one. The signer
 * enforces both itself.
 */

const CALLBACK_TTL_MS = 30 * 60_000
/** How long a withdrawal waits for its destination's approval before it must be started again. */
const APPROVAL_TTL_MS = 30 * 60_000

interface Asset {
  asset: string
  symbol: string
  decimals: number
  /** The wallet this withdrawal started on: every later step acts on it, whatever is selected meanwhile. */
  walletId: string
}

/** The wallet Telegram trades from: the one the user selected, else their first (Main). */
export async function tradingWallet(deps: BotDeps, userId: number): Promise<TradingWallet | null> {
  if (!deps.custody) return null
  const wallets = await deps.custody.store.activeWallets(userId, deps.config.network.id)
  if (!wallets.length) return null
  const chosen = (await deps.store.getSettings(userId)).activeWallet
  return wallets.find((w) => w.id === chosen) ?? wallets[0] ?? null
}

/** The wallet a flow or button is bound to, if it is still this user's and active. */
export async function flowWallet(ctx: BotCtx, walletId: string | undefined): Promise<TradingWallet | null> {
  if (!walletId || !ctx.deps.custody) return null
  return ctx.deps.custody.store.ownedWallet(ctx.user.id, walletId)
}

/** How every screen names a wallet: its name and its short address. */
/** A wallet's name and shortened address. Plain text: Telegram copies <code> on tap, and a short form must never be what gets copied (📋 keys copy the full id). */
export const walletLine = (w: Pick<TradingWallet, 'slot' | 'label' | 'accountId'>) => `${bold(walletName(w))} ${esc(shortAccount(w.accountId))}`

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

/** A Create button with a fresh one-time key: pressing it twice makes one wallet. */
export const newWalletButton = (label = '✨ Create NEARKITS wallet') => btn(label, `cw:new:${randomToken(9)}`)

/**
 * Whether the signer checks approvals in this bot's Mini App. A wallet with no owner wallet
 * withdraws only to addresses approved there, so without it none is created.
 */
export async function telegramApprovalsOn(deps: BotDeps): Promise<boolean> {
  const h = await deps.custody?.signer.health().catch(() => null)
  return h !== null && h !== undefined && h.telegram === deps.me.id
}

async function offerCreate(ctx: BotCtx) {
  const linked = await linkedAccount(ctx)
  const near = linked ? await nearAvailable(ctx, linked) : null
  const open = linked !== null || (await telegramApprovalsOn(ctx.deps))
  await ctx.show(
    [
      bold('👛 Wallet'),
      '',
      `${bold('NEARKITS wallet')}: not created yet.`,
      'Trade right here in Telegram: no browser and no wallet pop-up for each trade. It’s a separate wallet: you move in only what you want to trade.',
      '',
      linked
        ? `🔗 Linked wallet ${code(linked)}${near !== null ? ` · ${esc(near)} NEAR` : ''}: it becomes the new wallet’s owner wallet.`
        : open
          ? 'No other wallet needed: this Telegram account controls it. Linking your own NEAR wallet is optional, now or later: it adds a backup key and key export.'
          : 'Link your own wallet first: it proves the NEARKITS wallet is yours and becomes its backup key.',
    ].join('\n'),
    keyboard([open ? newWalletButton() : btn('🔗 Link wallet', 'acct:link')], [...(linked ? [btn('🔗 Linked wallet', 'menu:linked')] : []), btn('« Menu', 'menu:home')]),
  )
}

/** The Wallet button: the selected NearKit wallet when trading wallets run here, else the linked wallet. */
export async function showWalletHome(ctx: BotCtx, details = false) {
  if (!ctx.deps.custody) return showWallet(ctx, { details })
  const w = await tradingWallet(ctx.deps, ctx.user.id)
  if (!w) return offerCreate(ctx)
  const count = (await ctx.deps.custody.store.activeWallets(ctx.user.id, ctx.deps.config.network.id)).length
  const view = await readWallet(ctx.deps.near, w)
  const held = await tokensOf(ctx, view)
  const linked = await linkedAccount(ctx)
  const mine = await ownerKeyNow(ctx.deps.store, w)
  const backup = mine !== null && view.keys?.includes(mine)
  const ownership = w.ownerAccount
    ? backup
      ? '🔐 Backup key: your own wallet can control this one ✓'
      : view.exists
        ? '🔐 Backup key: not added yet'
        : null
    : '🔐 No owner wallet: this Telegram account controls it'
  const wnear = view.tokens.some((t) => t.contract === ctx.deps.config.network.wrapContract && t.raw > 0n)
  const balance =
    view.exists === false
      ? [`Empty: send ${ctx.deps.config.network.id === 'testnet' ? 'testnet ' : ''}NEAR here to start (📥 Deposit).`]
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
      `👛 ${bold(walletName(w))} · ${esc(ctx.deps.config.network.label)}${count > 1 ? ` · ${w.slot} of ${count}` : ''}`,
      code(w.accountId),
      '',
      ...balance,
      '',
      ownership,
      linked ? `🔗 Linked wallet ${code(linked)}` : '🔗 No linked wallet (optional)',
      ...(details
        ? [
            '',
            w.ownerAccount ? `Owner ${code(w.ownerAccount)} (the wallet it was created with)` : null,
            `NEARKITS’ key ${code(w.publicKey)}`,
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
      [btn(`👛 My wallets (${count})`, 'cw:list'), btn('🔐 Recovery', 'cr:show')],
      [btn('🔄 Refresh', 'cw:home'), btn(details ? '🔎 Less' : '🔎 Details', details ? 'cw:home' : 'cw:details')],
      [btn('🔗 Linked wallet', 'menu:linked'), btn('⚙️ Settings', 'set:show'), btn('« Menu', 'menu:home')],
    ),
  )
}

/** Every NearKit wallet of the user: pick the one to trade from, create another, rename. */
async function showWallets(ctx: BotCtx, note?: string) {
  const custody = ctx.deps.custody
  if (!custody) return showWalletHome(ctx)
  const wallets = await custody.store.activeWallets(ctx.user.id, ctx.deps.config.network.id)
  if (!wallets.length) return offerCreate(ctx)
  const selected = await tradingWallet(ctx.deps, ctx.user.id)
  await ctx.show(
    [
      ...(note ? [note, ''] : []),
      `👛 ${bold('Your NEARKITS wallets')} · ${wallets.length} of ${MAX_ACTIVE_WALLETS_PER_USER}`,
      '',
      ...wallets.map((w) => `${w.id === selected?.id ? '✅' : '▫️'} ${w.slot}. ${walletLine(w)}`),
      '',
      'Each wallet has its own key and balance. Trades and withdrawals use the ✅ one; tap another to switch. 📋 copies its full address.',
    ].join('\n'),
    keyboard(
      // The switch key and the copy key of a wallet share its row; copying never switches (a copy key has no callback).
      ...wallets.map((w) => [btn(`${w.id === selected?.id ? '✅ ' : ''}${w.slot}. ${walletName(w)}`, `cw:sel:${w.id}`), copyBtn('📋 Copy', w.accountId)]),
      [...(wallets.length < MAX_ACTIVE_WALLETS_PER_USER ? [newWalletButton('➕ New wallet')] : []), ...(selected ? [btn('✏️ Rename', `cw:ren:${selected.id}`)] : [])],
      [btn('« Wallet', 'cw:home')],
    ),
  )
}

async function selectWallet(ctx: BotCtx, walletId: string) {
  const w = await flowWallet(ctx, walletId)
  if (!w) return ctx.answer('That wallet is closed or not yours.', true)
  await ctx.deps.store.updateSettings(ctx.user.id, { activeWallet: w.id })
  await ctx.answer(`${walletName(w)} selected`)
  return showWalletHome(ctx)
}

async function askRename(ctx: BotCtx, walletId: string) {
  const w = await flowWallet(ctx, walletId)
  if (!w) return ctx.answer('That wallet is closed or not yours.', true)
  await ctx.answer()
  await ctx.deps.store.setSession(ctx.chat.id, ctx.user.id, 'cw.rename', { walletId: w.id }, FLOW_TTL_MS)
  await ctx.reply(`✏️ New name for ${walletLine(w)}? Up to ${MAX_WALLET_LABEL} characters. Send “-” for the default name, or /cancel.`)
}

async function create(ctx: BotCtx, createKey: string) {
  const custody = ctx.deps.custody
  if (!custody) return ctx.answer('NEARKITS wallets aren’t available on this server.', true)
  const network = ctx.deps.config.network.id
  // The same owner rule as NearKit web (custody/wallets.ts).
  const owner = await ownerForNewWallet(custody, ctx.deps.store, {
    userId: ctx.user.id,
    network,
    linked: await linkedAccount(ctx),
    approvalsOn: () => telegramApprovalsOn(ctx.deps),
  })
  if (owner === undefined) {
    await ctx.answer()
    return void (await needAccount(ctx))
  }
  await ctx.answer()
  let result
  try {
    // Export, the backup key, revoking and withdrawal destinations answer to that owner alone.
    result = await createTradingWallet(custody, ctx.user.id, network, ctx.deps.now(), owner, createKey || null)
  } catch (e) {
    if (e instanceof WalletLimitError) return ctx.show(`⚠️ ${esc(e.message)}`, keyboard([btn('👛 My wallets', 'cw:list')], walletRow))
    throw e
  }
  const { wallet, created } = result
  // A new wallet is the one to trade from next: it's what the user just asked for.
  if (created) await ctx.deps.store.updateSettings(ctx.user.id, { activeWallet: wallet.id })
  await ctx.show(
    [
      created ? `✅ ${bold('NEARKITS wallet created')} · ${walletLine(wallet)}` : `👛 ${walletLine(wallet)}`,
      code(wallet.accountId),
      '',
      `It’s empty. Send ${ctx.deps.config.network.id === 'testnet' ? 'testnet ' : ''}NEAR to this address to start trading here. Tap the address, or 📋 Copy address, to copy it.`,
      wallet.ownerAccount
        ? 'Once it’s funded, add your owner wallet as its backup key (🔐 Recovery): then it’s yours even without NEARKITS.'
        : 'This Telegram account controls it: deposits, trades and withdrawals need nothing else. Linking your own NEAR wallet later is optional (🔐 Recovery).',
    ].join('\n'),
    keyboard([copyBtn('📋 Copy address', wallet.accountId)], [btn('📥 Deposit', 'cw:dep'), btn('👛 Wallet', 'cw:home')]),
  )
}

async function deposit(ctx: BotCtx) {
  const w = await tradingWallet(ctx.deps, ctx.user.id)
  if (!w) return showWalletHome(ctx)
  await ctx.show(
    [
      `📥 ${bold('Deposit')} · ${walletLine(w)}`,
      '',
      code(w.accountId),
      '',
      `Network: ${bold(networkName(ctx.deps))}`,
      ctx.deps.config.network.id === 'testnet' ? 'Send testnet NEAR or testnet tokens only.' : 'Send NEAR or NEAR tokens only.',
      'Tap the address, or 📋 Copy address, to copy it. The balance updates once the transfer is on chain.',
    ].join('\n'),
    keyboard([copyBtn('📋 Copy address', w.accountId)], [btn('🔄 Refresh balance', 'cw:home'), btn('« Wallet', 'cw:home')]),
  )
}

// ─── withdraw ───────────────────────────────────────────────────────────────

async function withdrawStart(ctx: BotCtx) {
  const w = await tradingWallet(ctx.deps, ctx.user.id)
  if (!w) return showWalletHome(ctx)
  const blocked = await ctx.deps.custody?.ops.blocked('withdraw', w)
  if (blocked) return ctx.show(`⏸ ${esc(blocked)}`, keyboard([btn('🔐 Recovery', `cr:show:${w.id}`)], walletRow))
  const view = await readWallet(ctx.deps.near, w)
  if (!view.exists) return ctx.show(`${walletLine(w)} is empty: nothing to withdraw yet.`, keyboard([btn('📥 Deposit', 'cw:dep')], walletRow))
  const held = await tokensOf(ctx, view)
  const put = (a: Asset) => ctx.deps.store.putCallback(a, ctx.user.id, ctx.chat.id, CALLBACK_TTL_MS)
  const nearMax = view.near !== null ? maxNearWithdraw(view.near) : 0n
  const nearId = nearMax > 0n ? await put({ asset: NATIVE_TOKEN_ID, symbol: 'NEAR', decimals: NEAR_DECIMALS, walletId: w.id }) : null
  const heldIds = await Promise.all(held.map((t) => put({ asset: t.contract, symbol: t.token.symbol, decimals: t.token.decimals, walletId: w.id })))
  const rows = [
    ...(nearId ? [[btn(`NEAR · ${nearText(view.near ?? 0n)}`, `cw:wa:${nearId}`)]] : []),
    ...held.map((t, i) => [btn(`${t.token.symbol} · ${amountText(t.raw, t.token.decimals)}`, `cw:wa:${heldIds[i]}`)]),
  ]
  if (!rows.length) return ctx.show('Nothing to withdraw: the wallet only holds what it needs for fees.', keyboard(walletRow))
  await ctx.show(`📤 ${bold('Withdraw')} from ${walletLine(w)} · what?`, keyboard(...rows, [btn('✖ Cancel', 'cw:home')]))
}

async function available(ctx: BotCtx, w: TradingWallet, a: Asset): Promise<bigint | null> {
  if (a.asset === NATIVE_TOKEN_ID) {
    const view = await readWallet(ctx.deps.near, w)
    return view.near === null ? null : maxNearWithdraw(view.near)
  }
  return ctx.deps.near.ctx.reader.balanceOf(a.asset, w.accountId).catch(() => null)
}

const closedWallet = (ctx: BotCtx) => ctx.show('That NEARKITS wallet is closed or not yours any more. Nothing was prepared.', keyboard(walletRow))

async function askWithdrawAmount(ctx: BotCtx, a: Asset) {
  const w = await flowWallet(ctx, a.walletId)
  if (!w) return closedWallet(ctx)
  const max = await available(ctx, w, a)
  if (max === null) return ctx.show(`⚠️ ${esc('The NEAR network isn’t answering right now. Try again in a moment.')}`, keyboard(walletRow))
  if (max === 0n) return ctx.show(`Nothing of ${esc(a.symbol)} to withdraw.`, keyboard(walletRow))
  const put = (amount: bigint, isMax = false) =>
    ctx.deps.store.putCallback({ ...a, amount: amount.toString(), ...(isMax && a.asset === NATIVE_TOKEN_ID ? { max: true } : {}) }, ctx.user.id, ctx.chat.id, CALLBACK_TTL_MS)
  // NEAR's MAX is worked out again once the destination is known: a named account costs less gas to send to.
  const [q1, q2, qMax] = await Promise.all([put(fractionOf(max, 25, 100)), put(fractionOf(max, 50, 100)), put(max, true)])
  await ctx.deps.store.setSession(ctx.chat.id, ctx.user.id, 'wd.amount', { ...a, max: max.toString() }, FLOW_TTL_MS)
  await ctx.show(
    [
      `📤 ${bold(`Withdraw ${a.symbol}`)} from ${walletLine(w)}`,
      `Available ${bold(`${amountText(max, a.decimals, 6)} ${a.symbol}`)}${a.asset === NATIVE_TOKEN_ID ? ' (a little stays for the network fee)' : ''}`,
      '',
      `How much? Tap or send an amount.`,
    ].join('\n'),
    keyboard([btn('25%', `cw:wm:${q1}`), btn('50%', `cw:wm:${q2}`), btn(`MAX · ${amountText(max, a.decimals, 4)}`, `cw:wm:${qMax}`)], [btn('✖ Cancel', 'cw:home')]),
  )
}

async function askDestination(ctx: BotCtx, a: Asset & { amount: string; max?: boolean }) {
  const w = await flowWallet(ctx, a.walletId)
  if (!w) return closedWallet(ctx)
  const linked = await linkedAccount(ctx)
  const linkedId = linked ? await ctx.deps.store.putCallback({ ...a, to: linked, linked: true }, ctx.user.id, ctx.chat.id, CALLBACK_TTL_MS) : null
  await ctx.deps.store.setSession(ctx.chat.id, ctx.user.id, 'wd.to', a, FLOW_TTL_MS)
  await ctx.show(
    [
      `📤 ${bold(`Withdraw ${amountText(BigInt(a.amount), a.decimals, 6)} ${a.symbol}`)} from ${walletLine(w)} · where to?`,
      '',
      linked
        ? `Your linked wallet is ready below, or send any NEAR ${esc(ctx.deps.config.network.id)} address.`
        : `Send the NEAR ${esc(ctx.deps.config.network.id)} address to withdraw to.`,
    ].join('\n'),
    keyboard([...(linked && linkedId ? [btn(`🔗 ${shortAccount(linked, 28)} (linked)`, `cw:wt:${linkedId}`)] : [])], [btn('✖ Cancel', 'cw:home')]),
  )
}

export function withdrawReviewText(deps: BotDeps, input: WithdrawInput, review: WithdrawReview, wallet: Pick<TradingWallet, 'slot' | 'label' | 'accountId'> | null): string {
  const native = input.asset === NATIVE_TOKEN_ID
  return [
    `📤 ${bold('Review withdrawal')}`,
    '',
    ...(wallet ? [`From ${walletLine(wallet)}`] : []),
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

/** The wallet's owner, and destinations the owner approved (read from the signer, which enforces them). */
async function approvedDestination(ctx: BotCtx, w: TradingWallet, to: string): Promise<boolean> {
  if (w.ownerAccount && to === w.ownerAccount) return true
  const custody = ctx.deps.custody
  if (!custody) return false
  return (await custody.signer.destinations(w.accountId)).destinations.some((d) => d.destination === to)
}

/**
 * A destination not approved yet. With an owner wallet: approve it in NearKit web (the owner
 * signs). With none: approve it in NearKit's Mini App (Telegram signs). Then continue here.
 */
async function askApproval(ctx: BotCtx, w: TradingWallet, flow: WithdrawInput & { walletId: string }, again: boolean) {
  await ctx.deps.store.setSession(ctx.chat.id, ctx.user.id, 'wd.approve', flow, APPROVAL_TTL_MS)
  const custody = ctx.deps.custody
  if (!w.ownerAccount && custody) {
    let r
    try {
      r = await custody.telegram.request(w, { kind: 'destination', accountId: w.accountId, destination: flow.to })
    } catch (e) {
      // It has an owner wallet after all (bound meanwhile): its owner approves.
      const now = await flowWallet(ctx, w.id)
      if (now?.ownerAccount) return askApproval(ctx, now, flow, again)
      return ctx.show(`⚠️ ${errorText(ctx, e)}`, keyboard(walletRow))
    }
    await ctx.show(
      [
        `🔐 ${bold('Approve a new address')} · ${walletLine(w)}`,
        '',
        again ? `${code(flow.to)} is not approved yet.` : `${code(flow.to)} hasn’t received withdrawals from this wallet before.`,
        'Approve it once in NEARKITS’ mini app, right here in Telegram. It shows the address and this wallet, and Telegram signs your approval: NEARKITS’ servers can’t add an address without it.',
        '',
        '1. Tap Approve in Telegram and check the address.',
        '2. Come back and tap Continue.',
        '⏱ The approval is open for 10 minutes.',
      ].join('\n'),
      keyboard([urlBtn('✅ Approve in Telegram', custody.telegram.link(r))], [btn('▶️ Continue', 'cw:wcont'), btn('✖ Cancel', 'cw:home')]),
    )
    return
  }
  const url = `${ctx.deps.config.webUrl}/recover#approve=${w.accountId}&to=${encodeURIComponent(flow.to)}`
  await ctx.show(
    [
      `🔐 ${bold('Approve a new destination')} · ${walletLine(w)}`,
      '',
      again ? `${code(flow.to)} is not approved yet.` : `${code(flow.to)} hasn’t received withdrawals from this wallet before.`,
      `Withdrawals go to your owner wallet ${code(w.ownerAccount ?? '')} or to destinations it approved, so nobody who gets into this Telegram account can send your funds elsewhere.`,
      '',
      `1. Open NEARKITS web and connect ${code(w.ownerAccount ?? '')}.`,
      '2. Sign the approval it shows: free, once for this destination.',
      '3. Come back and tap Continue.',
    ].join('\n'),
    keyboard([urlBtn('🌐 Approve in NEARKITS web', url)], [btn('▶️ Continue', 'cw:wcont'), btn('✖ Cancel', 'cw:home')]),
  )
}

async function reviewAndConfirm(ctx: BotCtx, flow: WithdrawInput & { walletId: string; max?: boolean }, again = false) {
  const custody = ctx.deps.custody
  const w = await flowWallet(ctx, flow.walletId)
  if (!custody || !w) return closedWallet(ctx)
  // MAX of NEAR, for this destination: everything spendable now (final) less exactly the gas its transfer holds.
  let amount = flow.amount
  if (flow.max === true && flow.asset === NATIVE_TOKEN_ID) {
    const spendable = await accountState(ctx.deps.near.ctx.rpc, w.accountId, 'final')
      .then((s) => s.availableYocto)
      .catch(() => null)
    if (spendable === null) return ctx.show(`⚠️ ${esc('The NEAR network isn’t answering right now. Try again in a moment.')}`, keyboard(walletRow))
    const most = maxNearWithdraw(spendable, flow.to)
    if (most <= 0n) return ctx.show('Nothing of NEAR to withdraw.', keyboard(walletRow))
    amount = most.toString()
  }
  const input: WithdrawInput = { asset: flow.asset, symbol: flow.symbol, decimals: flow.decimals, amount, to: flow.to, linked: flow.linked }
  let review: WithdrawReview
  try {
    review = await reviewWithdraw(ctx.deps.near, ctx.deps.config.network, w, input)
  } catch (e) {
    await ctx.deps.store.setSession(
      ctx.chat.id,
      ctx.user.id,
      'wd.to',
      { asset: input.asset, symbol: input.symbol, decimals: input.decimals, amount: flow.amount, walletId: w.id, ...(flow.max === true ? { max: true } : {}) },
      FLOW_TTL_MS,
    )
    await ctx.reply(`⚠️ ${errorText(ctx, e)}\n\nSend another address, or /cancel.`, keyboard([btn('✖ Cancel', 'cw:home')]))
    return
  }
  // A real, reachable address: now, is it the owner, or a destination the owner approved?
  if (!(await approvedDestination(ctx, w, flow.to))) return askApproval(ctx, w, flow, again)
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
  await ctx.reply(withdrawReviewText(ctx.deps, input, review, w), intentKeyboard(intent, '✅ Confirm withdraw'))
}

registerIntentScreens('withdraw', {
  review: async (deps, intent) => ({
    text: withdrawReviewText(
      deps,
      intent.params as unknown as WithdrawInput,
      intent.quote as unknown as WithdrawReview,
      (await deps.custody?.store.wallet(intent.walletId)) ?? null,
    ),
    confirm: '✅ Confirm withdraw',
  }),
  result: async (deps, intent: Intent) => {
    const input = intent.params as unknown as WithdrawInput
    const w = (await deps.custody?.store.wallet(intent.walletId)) ?? null
    const r = intent.result
    const links = r?.hashes.length ? txLinks(deps, r.hashes) : null
    const text = r?.ok
      ? [
          `✅ ${bold('Withdrawal confirmed')}`,
          ...(w ? [`From ${walletLine(w)}`] : []),
          `Sent ${bold(`${amountText(BigInt(input.amount), input.decimals, 8)} ${input.symbol}`)}`,
          `To ${code(input.to)}`,
          ...(links ? [`Tx ${links}`] : []),
        ].join('\n')
      : [`❌ ${bold('Withdrawal failed')}`, ...(w ? [`From ${walletLine(w)}`] : []), esc(r?.message ?? 'Nothing was sent.'), ...(links ? [`Tx ${links}`] : [])].join('\n')
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
        await askDestination(ctx, { asset: a.asset, symbol: a.symbol, decimals: a.decimals, walletId: a.walletId, amount: parsed.value.toString() })
      },
      'wd.to': async (ctx, text, data) => {
        const a = data as unknown as Asset & { amount: string }
        const w = await flowWallet(ctx, a.walletId)
        if (!w) return closedWallet(ctx)
        let to: string
        try {
          to = checkDestinationSyntax(plainText(text, 80), ctx.deps.config.network, w, a.asset)
        } catch (e) {
          await ctx.reply(`⚠️ ${errorText(ctx, e)}\n\nSend another address, or /cancel.`)
          return
        }
        await reviewAndConfirm(ctx, { ...a, to, linked: to === (await linkedAccount(ctx)) })
      },
      // Waiting for an approval, the user may type another address instead.
      'wd.approve': async (ctx, text, data) => {
        const flow = data as unknown as WithdrawInput & { walletId: string }
        const w = await flowWallet(ctx, flow.walletId)
        if (!w) return closedWallet(ctx)
        let to: string
        try {
          to = checkDestinationSyntax(plainText(text, 80), ctx.deps.config.network, w, flow.asset)
        } catch (e) {
          await ctx.reply(`⚠️ ${errorText(ctx, e)}\n\nSend another address, or /cancel.`)
          return
        }
        await reviewAndConfirm(ctx, { ...flow, to, linked: to === (await linkedAccount(ctx)) })
      },
      'cw.rename': async (ctx, text, data) => {
        const w = await flowWallet(ctx, String((data as { walletId?: string }).walletId ?? ''))
        await ctx.deps.store.clearSession(ctx.chat.id, ctx.user.id)
        if (!w || !ctx.deps.custody) return closedWallet(ctx)
        const typed = plainText(text, 200)
        const label = typed === '-' ? null : typed
        if (label !== null && (!label || [...label].length > MAX_WALLET_LABEL)) {
          await ctx.deps.store.setSession(ctx.chat.id, ctx.user.id, 'cw.rename', { walletId: w.id }, FLOW_TTL_MS)
          await ctx.reply(`⚠️ A name is 1 to ${MAX_WALLET_LABEL} characters. Send another, “-” for the default, or /cancel.`)
          return
        }
        await ctx.deps.custody.store.setLabel(w.id, label)
        await showWallets(ctx, `✏️ Renamed to ${bold(walletName({ ...w, label }))}.`)
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
          case 'list':
            await ctx.answer()
            return showWallets(ctx)
          case 'sel':
            return selectWallet(ctx, arg)
          case 'ren':
            return askRename(ctx, arg)
          case 'new':
            return create(ctx, arg)
          case 'create': {
            // A Create button sent before a user could have several wallets carries no key:
            // it only ever made the first wallet. It still does, never a second one; its key
            // is the user's count of wallets so far, so a double tap (or two instances) makes one.
            if (!ctx.deps.custody) return create(ctx, '')
            if (await tradingWallet(ctx.deps, ctx.user.id)) {
              await ctx.answer()
              return showWalletHome(ctx)
            }
            return create(ctx, `first-${await ctx.deps.custody.store.countWalletsSince(ctx.user.id, 0)}`)
          }
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
          case 'wcont': {
            await ctx.answer()
            const s = await ctx.deps.store.getSession<WithdrawInput & { walletId: string }>(ctx.chat.id, ctx.user.id)
            if (s?.flow !== 'wd.approve') return ctx.show('That withdrawal isn’t waiting any more. Start it again.', keyboard([btn('📤 Withdraw', 'cw:wd')], walletRow))
            return reviewAndConfirm(ctx, s.data, true)
          }
          case 'wt': {
            const a = await payload<WithdrawInput & { walletId: string }>(ctx, arg)
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
