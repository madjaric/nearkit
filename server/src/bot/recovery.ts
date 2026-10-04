import type { BackupKeyParams } from '../custody/recovery'
import { ownerKeyNow, RECOVERY_INTENT_TTL_MS, RecoveryApiError } from '../custody/recovery'
import type { Intent, TradingWallet } from '../custody/store'
import { deleteEmptyWallet, readWallet } from '../custody/wallets'
import { bold, code, esc, shortAccount } from '../telegram/html'
import { btn, keyboard, urlBtn, type BotCtx, type BotDeps, type BotModule } from './context'
import { intentKeyboard, registerIntentScreens, txLinks } from './intents'
import { flowWallet, newWalletButton, showWalletHome, tradingWallet, walletLine } from './tradingWallet'
import { walletErrorText } from './ui'
import { linkedAccount } from './wallet'

/**
 * 🔐 Recovery, per NearKit wallet: the backup key, the key export (in the NearKit web
 * app only) and removing NearKit's access, which answer to the wallet's owner wallet. A
 * wallet with no owner wallet can get one here (linking is optional): the user's linked
 * wallet, approved in NearKit's Mini App (Telegram signs it), bound for good. Keys are never
 * shown or asked for in Telegram. Every button carries the wallet it was shown for, so an
 * old button never acts on another wallet the user selected since.
 */

const back = [btn('« Wallet', 'cw:home')]

/** The wallet a Recovery button is for (its ID), else the selected one (the Recovery screen itself). */
async function recoveryWallet(ctx: BotCtx, walletId: string): Promise<TradingWallet | null> {
  return walletId ? flowWallet(ctx, walletId) : tradingWallet(ctx.deps, ctx.user.id)
}

/** A wallet with no owner wallet: everything works without one; an owner wallet (optional) adds the owner's powers. */
async function showUnowned(ctx: BotCtx, w: TradingWallet) {
  const view = await readWallet(ctx.deps.near, w)
  const linked = await linkedAccount(ctx)
  await ctx.show(
    [
      `🔐 ${bold('Recovery')} · ${walletLine(w)}`,
      '',
      `${bold('No owner wallet')}: this Telegram account controls this wallet. Deposits, trades and withdrawals all work without one.`,
      '',
      'An owner wallet is optional: your own NEAR wallet, bound to this one for good. It adds',
      '• a backup key, so your wallet controls this one even without NearKit;',
      '• the key export, in NearKit web;',
      '• withdrawals only to it, or to addresses it approves.',
      '',
      linked ? `Your linked wallet ${code(linked)} can become its owner: you approve that in Telegram.` : 'Link a NEAR wallet (optional), then make it the owner here.',
    ].join('\n'),
    keyboard(
      linked ? [btn(`🔐 Make ${shortAccount(linked, 28)} the owner`, `cr:bind:${w.id}`)] : [btn('🔗 Link a NEAR wallet', 'acct:link')],
      view.exists === false ? [btn('🗑 Delete this empty wallet', `cr:delete:${w.id}`)] : [],
      back,
    ),
  )
}

/** The user's linked wallet becomes the owner of a wallet with no owner wallet: approved in the Mini App, bound by the signer. */
async function offerBind(ctx: BotCtx, walletId: string) {
  const custody = ctx.deps.custody
  const w = await recoveryWallet(ctx, walletId)
  if (!custody || !w) return showWalletHome(ctx)
  if (w.ownerAccount) return showRecovery(ctx, w.id)
  const linked = await linkedAccount(ctx)
  const link = linked ? await ctx.deps.store.linkOf(ctx.deps.config.network.id, linked) : null
  if (!link || link.userId !== ctx.user.id) return showRecovery(ctx, w.id)
  let r
  try {
    r = await custody.telegram.request(w, { kind: 'bind-owner', accountId: w.accountId, owner: link.accountId, ownerKey: link.publicKey })
  } catch (e) {
    if (e instanceof RecoveryApiError) return ctx.show(`⚠️ ${esc(e.message)}`, keyboard([btn('🔐 Recovery', `cr:show:${w.id}`)], back))
    throw e
  }
  await ctx.show(
    [
      `🔐 ${bold(`Make ${link.accountId} the owner`)} · ${walletLine(w)}`,
      '',
      `${code(link.accountId)} becomes this NearKit wallet’s owner wallet, for good:`,
      '• withdrawals then go only to it, or to addresses it approves in NearKit web;',
      '• it can add itself as the backup key, and export the key.',
      'An owner wallet can’t be changed or removed later.',
      '',
      'Approve it in NearKit’s mini app, right here in Telegram. It shows this wallet and the owner, and Telegram signs your approval.',
      '⏱ Open for 10 minutes.',
    ].join('\n'),
    keyboard([urlBtn('✅ Approve in Telegram', custody.telegram.link(r))], back),
  )
}

