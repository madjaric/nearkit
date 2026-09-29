import { bold } from '../telegram/html'
import { btn, documented, keyboard, urlBtn, type BotCtx, type BotModule, type Command } from './context'
import { help, SAFETY, welcome } from './texts'
import { tradingWallet, showWalletHome } from './tradingWallet'
import { linkedAccount, nearAvailable, showWallet } from './wallet'

/**
 * /start, /help, /cancel and the main menu. `commandList` is resolved lazily so
 * /help lists exactly the commands the running bot has, nothing more.
 */

export function mainMenu(ctx: BotCtx) {
  const has = (name: string) => ctx.deps.features.has(name)
  const linked = linkedAccount(ctx) !== null || tradingWallet(ctx.deps, ctx.user.id) !== null
  return keyboard(
    linked ? [] : [btn('🔗 Link wallet', 'acct:link')],
    [has('buy') ? btn('🟢 Buy', 'tr:buy') : null, has('sell') ? btn('🔴 Sell', 'tr:sell') : null],
    [has('positions') ? btn('📊 Positions', 'pf:positions') : null, has('pnl') ? btn('📈 PnL', 'pf:pnl') : null],
    [has('balance') ? btn('👛 Wallet', 'menu:wallet') : null, btn('⚙️ Settings', 'set:show')],
    [has('buybot') ? btn('📣 Buybot', 'menu:buybot') : null, btn('❓ Help', 'menu:help')],
  )
}

/** The first screen: who is trading, with how much NEAR, and every action one tap away. */
async function home(ctx: BotCtx, edit: boolean) {
  const nearkit = tradingWallet(ctx.deps, ctx.user.id)?.accountId ?? null
  const account = nearkit ?? linkedAccount(ctx)
  const text = [welcome(ctx.deps.config, account ? { accountId: account, near: await nearAvailable(ctx, account), nearkit: nearkit !== null } : null), SAFETY].join('\n')
  if (edit) await ctx.show(text, mainMenu(ctx))
  else await ctx.reply(text, mainMenu(ctx))
}

async function buybotInfo(ctx: BotCtx) {
  await ctx.show(
    [bold('📣 Buy alerts for your group'), '', 'Add me to your token’s group. Then a group admin sends /buybot there to choose the token, the minimum buy and the style.'].join(
      '\n',
    ),
    keyboard([urlBtn('➕ Add NearKit to a group', `https://t.me/${ctx.deps.me.username}?startgroup=buybot`)], [btn('« Menu', 'menu:home')]),
  )
}

export function coreModule(commandList: () => { name: string; command: Command }[], startPayloads: Record<string, (ctx: BotCtx) => Promise<void>>): BotModule {
  const helpText = (ctx: BotCtx) =>
    help(
      ctx.deps.config,
      commandList()
        .filter((c) => c.command.description && c.command.section)
        .map((c) => ({ name: c.name, description: c.command.description as string, usage: c.command.usage, section: c.command.section as string })),
    )

  const start = async (ctx: BotCtx, payload: string) => {
    if (!ctx.isPrivate) {
      await ctx.reply(`Hi! I’m the NearKit bot. A group admin can set up buy alerts with /buybot. For trading, open a private chat with me.`, {
        inline_keyboard: [[{ text: 'Open a private chat', url: `https://t.me/${ctx.deps.me.username}` }]],
      })
      return
    }
    const deep = payload && startPayloads[payload]
    if (deep) return deep(ctx)
    await home(ctx, false)
  }

  return {
    commands: {
      start: { scope: 'any', run: (ctx, args) => start(ctx, args.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)) },
      help: { ...documented('help'), run: async (ctx) => void (await ctx.reply(helpText(ctx), keyboard([btn('« Menu', 'menu:home')]))) },
      cancel: {
        ...documented('cancel'),
        run: async (ctx) => {
          // The router already cleared any waiting step before running a command.
          await ctx.reply('Cancelled. Nothing is waiting any more.', ctx.isPrivate ? mainMenu(ctx) : undefined)
        },
      },
      menu: { scope: 'private', run: (ctx) => home(ctx, false) },
    },
    callbacks: {
      menu: async (ctx, action) => {
        await ctx.answer()
        switch (action) {
          case 'help':
            return ctx.show(helpText(ctx), keyboard([btn('« Menu', 'menu:home')]))
          case 'wallet':
            return showWalletHome(ctx)
          case 'walletdetails':
            return showWalletHome(ctx, true)
          case 'linked':
            return showWallet(ctx)
          case 'buybot':
            return buybotInfo(ctx)
          default:
            return home(ctx, true)
        }
      },
    },
  }
}
