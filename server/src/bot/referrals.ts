import { formatUnits } from '@/lib/amounts'
import type { TokenTotals } from '../referrals/service'
import { bold, code, esc } from '../telegram/html'
import { btn, copyBtn, documented, keyboard, type BotCtx, type BotModule } from './context'
import { linkedAccount } from './wallet'

/**
 * Referrals in Telegram: the user's invite link (copy it in one tap), who and what it
 * brought, what it earned per token, and a Claim that asks NearKit to pay out what is
 * available to the user's linked wallet. The owner pays each claim from NearKit's own
 * account after a review (referrals/admin.ts); nothing here moves money.
 */

const CALLBACK_TTL_MS = 30 * 60_000
/**
 * Payouts go to a wallet linked at least this long ago: someone who gets into the Telegram
 * account can't link their own wallet and claim the earnings to it at once.
 */
export const PAYOUT_LINK_AGE_MS = 48 * 3_600_000

async function tokenLabel(ctx: BotCtx, token: string): Promise<{ symbol: string; decimals: number | null }> {
  if (token === ctx.deps.config.network.wrapContract) return { symbol: 'wNEAR', decimals: 24 }
  try {
    const m = await ctx.deps.near.ctx.reader.metadata(token)
    return { symbol: m.symbol, decimals: m.decimals }
  } catch {
    return { symbol: token.length > 20 ? `${token.slice(0, 10)}…` : token, decimals: null }
  }
}

async function amounts(ctx: BotCtx, rows: TokenTotals[], pick: (t: TokenTotals) => bigint): Promise<string> {
  const parts: string[] = []
  for (const t of rows) {
    const v = pick(t)
    if (v === 0n) continue
    const l = await tokenLabel(ctx, t.token)
    parts.push(l.decimals === null ? `${v} raw ${esc(l.symbol)}` : `${esc(formatUnits(v, l.decimals, { maxFraction: 6, group: true }))} ${esc(l.symbol)}`)
  }
  return parts.length ? parts.join(' · ') : '0'
}

export async function showReferrals(ctx: BotCtx) {
  const r = ctx.deps.referrals
  if (!r) return ctx.show('Invites aren’t available on this server.', keyboard([btn('« Menu', 'menu:home')]))
  const s = await r.summary(ctx.user.id, ctx.deps.me.username)
  const available = s.tokens.some((t) => t.available > 0n)
  await ctx.show(
    [
      `🎁 ${bold('Invite friends')}`,
      '',
      `Your invite link: ${code(s.url)}`,
      'When someone new starts NEARKITS with it, you earn 20% of NEARKITS’ fee on their trades: 0.08% of what they trade. They pay the same 0.50% as everyone.',
      '',
      `👥 Invited ${bold(String(s.referred))}`,
      `📈 Their volume ${await amounts(ctx, s.tokens, (t) => t.volume)}`,
      `💰 Earned ${await amounts(ctx, s.tokens, (t) => t.earned)}`,
      `⏳ Payout requested ${await amounts(ctx, s.tokens, (t) => t.pending)}`,
      `✅ Paid out ${await amounts(ctx, s.tokens, (t) => t.claimed)}`,
      `🟢 Available ${await amounts(ctx, s.tokens, (t) => t.available)}`,
      ...(ctx.deps.config.network.id === 'testnet' ? ['', 'Testnet charges no fee, so invites earn only on mainnet.'] : []),
    ].join('\n'),
    keyboard([copyBtn('📋 Copy invite link', s.url), ...(available ? [btn('💸 Claim', 'ref:claim')] : [])], [btn('« Menu', 'menu:home')]),
  )
}

async function chooseClaim(ctx: BotCtx) {
  const r = ctx.deps.referrals
  if (!r) return showReferrals(ctx)
  const s = await r.summary(ctx.user.id, ctx.deps.me.username)
  const open = s.tokens.filter((t) => t.available > 0n)
  if (!open.length) return ctx.show('Nothing to claim yet.', keyboard([btn('🎁 Invites', 'ref:show')]))
  const to = await linkedAccount(ctx)
  if (!to) return ctx.show('Link a wallet first: payouts go to your linked wallet.', keyboard([btn('🔗 Link wallet', 'acct:link')], [btn('🎁 Invites', 'ref:show')]))
  const link = await ctx.deps.store.linkOf(ctx.deps.config.network.id, to)
  if (!link || ctx.deps.now() - link.linkedAt < PAYOUT_LINK_AGE_MS) {
    const hours = link ? Math.ceil((PAYOUT_LINK_AGE_MS - (ctx.deps.now() - link.linkedAt)) / 3_600_000) : 48
    return ctx.show(
      `Payouts go to a wallet linked at least 48 hours ago, to protect your earnings. ${code(to)} can receive them in about ${hours} hours.`,
      keyboard([btn('🎁 Invites', 'ref:show')]),
    )
  }
  const rows = []
  for (const t of open) {
    const id = await ctx.deps.store.putCallback({ token: t.token, to }, ctx.user.id, ctx.chat.id, CALLBACK_TTL_MS)
    rows.push([btn(`💸 ${(await amounts(ctx, [t], (x) => x.available)).replace(/<[^>]+>/g, '')}`, `ref:ct:${id}`)])
  }
  await ctx.show(`💸 ${bold('Claim')}: which earnings?`, keyboard(...rows, [btn('✖ Cancel', 'ref:show')]))
}