async function showRecovery(ctx: BotCtx, walletId = '') {
  const w = await recoveryWallet(ctx, walletId)
  if (!w) return showWalletHome(ctx)
  if (!w.ownerAccount) return showUnowned(ctx, w)
  const view = await readWallet(ctx.deps.near, w)
  const owner = w.ownerAccount
  const mine = await ownerKeyNow(ctx.deps.store, w)
  const backup = view.keys === null ? null : mine !== null && view.keys.includes(mine)
  // Any other full-access key can move the funds too: say so, it may not be the user's.
  const known = [w.publicKey, w.ownerKey, w.backupKey, mine]
  const others = (view.keys ?? []).filter((k) => !known.includes(k))
  const status = backup === null ? '— (couldn’t read the chain)' : backup ? '✓ added' : view.exists ? 'not added yet' : 'after the first deposit'
  await ctx.show(
    [
      `🔐 ${bold('Recovery')} · ${walletLine(w)}`,
      'Your NearKit wallet stays yours, even if NearKit disappears.',
      '',
      ...(owner ? [`Owner: ${code(owner)}, the wallet it was created with.`, ''] : []),
      `${bold('1. Backup key')} · ${esc(status)}`,
      `Your owner wallet’s key also controls this wallet. Restoring your own wallet (its seed phrase or key) in a NEAR wallet app then finds this one too.`,
      ...others.map((k) => `⚠️ Another key also controls this wallet: ${code(`${k.slice(0, 16)}…`)}. If it isn’t yours, move your funds.`),
      '',
      bold('2. Export'),
      'See this wallet’s private key in NearKit web, after signing with your owner wallet. Never in Telegram. Only this wallet’s key.',
      '',
      bold('3. Remove NearKit’s access'),
      'NearKit deletes its own key; after that only your wallet controls this one. Needs the backup key first.',
    ].join('\n'),
    keyboard(
      backup === false && view.exists && mine ? [btn('🔐 Add backup key', `cr:backup:${w.id}`)] : [],
      owner ? [btn('🌐 Export key in NearKit web', `cr:export:${w.id}`)] : [],
      backup ? [btn('🧹 Remove NearKit’s access', `cr:revoke:${w.id}`)] : [],
      view.exists === false ? [btn('🗑 Delete this empty wallet', `cr:delete:${w.id}`)] : [],
      back,
    ),
  )
}

async function backupReview(deps: BotDeps, intent: Intent): Promise<string> {
  const p = intent.params as unknown as BackupKeyParams
  const w = await deps.custody?.store.wallet(intent.walletId)
  return [
    `🔐 ${bold('Add a backup key')}${w ? ` · ${walletLine(w)}` : ''}`,
    '',
    `Your owner wallet ${code(p.linkedAccount)} gets a full-access key on this NearKit wallet:`,
    `Key ${code(p.publicKey)} (the one you signed with when you linked it)`,
    '',
    'After this, your own wallet can control this NearKit wallet directly, even without NearKit.',
    'Network fee ≈ 0.0001 NEAR; a tiny storage deposit stays on the wallet.',
  ].join('\n')
}

async function revokeReview(deps: BotDeps, intent: Intent): Promise<string> {
  const w = await deps.custody?.store.wallet(intent.walletId)
  return [
    `🧹 ${bold('Remove NearKit’s access')}${w ? ` · ${walletLine(w)}` : ''}`,
    '',
    `NearKit deletes its own key from ${esc(w ? shortAccount(w.accountId) : '')} and erases its copy.`,
    'After this only your own wallet controls it: NearKit can’t trade or withdraw for it any more. This can’t be undone; you can create a new NearKit wallet any time.',
    'Your funds stay in the wallet.',
  ].join('\n')
}

