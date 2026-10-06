import { WEB_LOGIN_TTL_MS, WebLoginLimitError } from '../web/sessions'
import { bold, esc } from '../telegram/html'
import { btn, documented, keyboard, urlBtn, type BotCtx, type BotModule } from './context'

/**
 * NearKit web from Telegram: /web sends a one-time sign-in link for the website's Wallets page.
 * The website is a client of its own: it trades, runs Multi Buy and Multi Sell and sends from
 * the user's NearKit wallets itself, with nothing to confirm here. "Sign out everywhere" ends
 * every web session.
 */

/** /web, and `/start web` (NearKit web's "Sign in with Telegram" button). */
export async function startWeb(ctx: BotCtx): Promise<void> {
  // A sign-in link is a session for whoever opens it: it is never shown where others can read it.
  if (!ctx.isPrivate) return
  const web = ctx.deps.web
  if (!web || !ctx.deps.custody) return void (await ctx.reply('NEARKITS wallets aren’t available on this server.'))
  let code: string
  try {
    code = await web.issueCode(ctx.user.id)
  } catch (e) {
    if (e instanceof WebLoginLimitError) return void (await ctx.reply(`⚠️ ${esc(e.message)}`))
    throw e
  }
  // The code rides in the fragment: it never reaches a server log or a link preview.
  const url = `${ctx.deps.config.webUrl}/wallets#login=${code}`
  const minutes = Math.round(WEB_LOGIN_TTL_MS / 60_000)
  await ctx.reply(
    [
      `🌐 ${bold('NEARKITS web')}`,
      'Your NEARKITS wallets on the website: create more, buy, sell, Multi Buy and send, right there. Nothing needs confirming here.',
      '',
      `This is a one-time sign-in link, valid for ${minutes} minutes. Don’t share it: it signs you in, and a signed-in browser can trade your NEARKITS wallets.`,
    ].join('\n'),
    keyboard([urlBtn('🌐 Open NEARKITS web', url)], [btn('🚪 Sign out of NEARKITS web everywhere', 'web:out')]),
  )
}

async function signOutEverywhere(ctx: BotCtx): Promise<void> {
  const web = ctx.deps.web
  if (!web) return ctx.answer()
  const n = await web.revokeAll(ctx.user.id)
  // A bot started from a session (perhaps a stolen one) trades on with no session at all: signing
  // out everywhere pauses the running ones too, until their owner resumes them here.
  const bots = ctx.deps.volumeBots
  let paused = 0
  if (bots)
    for (const b of await bots.ofUser(ctx.user.id, ctx.deps.config.network.id)) {
      if (b.status !== 'running' || !(await bots.pause(b.id, 'owner', 'Paused when you signed out of NEARKITS web everywhere'))) continue
      await bots.event(b.id, 'paused', 'Paused when you signed out of NEARKITS web everywhere', 'owner')
      paused++
    }
  await ctx.answer()
  await ctx.reply(
    [
      `🚪 ${bold('Signed out of NEARKITS web')} on every browser${n ? ` (${n} ${n === 1 ? 'session' : 'sessions'})` : ''}.`,
      ...(paused ? ['', `${paused === 1 ? 'Your running Volume Bot is' : `Your ${paused} running Volume Bots are`} paused too. Check them with /volume before you resume.`] : []),
    ].join('\n'),
  )
}

export function webModule(): BotModule {
  return {
    commands: {
      web: { ...documented('web'), run: (ctx) => startWeb(ctx) },
    },
    callbacks: {
      web: async (ctx, action) => {
        if (action === 'out') return signOutEverywhere(ctx)
        await ctx.answer()
        if (action === 'open') return startWeb(ctx)
      },
    },
  }
}