async function confirmClaim(ctx: BotCtx, id: string) {
  const p = await ctx.deps.store.getCallback<{ token: string; to: string }>(id, ctx.user.id)
  if (!p) return ctx.show('That button expired.', keyboard([btn('🎁 Invites', 'ref:show')]))
  const r = ctx.deps.referrals
  if (!r) return showReferrals(ctx)
  const s = await r.summary(ctx.user.id, ctx.deps.me.username)
  const t = s.tokens.find((x) => x.token === p.token)
  if (!t || t.available === 0n) return ctx.show('Nothing to claim in that token any more.', keyboard([btn('🎁 Invites', 'ref:show')]))
  const yes = await ctx.deps.store.putCallback(p, ctx.user.id, ctx.chat.id, CALLBACK_TTL_MS)
  await ctx.show(
    [
      `💸 ${bold('Claim')} ${await amounts(ctx, [t], (x) => x.available)}`,
      `To your linked wallet ${code(p.to)}`,
      '',
      'NEARKITS reviews each claim and pays it from its own account, usually within a few days. You get a message here when it’s paid.',
    ].join('\n'),
    keyboard([btn('✅ Request payout', `ref:cy:${yes}`), btn('✖ Cancel', 'ref:show')]),
  )
}

async function requestClaim(ctx: BotCtx, id: string) {
  const p = await ctx.deps.store.getCallback<{ token: string; to: string }>(id, ctx.user.id)
  const r = ctx.deps.referrals
  if (!p || !r) return ctx.show('That button expired.', keyboard([btn('🎁 Invites', 'ref:show')]))
  // Still the user's linked wallet right now.
  if ((await linkedAccount(ctx)) !== p.to) return ctx.show('Your linked wallet changed. Start the claim again.', keyboard([btn('🎁 Invites', 'ref:show')]))
  const c = await r.requestClaim(ctx.user.id, p.token, p.to)
  if (c.kind === 'empty') return ctx.show('Nothing to claim in that token any more.', keyboard([btn('🎁 Invites', 'ref:show')]))
  const text =
    c.kind === 'open'
      ? `⏳ A payout of these earnings is already requested (to ${code(c.claim.destination)}). You’ll get a message when it’s paid.`
      : `✅ ${bold('Payout requested')} to ${code(c.claim.destination)}. You’ll get a message here when it’s paid.`
  await ctx.show(text, keyboard([btn('🎁 Invites', 'ref:show'), btn('« Menu', 'menu:home')]))
}

/** `/start ref_<CODE>`: a new user who came with an invite is attributed to its owner, once. */
export async function referralStart(ctx: BotCtx, codeText: string): Promise<void> {
  const r = ctx.deps.referrals
  if (!r) return
  const { result, referrerUserId } = await r.attribute(ctx.user.id, codeText.toUpperCase())
  if (result === 'self') {
    await ctx.reply('🎁 That’s your own invite link: share it with friends. /referral shows how it’s doing.')
    return
  }
  if (result !== 'attributed' || referrerUserId === null) return
  await ctx.reply('🎁 Welcome! You joined NEARKITS with an invite.')
  // The referrer hears that it worked, not who joined.
  await ctx.deps.tg.sendMessage(referrerUserId, '🎁 Someone new joined NEARKITS with your invite link. /referral shows your invites.').catch(() => undefined)
}

export function referralsModule(): BotModule {
  return {
    commands: {
      referral: { ...documented('referral'), run: (ctx) => showReferrals(ctx) },
    },
    callbacks: {
      ref: async (ctx, action, arg) => {
        await ctx.answer()
        switch (action) {
          case 'claim':
            return chooseClaim(ctx)
          case 'ct':
            return confirmClaim(ctx, arg)
          case 'cy':
            return requestClaim(ctx, arg)
          default:
            return showReferrals(ctx)
        }
      },
    },
  }
}
