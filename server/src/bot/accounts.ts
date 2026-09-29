import { explorerAccountUrl } from '@/services/near/explorer'
import { LinkApiError } from '../link/service'
import { bold, code, esc, link, shortAccount } from '../telegram/html'
import { btn, documented, keyboard, urlBtn, type BotCtx, type BotModule } from './context'
import { mainMenu } from './core'
import { SAFETY } from './texts'

/**
 * /link, /accounts and /unlink. Linking itself is finished in the web app,
 * where the wallet signs; see link/service.ts for why that makes it safe.
 */

const CALLBACK_TTL_MS = 30 * 60_000

export async function startLink(ctx: BotCtx) {
  const { link: service, config } = ctx.deps
  let issued
  try {
    issued = service.createRequest(ctx.user.id)
  } catch (e) {
    if (e instanceof LinkApiError) {
      await ctx.reply(`⚠️ ${esc(e.message)}`)
      return
    }
    throw e
  }
  const minutes = Math.round((issued.expiresAt - ctx.deps.now()) / 60_000)
  const network = config.network.id === 'testnet' ? 'testnet' : 'mainnet'
  await ctx.reply(
    [
      bold('Link a NEAR account'),
      '',
      `1. Open the link below. It works once and expires in ${minutes} minutes.`,
      `2. Connect your ${network} wallet in NearKit.`,
      '3. Your wallet asks you to sign a message naming this Telegram account. Signing is free and moves no funds.',
      '',
      'Only open a link you asked for yourself. Never forward it.',
      '',
      SAFETY,
    ].join('\n'),
    keyboard([urlBtn('🔗 Open NearKit to link', issued.url)]),
  )
}

async function showAccounts(ctx: BotCtx) {
  const { store, config } = ctx.deps
  const links = store.linksOf(ctx.user.id, config.network.id)
  const def = store.getSettings(ctx.user.id).defaultAccount
  if (!links.length) {
    await ctx.show(
      `No NEAR account is linked yet.\n\nLink one to trade and see positions here. You sign a free message in your wallet; NearKit never holds keys.`,
      keyboard([btn('🔗 Link wallet', 'acct:link')], [btn('« Menu', 'menu:home')]),
    )
    return
  }
  const lines = links.map((l) => `${l.accountId === def ? '⭐ ' : '• '}${link(explorerAccountUrl(config.network, l.accountId), l.accountId)}`)
  const rows = links
    .filter((l) => l.accountId !== def)
    .map((l) => [btn(`⭐ Make ${shortAccount(l.accountId, 20)} default`, `acct:def:${store.putCallback({ accountId: l.accountId }, ctx.user.id, ctx.chat.id, CALLBACK_TTL_MS)}`)])
  await ctx.show(
    [bold('Linked accounts'), '', ...lines, '', def ? `⭐ ${code(def)} is used for trades unless you pick another.` : 'Choose a default account for trades.'].join('\n'),
    keyboard(...rows, [btn('🔗 Link another', 'acct:link'), btn('✂️ Unlink', 'acct:unlink')], [btn('« Menu', 'menu:home')]),
  )
}

async function showUnlink(ctx: BotCtx) {
  const { store, config } = ctx.deps
  const links = store.linksOf(ctx.user.id, config.network.id)
  if (!links.length) {
    await ctx.show('No NEAR account is linked, so there is nothing to unlink.', keyboard([btn('« Menu', 'menu:home')]))
    return
  }
  const rows = links.map((l) => [
    btn(`✂️ ${shortAccount(l.accountId, 28)}`, `acct:ask:${store.putCallback({ accountId: l.accountId }, ctx.user.id, ctx.chat.id, CALLBACK_TTL_MS)}`),
  ])
  await ctx.show('Which account should I unlink? It stays yours; I just stop using it here.', keyboard(...rows, [btn('Keep them all', 'acct:list')]))
}

export function accountsModule(): BotModule {
  const account = (ctx: BotCtx, id: string) => ctx.deps.store.getCallback<{ accountId: string }>(id, ctx.user.id)?.accountId ?? null
  return {
    commands: {
      link: { ...documented('link'), run: startLink },
      accounts: { ...documented('accounts'), run: showAccounts },
      unlink: { ...documented('unlink'), run: showUnlink },
    },
    callbacks: {
      acct: async (ctx, action, arg) => {
        const { store, config } = ctx.deps
        switch (action) {
          case 'link':
            await ctx.answer()
            return startLink(ctx)
          case 'list':
            return showAccounts(ctx)
          case 'unlink':
            return showUnlink(ctx)
          case 'def': {
            const id = account(ctx, arg)
            if (!id || !store.linkOf(config.network.id, id) || store.linkOf(config.network.id, id)?.userId !== ctx.user.id) {
              await ctx.answer('That button expired. Open /accounts again.', true)
              return
            }
            store.updateSettings(ctx.user.id, { defaultAccount: id })
            await ctx.answer(`${shortAccount(id)} is now the default`)
            return showAccounts(ctx)
          }
          case 'ask': {
            const id = account(ctx, arg)
            if (!id) {
              await ctx.answer('That button expired. Send /unlink again.', true)
              return
            }
            await ctx.show(
              `Unlink ${code(id)} from this Telegram account?\n\nYou can link it again any time with /link.`,
              keyboard([btn('✂️ Yes, unlink', `acct:do:${arg}`), btn('Cancel', 'acct:list')]),
            )
            return
          }
          case 'do': {
            const id = account(ctx, arg)
            if (!id) {
              await ctx.answer('That button expired. Send /unlink again.', true)
              return
            }
            const removed = store.unlink(config.network.id, id, ctx.user.id)
            await ctx.show(removed ? `✂️ Unlinked ${code(id)}.` : `${code(id)} was not linked to you.`, mainMenu(ctx))
            return
          }
        }
      },
    },
  }
}

/** Messages the API sends when a link completes in the web app. */
export function linkedText(accountId: string, networkLabel: string): string {
  return `✅ Linked ${code(accountId)} (${esc(networkLabel)}).\n\nIt is your default account for trades. Manage linked accounts with /accounts.`
}

export function movedAwayText(accountId: string): string {
  return `⚠️ ${code(accountId)} was just linked to another Telegram account by its owner’s wallet, so it is no longer linked here.\n\nIf that wasn’t you, move your funds to a new account: someone else can sign for it.`
}
