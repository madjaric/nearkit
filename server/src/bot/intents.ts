import { explorerTxUrl } from '@/services/near/explorer'
import type { Intent, IntentKind } from '../custody/store'
import { bold, esc, link } from '../telegram/html'
import type { InlineKeyboard } from '../telegram/types'
import { btn, keyboard, type BotCtx, type BotDeps, type BotModule } from './context'

/**
 * Confirm and Cancel for everything a NearKit wallet does (trades, withdrawals,
 * the backup key, revoking). The buttons carry only the intent's ID; the engine
 * decides whether it may still run (owner, not expired, not already confirmed,
 * nothing else in flight), so a double tap or an old button never sends twice.
 */

type Awaitable<T> = T | Promise<T>

export interface IntentScreens {
  /** The review with its Confirm button (also shown when the quote changed). */
  review(deps: BotDeps, intent: Intent): Awaitable<{ text: string; confirm: string }>
  /** The outcome, once final. */
  result(deps: BotDeps, intent: Intent): Awaitable<{ text: string; markup: InlineKeyboard }>
  /** Button that starts this kind of action again. */
  again?: (deps: BotDeps, intent: Intent) => { text: string; data: string } | null
}

const screens: Partial<Record<IntentKind, IntentScreens>> = {}

export function registerIntentScreens(kind: IntentKind, s: IntentScreens) {
  screens[kind] = s
}

export const intentKeyboard = (intent: Intent, confirm: string) => keyboard([btn(confirm, `cx:ok:${intent.id}`), btn('✖ Cancel', `cx:no:${intent.id}`)])

export function txLinks(deps: BotDeps, hashes: readonly string[]): string {
  return hashes.map((h, i) => link(explorerTxUrl(deps.config.network, h), hashes.length > 1 ? `Tx ${i + 1}` : `${h.slice(0, 6)}…${h.slice(-4)}`)).join(' · ')
}

const walletRow = () => [btn('👛 Wallet', 'cw:home'), btn('« Menu', 'menu:home')]

/** Final text for an intent, from its kind's screens (or a plain fallback). */
export async function resultScreen(deps: BotDeps, intent: Intent): Promise<{ text: string; markup: InlineKeyboard }> {
  const s = screens[intent.kind]
  if (s) return s.result(deps, intent)
  const r = intent.result
  const text = [r?.ok ? '✅ Done.' : `❌ ${esc(r?.message ?? 'Failed.')}`, r?.hashes.length ? `Tx ${txLinks(deps, r.hashes)}` : null].filter(Boolean).join('\n')
  return { text, markup: keyboard(walletRow()) }
}

export const PENDING_TEXT = `⏳ ${bold('Sent. Waiting for the chain')}\nNearKit is checking the transaction and will message you when it’s final. Nothing will be sent twice.`

async function confirm(ctx: BotCtx, id: string) {
  const custody = ctx.deps.custody
  const intent = (await custody?.store.intent(id)) ?? null
  if (!custody || !intent || intent.userId !== ctx.user.id) return ctx.answer('That button expired.', true)
  if (intent.status !== 'quoted') {
    // A second press, a replayed update or an old message: nothing runs again.
    const toast =
      intent.status === 'expired'
        ? 'That expired. Nothing was sent.'
        : intent.status === 'cancelled' || intent.status === 'replaced'
          ? 'That quote was replaced or cancelled. Nothing was sent.'
          : 'Already confirmed: see the result.'
    return ctx.answer(toast, false)
  }
  await ctx.answer('Sending…')
  // The buttons go away at once, so this message can't be pressed again.
  await ctx.show(`⏳ ${bold('Sending')}…\nNearKit is signing and waiting for the chain.`)
  const r = await custody.engine.execute(id, ctx.user.id)
  const kindScreens = screens[intent.kind]
  switch (r.kind) {
    case 'finished': {
      const s = await resultScreen(ctx.deps, r.intent)
      return ctx.show(s.text, s.markup)
    }
    case 'pending':
      return ctx.show(PENDING_TEXT, keyboard(walletRow()))
    case 'requoted': {
      if (!kindScreens) return ctx.show('⚠️ The quote changed. Start again.', keyboard(walletRow()))
      const review = await kindScreens.review(ctx.deps, r.next)
      return ctx.show(`⚠️ ${bold('Quote changed. Review the new price.')}\n\n${review.text}`, intentKeyboard(r.next, review.confirm))
    }
    case 'refused': {
      const again = r.intent && kindScreens?.again?.(ctx.deps, r.intent)
      const retry = again ? [btn(again.text, again.data)] : []
      const text =
        r.reason === 'expired'
          ? '⏱ That review expired. Nothing was sent. Get a fresh one.'
          : r.reason === 'busy'
            ? '⏳ Another transaction from your NearKit wallet is still being confirmed. Nothing was sent; try again in a moment.'
            : r.reason === 'wallet'
              ? 'This NearKit wallet is closed. Nothing was sent.'
              : 'Already confirmed: see the result above.'
      return ctx.show(text, keyboard(retry, walletRow()))
    }
  }
}

async function cancel(ctx: BotCtx, id: string) {
  const custody = ctx.deps.custody
  const intent = (await custody?.store.intent(id)) ?? null
  if (!custody || !intent || intent.userId !== ctx.user.id) return ctx.answer('That button expired.', true)
  if (!(await custody.store.setStatus(id, ['quoted'], 'cancelled'))) return ctx.answer(intent.status === 'cancelled' ? 'Already cancelled.' : 'Already confirmed: see the result.')
  await ctx.answer()
  await ctx.show('Cancelled. Nothing was sent.', keyboard(walletRow()))
}

export function intentsModule(): BotModule {
  return {
    callbacks: {
      cx: async (ctx, action, arg) => {
        if (action === 'ok') return confirm(ctx, arg)
        if (action === 'no') return cancel(ctx, arg)
        await ctx.answer()
      },
    },
  }
}

/** The resolver settled an intent in the background: tell its user. */
export async function notifySettled(deps: BotDeps, notify: (userId: number, html: string, markup?: InlineKeyboard) => Promise<boolean>, intent: Intent): Promise<void> {
  const s = await resultScreen(deps, intent)
  await notify(intent.userId, s.text, s.markup)
}
