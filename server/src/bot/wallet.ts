import { NEAR_DECIMALS } from '@/config/networks'
import type { TokenListing } from '@/types/domain'
import { bold, code, esc } from '../telegram/html'
import { btn, keyboard, type BotCtx } from './context'
import { amountText, friendlyError, nearText } from './ui'

/**
 * The account a Telegram user trades with (their default linked account), and the
 * Wallet screen: what that account holds, read from chain.
 */

export function linkedAccount(ctx: BotCtx): string | null {
  const { store, config } = ctx.deps
  const links = store.linksOf(ctx.user.id, config.network.id)
  const def = store.getSettings(ctx.user.id).defaultAccount
  return links.find((l) => l.accountId === def)?.accountId ?? links[0]?.accountId ?? null
}

export async function needAccount(ctx: BotCtx): Promise<string | null> {
  const account = linkedAccount(ctx)
  if (!account) {
    await ctx.reply('Link a NEAR account first: you sign a free message in your wallet, no keys involved.', keyboard([btn('🔗 Link wallet', 'acct:link')]))
    return null
  }
  return account
}

/** NEAR available to spend, as text, or null when it can't be read right now. */
export async function nearAvailable(ctx: BotCtx, account: string): Promise<string | null> {
  const b = await ctx.deps.near.ctx.balances.get(account).catch(() => null)
  return b?.state ? nearText(b.state.availableYocto) : null
}

/** /balance and the menu's Wallet: NEAR and every token held, newest reading from chain. */
export async function showWallet(ctx: BotCtx, options: { details?: boolean } = {}) {
  const account = await needAccount(ctx)
  if (!account) return
  const { near, config } = ctx.deps
  // A fresh read every time the user asks.
  near.ctx.balances.invalidate(account)
  let b
  try {
    b = await near.ctx.balances.get(account)
  } catch (e) {
    await ctx.reply(`⚠️ ${esc(friendlyError(e, { network: config.network.id, log: ctx.deps.log, context: 'wallet read failed' }))}`)
    return
  }
  const tokens = (await near.market.listTokens(b.fts.map((f) => f.contract))).filter((t) => t.contract)
  const held = b.fts
    .map((f) => ({ f, t: tokens.find((t) => t.id === f.contract) }))
    .filter((x): x is { f: (typeof b.fts)[number]; t: TokenListing } => x.t !== undefined && x.f.raw > 0n)
    .map(({ f, t }) => ({ f, t, usd: t.market ? (Number(f.raw) / 10 ** t.decimals) * t.market.priceUsd : null }))
    // Most valuable first where prices are known; the rest by symbol.
    .sort((a, b2) => (b2.usd ?? -1) - (a.usd ?? -1) || a.t.symbol.localeCompare(b2.t.symbol))
  const lines = held.map(({ f, t }) =>
    options.details
      ? `${esc(amountText(f.raw, t.decimals))} ${bold(t.symbol)} · ${code(t.id)}${f.verified ? '' : ' · indexer only'}`
      : `${esc(amountText(f.raw, t.decimals))} ${bold(t.symbol)}`,
  )
  await ctx.show(
    [
      bold('Wallet'),
      code(account),
      '',
      `${bold(nearText(b.state?.availableYocto ?? 0n))} NEAR`,
      ...(lines.length ? lines : ['No tokens yet.']),
      ...(options.details
        ? [
            '',
            `NEAR total ${esc(amountText(b.state?.totalYocto ?? 0n, NEAR_DECIMALS))} · storage ${esc(amountText(b.state?.storageYocto ?? 0n, NEAR_DECIMALS))}`,
            'Balances read from chain; “indexer only” lines were reported by the indexer and not confirmed on chain.',
          ]
        : []),
    ].join('\n'),
    keyboard(
      [btn('🟢 Buy', 'tr:buy'), btn('🔴 Sell', 'tr:sell')],
      [btn('🔄 Refresh', 'menu:wallet'), btn(options.details ? '🔎 Less' : '🔎 Details', options.details ? 'menu:wallet' : 'menu:walletdetails')],
      [btn('👛 Accounts', 'acct:list'), btn('« Menu', 'menu:home')],
    ),
  )
}
