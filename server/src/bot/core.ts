import { bold } from '../telegram/html'
import { btn, documented, keyboard, urlBtn, type BotCtx, type BotModule, type Command } from './context'
import { help, noWalletYet, SAFETY, welcome } from './texts'
import { newWalletButton, showWalletHome, telegramApprovalsOn, tradingWallet } from './tradingWallet'
import { linkedAccount, nearAvailable, showWallet } from './wallet'
import { referralStart } from './referrals'

/**
 * /start, /help, /cancel and the main menu. `commandList` is resolved lazily so
 * /help lists exactly the commands the running bot has, nothing more.
 */

/**
 * Whether someone with no NearKit wallet can create one right now: this server runs NearKit
 * wallets, and either they have a linked wallet (it becomes the owner) or the signer checks
 * the Mini App approvals a wallet with no owner wallet needs (the same rule as creating one).
 */
async function canCreateWallet(ctx: BotCtx, linked: boolean): Promise<boolean> {
  return ctx.deps.custody !== null && ctx.deps.custody !== undefined && (linked || (await telegramApprovalsOn(ctx.deps)))
}

/** The main menu. With no NearKit wallet yet, Create wallet leads (when one can be made), Link wallet is the alternative. */
export async function mainMenu(ctx: BotCtx, known?: { create: boolean }) {
  const has = (name: string) => ctx.deps.features.has(name)
  const wallet = (await tradingWallet(ctx.deps, ctx.user.id)) !== null
  const linked = (await linkedAccount(ctx)) !== null
  const create = !wallet && (known?.create ?? (await canCreateWallet(ctx, linked)))
  return keyboard(
    create ? [newWalletButton('💼 Create wallet')] : [],
    linked || wallet ? [] : [btn('🔗 Link wallet', 'acct:link')],
    [has('buy') ? btn('🟢 Buy', 'tr:buy') : null, has('sell') ? btn('🔴 Sell', 'tr:sell') : null],
    [has('positions') ? btn('📊 Positions', 'pf:positions') : null, has('pnl') ? btn('📈 PnL', 'pf:pnl') : null],
    [has('balance') ? btn('👛 Wallet', 'menu:wallet') : null, btn('⚙️ Settings', 'set:show')],
    [has('buybot') ? btn('📣 Buybot', 'menu:buybot') : null, has('referral') ? btn('🎁 Invite', 'ref:show') : null],
    [btn('❓ Help', 'menu:help')],
  )
}

/**
 * The first screen: who is trading, with how much NEAR, and every action one tap away. With
 * no NearKit wallet yet (and one can be made), it leads to creating one; linking is optional.
 */
async function home(ctx: BotCtx, edit: boolean) {
  const nearkit = (await tradingWallet(ctx.deps, ctx.user.id))?.accountId ?? null
  const linked = await linkedAccount(ctx)
  const create = nearkit === null && (await canCreateWallet(ctx, linked !== null))
  const account = nearkit ?? linked
  const text = create
    ? noWalletYet(ctx.deps.config, linked ? { accountId: linked, near: await nearAvailable(ctx, linked) } : null)
    : [welcome(ctx.deps.config, account ? { accountId: account, near: await nearAvailable(ctx, account), nearkit: nearkit !== null } : null), SAFETY].join('\n')
  const menu = await mainMenu(ctx, { create })
  if (edit) await ctx.show(text, menu)
  else await ctx.reply(text, menu)
}

async function buybotInfo(ctx: BotCtx) {
  await ctx.show(
    [bold('📣 Buy alerts for your group'), '', 'Add me to your token’s group. Then a group admin sends /buybot there to choose the token, the minimum buy and the style.'].join(
      '\n',
    ),
    keyboard([urlBtn('➕ Add NEARKITS to a group', `https://t.me/${ctx.deps.me.username}?startgroup=buybot`)], [btn('« Menu', 'menu:home')]),
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
      await ctx.reply(`Hi! I’m the NEARKITS bot. A group admin can set up buy alerts with /buybot. For trading, open a private chat with me.`, {
        inline_keyboard: [[{ text: 'Open a private chat', url: `https://t.me/${ctx.deps.me.username}` }]],
      })
      return
    }
    // An invite: attribute a new user to whoever shared it, then the usual welcome.
    if (payload.startsWith('ref_')) await referralStart(ctx, payload.slice(4))
    const deep = payload && startPayloads[payload]
    if (deep) return deep(ctx)
    await home(ctx, false)
  }

  return {
    commands: {
      start: { scope: 'any', run: (ctx, args) => start(ctx, args.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)) },
      help: {
        ...documented('help'),
        // In a group the menu is someone's private screen: offer the private chat instead.
        run: async (ctx) =>
          void (await ctx.reply(
            helpText(ctx),
            ctx.isPrivate ? keyboard([btn('« Menu', 'menu:home')]) : keyboard([urlBtn('Open a private chat', `https://t.me/${ctx.deps.me.username}`)]),
          )),
      },
      cancel: {
        ...documented('cancel'),
        run: async (ctx) => {
          // The router already cleared any waiting step before running a command.
          await ctx.reply('Cancelled. Nothing is waiting any more.', ctx.isPrivate ? await mainMenu(ctx) : undefined)
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
