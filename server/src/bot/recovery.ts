import type { BackupKeyParams } from '../custody/recovery'
import { ownerKeyNow, RECOVERY_INTENT_TTL_MS, RecoveryApiError } from '../custody/recovery'
import type { Intent } from '../custody/store'
import { readWallet } from '../custody/wallets'
import { bold, code, esc, shortAccount } from '../telegram/html'
import { btn, keyboard, urlBtn, type BotCtx, type BotModule } from './context'
import { intentKeyboard, registerIntentScreens, txLinks } from './intents'
import { showWalletHome, tradingWallet } from './tradingWallet'

/**
 * 🔐 Recovery: the backup key, the key export (in the NearKit web app only) and
 * removing NearKit's access. Keys are never shown or asked for in Telegram.
 */

const back = [btn('« Wallet', 'cw:home')]

async function showRecovery(ctx: BotCtx) {
  const w = tradingWallet(ctx.deps, ctx.user.id)
  if (!w) return showWalletHome(ctx)
  const view = await readWallet(ctx.deps.near, w)
  const owner = w.ownerAccount
  const mine = ownerKeyNow(ctx.deps.store, w)
  const backup = view.keys === null ? null : mine !== null && view.keys.includes(mine)
  // Any other full-access key can move the funds too: say so, it may not be the user's.
  const known = [w.publicKey, w.ownerKey, w.backupKey, mine]
  const others = (view.keys ?? []).filter((k) => !known.includes(k))
  const status = backup === null ? '— (couldn’t read the chain)' : backup ? '✓ added' : view.exists ? 'not added yet' : 'after the first deposit'
  await ctx.show(
    [
      `🔐 ${bold('Recovery')}`,
      'Your NearKit wallet stays yours, even if NearKit disappears.',
      '',
      ...(owner ? [`Owner: ${code(owner)}, the wallet it was created with.`, ''] : []),
      `${bold('1. Backup key')} · ${esc(status)}`,
      `Your owner wallet’s key also controls this wallet. Restoring your own wallet (its seed phrase or key) in a NEAR wallet app then finds this one too.`,
      ...others.map((k) => `⚠️ Another key also controls this wallet: ${code(`${k.slice(0, 16)}…`)}. If it isn’t yours, move your funds.`),
      '',
      bold('2. Export'),
      'See this wallet’s private key in NearKit web, after signing with your owner wallet. Never in Telegram.',
      '',
      bold('3. Remove NearKit’s access'),
      'NearKit deletes its own key; after that only your wallet controls this one. Needs the backup key first.',
    ].join('\n'),
    keyboard(
      backup === false && view.exists && mine ? [btn('🔐 Add backup key', 'cr:backup')] : [],
      owner ? [btn('🌐 Export key in NearKit web', 'cr:export')] : [],
      backup ? [btn('🧹 Remove NearKit’s access', 'cr:revoke')] : [],
      view.exists === false ? [btn('🗑 Delete this empty wallet', 'cr:delete')] : [],
      back,
    ),
  )
}

function backupReview(intent: Intent): string {
  const p = intent.params as unknown as BackupKeyParams
  return [
    `🔐 ${bold('Add a backup key')}`,
    '',
    `Your owner wallet ${code(p.linkedAccount)} gets a full-access key on your NearKit wallet:`,
    `Key ${code(p.publicKey)} (the one you signed with when you linked it)`,
    '',
    'After this, your own wallet can control this NearKit wallet directly, even without NearKit.',
    'Network fee ≈ 0.0001 NEAR; a tiny storage deposit stays on the wallet.',
  ].join('\n')
}

function revokeReview(deps: BotCtx['deps'], intent: Intent): string {
  const w = deps.custody?.store.wallet(intent.walletId)
  return [
    `🧹 ${bold('Remove NearKit’s access')}`,
    '',
    `NearKit deletes its own key from ${code(w ? shortAccount(w.accountId) : '')} and erases its copy.`,
    'After this only your own wallet controls it: NearKit can’t trade or withdraw for it any more. This can’t be undone; you can create a new NearKit wallet any time.',
    'Your funds stay in the wallet.',
  ].join('\n')
}

registerIntentScreens('backup-key', {
  review: (_deps, intent) => ({ text: backupReview(intent), confirm: '✅ Add backup key' }),
  result: (deps, intent) => {
    const p = intent.params as unknown as BackupKeyParams
    const r = intent.result
    const links = r?.hashes.length ? txLinks(deps, r.hashes) : null
    const text = r?.ok
      ? [`✅ ${bold('Backup key added')}`, `Your wallet ${code(p.linkedAccount)} can now control this NearKit wallet without NearKit.`, ...(links ? [`Tx ${links}`] : [])].join(
          '\n',
        )
      : [`❌ ${bold('Backup key not added')}`, esc(r?.message ?? 'Nothing was sent.'), ...(links ? [`Tx ${links}`] : [])].join('\n')
    return { text, markup: keyboard([btn('🔐 Recovery', 'cr:show'), btn('👛 Wallet', 'cw:home')]) }
  },
})

registerIntentScreens('revoke', {
  review: (deps, intent) => ({ text: revokeReview(deps, intent), confirm: '✅ Remove NearKit’s key' }),
  result: (deps, intent) => {
    const w = deps.custody?.store.wallet(intent.walletId)
    const r = intent.result
    const links = r?.hashes.length ? txLinks(deps, r.hashes) : null
    const text = r?.ok
      ? [
          `✅ ${bold('NearKit’s key was removed')}`,
          `${code(w?.accountId ?? '')} is controlled only by your own wallet now. NearKit no longer holds a key for it.`,
          ...(links ? [`Tx ${links}`] : []),
        ].join('\n')
      : [`❌ ${bold('NearKit’s key was not removed')}`, esc(r?.message ?? 'Nothing was sent.'), ...(links ? [`Tx ${links}`] : [])].join('\n')
    return { text, markup: keyboard(r?.ok ? [btn('✨ New NearKit wallet', 'cw:create')] : [btn('🔐 Recovery', 'cr:show')], [btn('« Menu', 'menu:home')]) }
  },
})

