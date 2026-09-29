import { NEAR_DECIMALS } from '@/config/networks'
import { tryParseUnits } from '@/lib/amounts'
import { HIGH_SLIPPAGE, MAX_SLIPPAGE, SLIPPAGE_PRESETS } from '@/lib/fees'
import { bold, code, esc, plainText } from '../telegram/html'
import { btn, documented, FLOW_TTL_MS, keyboard, type BotCtx, type BotModule } from './context'

/**
 * /settings, in one place: trading (slippage, the Buy and Sell buttons, trade alerts)
 * and the wallet used for trades. Buy alerts are set per group, with /buybot there.
 * Saved per Telegram user.
 */

const MAX_PRESETS = 6
const MAX_PRESET_NEAR = 100_000n * 10n ** 24n
const MAX_SELL_PRESETS = 4

async function showSettings(ctx: BotCtx, note?: string) {
  const s = ctx.deps.store.getSettings(ctx.user.id)
  const slip = (p: number) => btn(`${p === s.slippagePct ? '● ' : ''}${p}%`, `set:slip:${p}`)
  await ctx.show(
    [
      ...(note ? [note, ''] : []),
      `⚙️ ${bold('Settings')}`,
      '',
      bold('Trading'),
      `Slippage ${code(`${s.slippagePct}%`)}${s.slippagePct >= HIGH_SLIPPAGE ? ' ⚠️ high' : ''}`,
      `Buy buttons ${s.buyPresets.map((p) => code(p)).join(' ')} NEAR`,
      `Sell buttons ${s.sellPresets.map((p) => code(`${p}%`)).join(' ')}`,
      `Trade alerts ${s.notifyTrades ? 'on' : 'off'}`,
      '',
      bold('Wallet'),
      `Trades use ${s.defaultAccount ? code(s.defaultAccount) : 'your first linked account (link one with /link)'}`,
      '',
      'Buy alerts for a group: add me there and send /buybot.',
    ].join('\n'),
    keyboard(
      [...SLIPPAGE_PRESETS.map(slip), btn('Custom %', 'set:slip:custom')],
      [btn('✏️ Buy buttons', 'set:presets:buy'), btn('✏️ Sell buttons', 'set:presets:sell')],
      [btn(s.notifyTrades ? '🔔 Trade alerts: on' : '🔕 Trade alerts: off', 'set:notify:toggle')],
      [btn('👛 Wallets', 'acct:list'), btn('« Menu', 'menu:home')],
    ),
  )
}

/** A slippage the web app would accept too: above 0, at most MAX_SLIPPAGE, two decimals. */
export function parseSlippage(text: string): number | null {
  const t = plainText(text, 16).replace('%', '').replace(',', '.').trim()
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(t)) return null
  const v = Number(t)
  return v > 0 && v <= MAX_SLIPPAGE ? v : null
}

/** "0.1 0.5 1 5" → exact NEAR decimal strings, or an error to show. */
export function parseBuyPresets(text: string): { ok: true; value: string[] } | { ok: false; error: string } {
  const parts = plainText(text, 200)
    .split(/[\s,;]+/)
    .filter(Boolean)
  if (parts.length === 0 || parts.length > MAX_PRESETS) return { ok: false, error: `Send 1 to ${MAX_PRESETS} amounts separated by spaces, like: 0.1 0.5 1 5` }
  const out: string[] = []
  for (const p of parts) {
    const parsed = tryParseUnits(p, NEAR_DECIMALS)
    if (!parsed.ok || parsed.value <= 0n) return { ok: false, error: `${p} is not a NEAR amount above 0` }
    if (parsed.value > MAX_PRESET_NEAR) return { ok: false, error: `${p} NEAR is more than a button should hold` }
    const normal = p.replace(/^0+(?=\d)/, '')
    if (!out.includes(normal)) out.push(normal)
  }
  return { ok: true, value: out }
}