registerIntentScreens('backup-key', {
  review: async (deps, intent) => ({ text: await backupReview(deps, intent), confirm: '✅ Add backup key' }),
  result: async (deps, intent) => {
    const p = intent.params as unknown as BackupKeyParams
    const w = await deps.custody?.store.wallet(intent.walletId)
    const r = intent.result
    const links = r?.hashes.length ? txLinks(deps, r.hashes) : null
    const text = r?.ok
      ? [
          `✅ ${bold('Backup key added')}${w ? ` · ${walletLine(w)}` : ''}`,
          `Your wallet ${code(p.linkedAccount)} can now control this NearKit wallet without NearKit.`,
          ...(links ? [`Tx ${links}`] : []),
        ].join('\n')
      : [`❌ ${bold('Backup key not added')}`, esc(r?.message ?? 'Nothing was sent.'), ...(links ? [`Tx ${links}`] : [])].join('\n')
    return { text, markup: keyboard([btn('🔐 Recovery', `cr:show:${intent.walletId}`), btn('👛 Wallet', 'cw:home')]) }
  },
})

registerIntentScreens('revoke', {
  review: async (deps, intent) => ({ text: await revokeReview(deps, intent), confirm: '✅ Remove NearKit’s key' }),
  result: async (deps, intent) => {
    const w = await deps.custody?.store.wallet(intent.walletId)
    const r = intent.result
    const links = r?.hashes.length ? txLinks(deps, r.hashes) : null
    const text = r?.ok
      ? [
          `✅ ${bold('NearKit’s key was removed')}`,
          `${code(w?.accountId ?? '')} is controlled only by your own wallet now. NearKit no longer holds a key for it.`,
          ...(links ? [`Tx ${links}`] : []),
        ].join('\n')
      : [`❌ ${bold('NearKit’s key was not removed')}`, esc(r?.message ?? 'Nothing was sent.'), ...(links ? [`Tx ${links}`] : [])].join('\n')
    return { text, markup: keyboard(r?.ok ? [newWalletButton()] : [btn('🔐 Recovery', `cr:show:${intent.walletId}`)], [btn('« Menu', 'menu:home')]) }
  },
})

async function offerBackup(ctx: BotCtx, walletId: string) {
  const custody = ctx.deps.custody
  const w = await recoveryWallet(ctx, walletId)
  // Always the owner's key, whichever wallet is linked now.
  const key = w ? await ownerKeyNow(ctx.deps.store, w) : null
  if (!custody || !w || !w.ownerAccount || !key) return showRecovery(ctx, walletId)
  await custody.store.cancelQuoted(w.id, ['backup-key', 'revoke'])
  const params: BackupKeyParams = { linkedAccount: w.ownerAccount, publicKey: key }
  const intent = await custody.store.createIntent({ walletId: w.id, userId: ctx.user.id, chatId: ctx.chat.id, kind: 'backup-key', params, ttlMs: RECOVERY_INTENT_TTL_MS })
  await ctx.show(await backupReview(ctx.deps, intent), intentKeyboard(intent, '✅ Add backup key'))
}

async function offerRevoke(ctx: BotCtx, walletId: string) {
  const custody = ctx.deps.custody
  const w = await recoveryWallet(ctx, walletId)
  if (!custody || !w) return showWalletHome(ctx)
  await custody.store.cancelQuoted(w.id, ['backup-key', 'revoke'])
  const intent = await custody.store.createIntent({ walletId: w.id, userId: ctx.user.id, chatId: ctx.chat.id, kind: 'revoke', params: {}, ttlMs: RECOVERY_INTENT_TTL_MS })
  await ctx.show(await revokeReview(ctx.deps, intent), intentKeyboard(intent, '✅ Remove NearKit’s key'))
}

async function exportLink(ctx: BotCtx, walletId: string) {
  const custody = ctx.deps.custody
  const w = await recoveryWallet(ctx, walletId)
  if (!custody || !w) return showWalletHome(ctx)
  let issued
  try {
    issued = await custody.recovery.exportLink(ctx.user.id, w.id)
  } catch (e) {
    if (e instanceof RecoveryApiError) return ctx.show(`⚠️ ${esc(e.message)}`, keyboard(back))
    throw e
  }
  await ctx.show(
    [
      `🌐 ${bold('Export a NearKit wallet’s key')} · ${walletLine(w)}`,
      '',
      '1. Open NearKit web with the button below (the same page works without Telegram: nearkit.vercel.app/recover).',
      `2. Connect ${w.ownerAccount ? code(w.ownerAccount) : 'your owner wallet'}, the wallet this one was created with, and sign the message it shows. Signing is free.`,
      '3. The private key is sealed to that browser and shown once, on your screen. Nothing in between can read it.',
      '',
      'Anyone who sees that key controls the wallet. Never share it or paste it into a chat. NearKit never asks for it.',
    ].join('\n'),
    keyboard([urlBtn('🌐 Open NearKit to export', issued.url)], back),
  )
}

