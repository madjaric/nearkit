import { explorerTxUrl } from '@/services/near/explorer'
import type { ExecuteResult } from '../custody/engine'
import { IN_FLIGHT, type Intent, type IntentKind } from '../custody/store'
import { TelegramError } from '../telegram/api'
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
  /** The outcome, once done (a buy: when its tokens arrived). */
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
  return plainResult(deps, intent)
}

/** The outcome from the intent's own record alone (nothing to read from the chain). */
function plainResult(deps: BotDeps, intent: Intent): { text: string; markup: InlineKeyboard } {
  const r = intent.result
  const text = [r?.ok ? '✅ Done.' : `❌ ${esc(r?.message ?? 'Failed.')}`, r?.hashes.length ? `Tx ${txLinks(deps, r.hashes)}` : null].filter(Boolean).join('\n')
  return { text, markup: keyboard(walletRow()) }
}

/** Sent, and the chain hasn't finished it within the live wait: slower than usual, never a failure. */
export const PENDING_TEXT = `⏳ ${bold('Processing — NEAR network is taking longer than usual')}\nNEARKITS keeps checking the chain and messages you as soon as it’s through. Nothing will be sent twice.`

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
  await ctx.show(`⏳ ${bold('Sending')}…\nNEARKITS is signing and waiting for the chain.`)
  try {
    await showOutcome(ctx, intent, await custody.engine.execute(id, ctx.user.id))
  } catch (e) {
    await confirmFailed(ctx, id, e)
  }
}

async function showOutcome(ctx: BotCtx, intent: Intent, r: ExecuteResult): Promise<void> {
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
            ? '⏳ Another transaction from your NEARKITS wallet is still being confirmed. Nothing was sent; try again in a moment.'
            : r.reason === 'wallet'
              ? 'This NEARKITS wallet is closed. Nothing was sent.'
              : 'Already confirmed: see the result above.'
      return ctx.show(text, keyboard(retry, walletRow()))
    }
  }
}

/**
 * Confirm failed once the engine had the intent: it threw (a database error, a crash in a step)
 * or its outcome couldn't be shown. A transaction may be out by then, so the answer is never
 * "nothing was sent": an intent still in flight (or unreadable) shows Processing, as the resolver
 * settles it from the chain and messages the user (failing it if nothing was ever signed), and a
 * settled one shows its result. Only an intent Confirm never ran (still quoted, re-quoted, refused)
 * goes on to the error boundary, which rightly says nothing was sent.
 */
async function confirmFailed(ctx: BotCtx, id: string, e: unknown): Promise<void> {
  const now = await ctx.deps.custody?.store.intent(id).catch(() => undefined)
  const settled = now?.status === 'done' || now?.status === 'failed'
  if (now && !settled && !IN_FLIGHT.includes(now.status)) throw e
  ctx.deps.log.error('confirm failed once the engine had the intent', { intent: id, status: now?.status ?? 'unknown', error: e })
  const s = now && settled ? await resultScreen(ctx.deps, now).catch(() => plainResult(ctx.deps, now)) : { text: PENDING_TEXT, markup: keyboard(walletRow()) }
  try {
    await ctx.show(s.text, s.markup)
  } catch {
    // The message can't be edited (deleted, or Telegram refused it): a new one says it instead.
    await ctx.reply(s.text, s.markup).catch((replied: unknown) => {
      if (replied instanceof TelegramError && replied.blocked) throw replied
      ctx.deps.log.warn('couldn’t tell the user how Confirm went; the resolver reports it if still in flight', { intent: id, error: replied })
    })
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