/** "25 50 100" → whole percentages 1–100 for the sell buttons, ascending, or an error to show. */
export function parseSellPresets(text: string): { ok: true; value: number[] } | { ok: false; error: string } {
  const parts = plainText(text, 100)
    .split(/[\s,;%]+/)
    .filter(Boolean)
  if (parts.length === 0 || parts.length > MAX_SELL_PRESETS) return { ok: false, error: `Send 1 to ${MAX_SELL_PRESETS} percentages separated by spaces, like: 25 50 75 100` }
  const out = new Set<number>()
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) < 1 || Number(p) > 100) return { ok: false, error: `${p} is not a whole percentage from 1 to 100` }
    out.add(Number(p))
  }
  return { ok: true, value: [...out].sort((a, b) => a - b) }
}

export function settingsModule(): BotModule {
  return {
    commands: {
      settings: { ...documented('settings'), run: (ctx) => showSettings(ctx) },
    },
    callbacks: {
      set: async (ctx, action, arg) => {
        const { store } = ctx.deps
        if (action === 'show') return showSettings(ctx)
        if (action === 'slip' && arg === 'custom') {
          store.setSession(ctx.chat.id, ctx.user.id, 'settings.slippage', {}, FLOW_TTL_MS)
          await ctx.answer()
          await ctx.reply(`Send the slippage in percent, e.g. ${code('0.8')}. At most ${MAX_SLIPPAGE}%. /cancel to keep the current one.`)
          return
        }
        if (action === 'slip') {
          const v = parseSlippage(arg)
          if (v === null) return
          store.updateSettings(ctx.user.id, { slippagePct: v })
          await ctx.answer(`Slippage ${v}%`)
          return showSettings(ctx)
        }
        if (action === 'notify') {
          const s = store.getSettings(ctx.user.id)
          store.updateSettings(ctx.user.id, { notifyTrades: !s.notifyTrades })
          return showSettings(ctx)
        }
        if (action === 'presets' && arg === 'sell') {
          store.setSession(ctx.chat.id, ctx.user.id, 'settings.sellPresets', {}, FLOW_TTL_MS)
          await ctx.answer()
          await ctx.reply(`Send up to ${MAX_SELL_PRESETS} percentages for the sell buttons, e.g. ${code('25 50 75 100')}. /cancel to keep them.`)
          return
        }
        if (action === 'presets') {
          store.setSession(ctx.chat.id, ctx.user.id, 'settings.buyPresets', {}, FLOW_TTL_MS)
          await ctx.answer()
          await ctx.reply(`Send up to ${MAX_PRESETS} NEAR amounts for the buy buttons, separated by spaces, e.g. ${code('0.1 0.5 1 5')}. /cancel to keep them.`)
        }
      },
    },
    flows: {
      'settings.slippage': async (ctx, text) => {
        const v = parseSlippage(text)
        if (v === null) {
          await ctx.reply(`⚠️ ${esc(plainText(text, 16))} is not a slippage between 0 and ${MAX_SLIPPAGE}%. Try again, or /cancel.`)
          return
        }
        ctx.deps.store.clearSession(ctx.chat.id, ctx.user.id)
        ctx.deps.store.updateSettings(ctx.user.id, { slippagePct: v })
        await showSettings(ctx, `✅ Slippage set to ${v}%.${v >= HIGH_SLIPPAGE ? ' That is high: a trade may fill far below the quote.' : ''}`)
      },
      'settings.buyPresets': async (ctx, text) => {
        const parsed = parseBuyPresets(text)
        if (!parsed.ok) {
          await ctx.reply(`⚠️ ${esc(parsed.error)}. Try again, or /cancel.`)
          return
        }
        ctx.deps.store.clearSession(ctx.chat.id, ctx.user.id)
        ctx.deps.store.updateSettings(ctx.user.id, { buyPresets: parsed.value })
        await showSettings(ctx, '✅ Buy buttons saved.')
      },
      'settings.sellPresets': async (ctx, text) => {
        const parsed = parseSellPresets(text)
        if (!parsed.ok) {
          await ctx.reply(`⚠️ ${esc(parsed.error)}. Try again, or /cancel.`)
          return
        }
        ctx.deps.store.clearSession(ctx.chat.id, ctx.user.id)
        ctx.deps.store.updateSettings(ctx.user.id, { sellPresets: parsed.value })
        await showSettings(ctx, '✅ Sell buttons saved.')
      },
    },
  }
}