async function offerDelete(ctx: BotCtx, walletId: string) {
  const w = await recoveryWallet(ctx, walletId)
  if (!w) return showWalletHome(ctx)
  const view = await readWallet(ctx.deps.near, w)
  if (view.exists !== false)
    return ctx.show(
      'This wallet has been funded, so it can’t just be deleted: withdraw everything, or add the backup key and remove NearKit’s access.',
      keyboard([btn('🔐 Recovery', `cr:show:${w.id}`)], back),
    )
  await ctx.show(
    `🗑 Delete the empty NearKit wallet ${walletLine(w)}?\n\nIt was never funded, so nothing can be lost. NearKit erases its key, and its slot is free for a new wallet.`,
    keyboard([btn('🗑 Yes, delete it', `cr:deleteyes:${w.id}`), btn('Keep it', 'cw:home')]),
  )
}

async function deleteEmpty(ctx: BotCtx, walletId: string) {
  const custody = ctx.deps.custody
  // Only the wallet this confirmation was shown for: never "whichever is selected now".
  const w = await flowWallet(ctx, walletId)
  if (!custody || !w) return showWalletHome(ctx)
  // Re-read now (a deposit may have arrived since the question); the signer checks the chain itself.
  let outcome: 'deleted' | 'funded'
  try {
    outcome = await deleteEmptyWallet(custody, ctx.deps.near, w)
  } catch (e) {
    return ctx.show(`⚠️ ${esc(walletErrorText(e, { network: ctx.deps.config.network.id, log: ctx.deps.log, context: 'delete wallet' }))} Nothing was deleted.`, keyboard(back))
  }
  if (outcome === 'funded') return offerDelete(ctx, w.id)
  await ctx.show('🗑 Deleted. It was never funded, so nothing was lost.', keyboard([newWalletButton(), btn('« Menu', 'menu:home')]))
}

export function recoveryModule(): BotModule {
  return {
    callbacks: {
      cr: async (ctx, action, arg) => {
        await ctx.answer()
        switch (action) {
          case 'show':
            return showRecovery(ctx, arg)
          case 'bind':
            return offerBind(ctx, arg)
          case 'backup':
            return offerBackup(ctx, arg)
          case 'export':
            return exportLink(ctx, arg)
          case 'revoke':
            return offerRevoke(ctx, arg)
          case 'delete':
            return offerDelete(ctx, arg)
          case 'deleteyes':
            return deleteEmpty(ctx, arg)
        }
      },
    },
  }
}

/** Sent to Telegram when the key was exported in the web app: the owner hears about it either way. */
export function exportedText(wallet: string, owner: string): string {
  return `🔐 Your NearKit wallet ${esc(shortAccount(wallet))} key was just exported in NearKit web, signed by its owner wallet ${code(owner)}.\n\nIf this wasn’t you, move your funds now.`
}

/** Sent to Telegram when an approval given in the Mini App counted (Telegram signed it). */
export function telegramApprovedText(r: { kind: 'destination' | 'bind-owner'; accountId: string; target: string; walletId: string }): {
  text: string
  markup: ReturnType<typeof keyboard>
} {
  if (r.kind === 'destination')
    return {
      text: `✅ ${code(r.target)} can now receive withdrawals from your NearKit wallet ${esc(shortAccount(r.accountId))}: approved in Telegram.\n\nIf this wasn’t you, move your funds now.`,
      markup: keyboard([btn('▶️ Continue withdrawal', 'cw:wcont'), btn('👛 Wallet', 'cw:home')]),
    }
  return {
    text: `🔐 ${code(r.target)} is now the owner of your NearKit wallet ${esc(shortAccount(r.accountId))}, for good.\n\nWithdrawals now go to it or to addresses it approves in NearKit web, and it can add the backup key or export the key (🔐 Recovery).`,
    markup: keyboard([btn('🔐 Recovery', `cr:show:${r.walletId}`), btn('👛 Wallet', 'cw:home')]),
  }
}

export function approvedText(wallet: string, destination: string): string {
  return `✅ ${code(destination)} can now receive withdrawals from your NearKit wallet ${esc(shortAccount(wallet))}: approved with its owner wallet.\n\nIf this wasn’t you, move your funds now.`
}