async function offerBackup(ctx: BotCtx) {
  const custody = ctx.deps.custody
  const w = tradingWallet(ctx.deps, ctx.user.id)
  // Always the owner's key, whichever wallet is linked now.
  const key = w ? ownerKeyNow(ctx.deps.store, w) : null
  if (!custody || !w || !w.ownerAccount || !key) return showRecovery(ctx)
  custody.store.cancelQuoted(w.id, ['backup-key', 'revoke'])
  const params: BackupKeyParams = { linkedAccount: w.ownerAccount, publicKey: key }
  const intent = custody.store.createIntent({ walletId: w.id, userId: ctx.user.id, chatId: ctx.chat.id, kind: 'backup-key', params, ttlMs: RECOVERY_INTENT_TTL_MS })
  await ctx.show(backupReview(intent), intentKeyboard(intent, '✅ Add backup key'))
}

async function offerRevoke(ctx: BotCtx) {
  const custody = ctx.deps.custody
  const w = tradingWallet(ctx.deps, ctx.user.id)
  if (!custody || !w) return showWalletHome(ctx)
  custody.store.cancelQuoted(w.id, ['backup-key', 'revoke'])
  const intent = custody.store.createIntent({ walletId: w.id, userId: ctx.user.id, chatId: ctx.chat.id, kind: 'revoke', params: {}, ttlMs: RECOVERY_INTENT_TTL_MS })
  await ctx.show(revokeReview(ctx.deps, intent), intentKeyboard(intent, '✅ Remove NearKit’s key'))
}

async function exportLink(ctx: BotCtx) {
  const custody = ctx.deps.custody
  const w = tradingWallet(ctx.deps, ctx.user.id)
  if (!custody || !w) return showWalletHome(ctx)
  let issued
  try {
    issued = custody.recovery.createRequest(ctx.user.id)
  } catch (e) {
    if (e instanceof RecoveryApiError) return ctx.show(`⚠️ ${esc(e.message)}`, keyboard(back))
    throw e
  }
  const minutes = Math.round((issued.expiresAt - ctx.deps.now()) / 60_000)
  await ctx.show(
    [
      `🌐 ${bold('Export your NearKit wallet’s key')}`,
      '',
      `1. Open the link below. It works once and expires in ${minutes} minutes.`,
      `2. Connect ${w.ownerAccount ? code(w.ownerAccount) : 'your owner wallet'}, the wallet this one was created with, and sign the message it shows. Signing is free.`,
      '3. NearKit web shows the private key once, on your screen.',
      '',
      'Anyone who sees that key controls the wallet. Never share it or paste it into a chat. NearKit never asks for it.',
    ].join('\n'),
    keyboard([urlBtn('🌐 Open NearKit to export', issued.url)], back),
  )
}

async function offerDelete(ctx: BotCtx) {
  const w = tradingWallet(ctx.deps, ctx.user.id)
  if (!w) return showWalletHome(ctx)
  const view = await readWallet(ctx.deps.near, w)
  if (view.exists !== false)
    return ctx.show(
      'This wallet has been funded, so it can’t just be deleted: withdraw everything, or add the backup key and remove NearKit’s access.',
      keyboard([btn('🔐 Recovery', 'cr:show')], back),
    )
  await ctx.show(
    `🗑 Delete the empty NearKit wallet ${code(shortAccount(w.accountId))}?\n\nIt was never funded, so nothing can be lost. NearKit erases its key.`,
    keyboard([btn('🗑 Yes, delete it', 'cr:deleteyes'), btn('Keep it', 'cw:home')]),
  )
}

async function deleteEmpty(ctx: BotCtx) {
  const custody = ctx.deps.custody
  const w = tradingWallet(ctx.deps, ctx.user.id)
  if (!custody || !w) return showWalletHome(ctx)
  // Re-read now: a deposit may have arrived since the question.
  const view = await readWallet(ctx.deps.near, w)
  if (view.exists !== false) return offerDelete(ctx)
  custody.store.closeWallet(w.id, 'deleted', { reason: 'never funded' })
  await ctx.show('🗑 Deleted. It was never funded, so nothing was lost.', keyboard([btn('✨ New NearKit wallet', 'cw:create'), btn('« Menu', 'menu:home')]))
}

export function recoveryModule(): BotModule {
  return {
    callbacks: {
      cr: async (ctx, action) => {
        await ctx.answer()
        switch (action) {
          case 'show':
            return showRecovery(ctx)
          case 'backup':
            return offerBackup(ctx)
          case 'export':
            return exportLink(ctx)
          case 'revoke':
            return offerRevoke(ctx)
          case 'delete':
            return offerDelete(ctx)
          case 'deleteyes':
            return deleteEmpty(ctx)
        }
      },
    },
  }
}

/** Sent to Telegram when the key was exported in the web app: the owner hears about it either way. */
export function exportedText(wallet: string, signedBy: string): string {
  return `🔐 Your NearKit wallet ${code(shortAccount(wallet))} key was just exported in NearKit web, signed by ${code(signedBy)}.\n\nIf this wasn’t you, move your funds now.`
}
