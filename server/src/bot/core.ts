import { btn, documented, keyboard, type BotCtx, type BotModule, type Command } from './context'
import { help, welcome } from './texts'

/**
 * /start, /help, /cancel and the main menu. `commandList` is resolved lazily so
 * /help lists exactly the commands the running bot has, nothing more.
 */

export function mainMenu(ctx: BotCtx) {
  const has = (name: string) => ctx.deps.features.has(name)
  return keyboard(
    [btn('🔗 Link wallet', 'acct:link'), btn('👛 Accounts', 'acct:list')],
    [has('buy') ? btn('🟢 Buy', 'trade:buy') : null, has('sell') ? btn('🔴 Sell', 'trade:sell') : null],
    [has('positions') ? btn('📊 Positions', 'pf:positions') : null, has('pnl') ? btn('📈 PnL', 'pf:pnl') : null],
    [btn('⚙️ Settings', 'set:show'), btn('❓ Help', 'menu:help')],
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
      await ctx.reply(`Hi! I’m the NearKit bot. Group admins can set up buy alerts with /buybot. For trading and your account, open a private chat with me.`, {
        inline_keyboard: [[{ text: 'Open a private chat', url: `https://t.me/${ctx.deps.me.username}` }]],
      })
      return
    }
    const deep = payload && startPayloads[payload]
    if (deep) return deep(ctx)
    await ctx.reply(welcome(ctx.deps.config, ctx.user.first_name || 'there'), mainMenu(ctx))
  }

  return {
    commands: {
      start: { scope: 'any', run: (ctx, args) => start(ctx, args.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)) },
      help: { ...documented('help'), run: async (ctx) => void (await ctx.reply(helpText(ctx))) },
      cancel: {
        ...documented('cancel'),
        run: async (ctx) => {
          // The router already cleared any waiting step before running a command.
          await ctx.reply('Cancelled. Nothing is waiting any more.', ctx.isPrivate ? mainMenu(ctx) : undefined)
        },
      },
      menu: { scope: 'private', run: async (ctx) => void (await ctx.reply('What would you like to do?', mainMenu(ctx))) },
    },
    callbacks: {
      menu: async (ctx, action) => {
        if (action === 'help') {
          await ctx.answer()
          await ctx.reply(helpText(ctx))
          return
        }
        await ctx.show('What would you like to do?', mainMenu(ctx))
      },
    },
  }
}
