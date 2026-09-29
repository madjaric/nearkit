import { NEAR_DECIMALS } from '@/config/networks'
import { formatUnits, parseUnits } from '@/lib/amounts'
import { formatAgo } from '@/lib/format'
import { accountIdError, isForeignToNetwork } from '@/lib/validation'
import { describeError } from '@/services/errors'
import { explorerTokenUrl } from '@/services/near/explorer'
import { renderBuy } from '../buybot/format'
import { MAX_CONFIGS_PER_CHAT, type BuybotConfig } from '../buybot/store'
import { bold, code, esc, link, plainText } from '../telegram/html'
import type { TgChatMemberUpdated } from '../telegram/types'
import { btn, documented, FLOW_TTL_MS, keyboard, type BotCtx, type BotDeps, type BotModule, type BuybotDeps } from './context'

/**
 * /buybot: group admins choose tokens whose buys NearKit posts in the group.
 * Every button re-checks that the presser is an admin of that chat. With privacy
 * mode on, the bot reads the admin's answer through a reply to its own prompt.
 */

const ANONYMOUS_ADMIN = 1087968824
const ADMIN_TTL_MS = 60_000
const CALLBACK_TTL_MS = 60 * 60_000
const EMOJIS = ['🟢', '🚀', '🔥', '💎', '🐸', '🐉'] as const
const MIN_CHOICES = ['0', '0.1', '0.5', '1', '5', '10'] as const
const STEP_CHOICES = ['0.1', '0.5', '1', '5'] as const
const TEST_SPACING_MS = 30_000

const adminCache = new Map<string, { at: number; ok: boolean }>()
const lastTest = new Map<number, number>()

async function isAdmin(ctx: BotCtx): Promise<boolean> {
  const key = `${ctx.chat.id}:${ctx.user.id}`
  const hit = adminCache.get(key)
  if (hit && ctx.deps.now() - hit.at < ADMIN_TTL_MS) return hit.ok
  const member = await ctx.deps.tg.getChatMember(ctx.chat.id, ctx.user.id).catch(() => null)
  const ok = member?.status === 'creator' || member?.status === 'administrator'
  adminCache.set(key, { at: ctx.deps.now(), ok })
  return ok
}

const near = (yocto: bigint) => formatUnits(yocto, NEAR_DECIMALS, { maxFraction: 4 })
const yocto = (text: string) => parseUnits(text, NEAR_DECIMALS)

function describeConfig(c: BuybotConfig): string {
  const state = c.pausedReason ? `paused (${esc(c.pausedReason)})` : c.enabled ? 'on' : 'off'
  return `• ${bold(c.symbol)}: ${state}, min ${c.minNear === 0n ? 'any size' : `${near(c.minNear)} NEAR`}, ${c.emoji} per ${near(c.stepNear)} NEAR\n  ${code(c.token)}`
}

async function showMenu(ctx: BotCtx, bb: BuybotDeps, note?: string) {
  const configs = bb.store.configsForChat(ctx.chat.id)
  const network = bb.near.ctx.network
  const text = [
    ...(note ? [note, ''] : []),
    bold(`NearKit buybot · ${ctx.chat.title ?? 'this chat'}`),
    `Network: ${esc(network.label)}. Buys are read from final blocks on chain.`,
    '',
    configs.length ? configs.map(describeConfig).join('\n') : 'No token yet. Add one by its exact contract ID.',
  ].join('\n')
  await ctx.show(
    text,
    keyboard(configs.length < MAX_CONFIGS_PER_CHAT ? [btn('➕ Add token', 'bb:add')] : [], ...configs.map((c) => [btn(`⚙️ ${c.symbol}`, `bb:cfg:${c.id}`)]), [
      btn('📊 Status', 'bb:status'),
    ]),
  )
}

async function showConfig(ctx: BotCtx, bb: BuybotDeps, c: BuybotConfig, note?: string) {
  const network = bb.near.ctx.network
  await ctx.show(
    [
      ...(note ? [note, ''] : []),
      `${bold(`${c.symbol}`)} · ${esc(c.name)}`,
      link(explorerTokenUrl(network, c.token), c.token),
      '',
      `Alerts: ${c.pausedReason ? `paused: ${esc(c.pausedReason)}` : c.enabled ? 'on' : 'off'}`,
      `Minimum buy: ${c.minNear === 0n ? 'any size' : `${near(c.minNear)} NEAR`}`,
      `Scale: ${c.emoji} per ${near(c.stepNear)} NEAR (up to 30)`,
      `Sound: ${c.silent ? 'silent' : 'normal'}`,
      '',
      'Buys paid in other tokens are valued at current prices for the minimum and the scale.',
    ].join('\n'),
    keyboard(
      [btn(c.enabled && !c.pausedReason ? '⏸ Pause alerts' : '▶️ Turn alerts on', `bb:toggle:${c.id}`)],
      MIN_CHOICES.map((m) => btn(`${c.minNear === yocto(m) ? '● ' : ''}${m === '0' ? 'Any' : m}`, `bb:min:${c.id}:${m}`)),
      EMOJIS.map((e, i) => btn(`${c.emoji === e ? '●' : ''}${e}`, `bb:emoji:${c.id}:${i}`)),
      STEP_CHOICES.map((s) => btn(`${c.stepNear === yocto(s) ? '● ' : ''}${s}/${c.emoji}`, `bb:step:${c.id}:${s}`)),
      [btn(c.silent ? '🔔 Sound on' : '🔕 Silent', `bb:silent:${c.id}`), btn('🧪 Preview', `bb:test:${c.id}`)],
      [btn('🗑 Remove', `bb:rm:${c.id}`), btn('« Back', 'bb:menu')],
    ),
  )
}

async function showStatus(ctx: BotCtx, bb: BuybotDeps) {
  const network = bb.near.ctx.network.id
  const configs = bb.store.configsForChat(ctx.chat.id)
  const stats = bb.store.stats(
    network,
    configs.map((c) => c.id),
  )
  const cursors = bb.store.tokenCursors(network).filter((c) => configs.some((cfg) => cfg.token === c.token))
  const cursor = cursors.length ? Math.min(...cursors.map((c) => c.height)) : null
  const head = await bb.follower.finalHeight().catch(() => null)
  const lag = head !== null && cursor !== null ? Math.max(0, head - cursor) : null
  await ctx.show(
    [
      bold('Buybot status'),
      '',
      `Network: ${esc(bb.near.ctx.network.label)}`,
      `History read up to block ${cursor !== null ? code(String(cursor)) : '(not started)'}${lag !== null ? `, ${lag} blocks behind the chain (a few by design)` : ''}`,
      `Transactions waiting to be read: ${stats.candidates}`,
      `Alerts here: ${stats.sent} sent, ${stats.pending} waiting, ${stats.failed} failed`,
      `Last buy here: ${stats.lastBuyAt ? formatAgo(stats.lastBuyAt, ctx.deps.now()) : 'none yet'}`,
    ].join('\n'),
    keyboard([btn('« Back', 'bb:menu')]),
  )
}

/** A clearly labelled preview with the token's real name and price, and sample amounts. */
async function sendPreview(ctx: BotCtx, bb: BuybotDeps, c: BuybotConfig) {
  const t = ctx.deps.now()
  if ((lastTest.get(ctx.chat.id) ?? 0) > t - TEST_SPACING_MS) {
    await ctx.answer('One preview every 30 seconds.', true)
    return
  }
  lastTest.set(ctx.chat.id, t)
  const network = bb.near.ctx.network
  const [tokenUsd, nearUsd] = await Promise.all([bb.market.assetUsd(c.token), bb.market.nearUsd()])
  const sampleTokens = tokenUsd && nearUsd ? nearUsd / tokenUsd : 1000
  const amount = BigInt(Math.max(1, Math.floor(sampleTokens))) * 10n ** BigInt(c.decimals)
  await ctx.answer()
  await ctx.reply(
    renderBuy({
      preview: true,
      symbol: c.symbol,
      name: c.name,
      decimals: c.decimals,
      amount,
      paid: [{ text: '1 NEAR' }],
      paidUsd: nearUsd,
      buyer: 'example.near',
      buyerUrl: explorerTokenUrl(network, c.token),
      txUrl: explorerTokenUrl(network, c.token),
      priceUsd: tokenUsd,
      fdvUsd: null,
      emoji: c.emoji,
      emojiCount: 1,
      networkLabel: network.label,
    }),
  )
}

function configOf(ctx: BotCtx, bb: BuybotDeps, id: string): BuybotConfig | null {
  const c = bb.store.config(Number(id))
  return c && c.chatId === ctx.chat.id ? c : null
}

export function buybotModule(): BotModule {
  return {
    commands: {
      buybot: {
        ...documented('buybot'),
        async run(ctx) {
          const bb = ctx.deps.buybot
          if (!bb) {
            await ctx.reply('Buy alerts are switched off on this NearKit server.')
            return
          }
          if (ctx.isPrivate) {
            await ctx.reply(
              `Buy alerts post in a group. Add me to your group (as a member is enough), then send /buybot there as an admin.\n\nNetwork: ${esc(bb.near.ctx.network.label)}.`,
            )
            return
          }
          if (ctx.chat.type === 'channel') return
          if (ctx.user.id === ANONYMOUS_ADMIN) {
            await ctx.reply('I can’t check the permissions of an anonymous admin. Turn off “Remain anonymous” for a moment and send /buybot again.')
            return
          }
          if (!(await isAdmin(ctx))) {
            await ctx.reply('Only admins of this group can set up buy alerts.')
            return
          }
          await showMenu(ctx, bb)
        },
      },
    },
    callbacks: {
      bb: async (ctx, action, arg) => {
        const bb = ctx.deps.buybot
        if (!bb) return ctx.answer('Buy alerts are off on this server.', true)
        if (ctx.isPrivate || !(await isAdmin(ctx))) return ctx.answer('Only admins of this group can change buy alerts.', true)
        const [id = '', value = ''] = arg.split(':')
        switch (action) {
          case 'menu':
            return showMenu(ctx, bb)
          case 'status':
            return showStatus(ctx, bb)
          case 'add': {
            ctx.deps.store.setSession(ctx.chat.id, ctx.user.id, 'buybot.add', {}, FLOW_TTL_MS)
            await ctx.answer()
            await ctx.deps.tg.sendMessage(
              ctx.chat.id,
              `<a href="tg://user?id=${ctx.user.id}">${esc(ctx.user.first_name)}</a>, reply to this message with the token’s exact contract ID (e.g. ${code(bb.near.ctx.network.id === 'mainnet' ? 'token.example.near' : 'token.example.testnet')}).`,
              { reply_markup: { force_reply: true, selective: true, input_field_placeholder: 'token contract' } },
            )
            return
          }
          case 'confirm': {
            const payload = ctx.deps.store.getCallback<{ token: string; symbol: string; name: string; decimals: number }>(id, ctx.user.id)
            if (!payload) return ctx.answer('That button expired. Add the token again.', true)
            if (bb.store.findConfig(ctx.chat.id, bb.near.ctx.network.id, payload.token)) return showMenu(ctx, bb, `${bold(payload.symbol)} is already followed here.`)
            try {
              const c = bb.store.addConfig({ chatId: ctx.chat.id, chatTitle: ctx.chat.title ?? null, network: bb.near.ctx.network.id, ...payload, createdBy: ctx.user.id })
              return showConfig(ctx, bb, c, `✅ Following ${bold(c.symbol)}. Buys from now on are posted here.`)
            } catch (e) {
              return ctx.answer(e instanceof Error ? e.message : 'Could not add the token', true)
            }
          }
        }
        const c = configOf(ctx, bb, id)
        if (!c) return ctx.answer('That token isn’t followed here any more.', true)
        switch (action) {
          case 'cfg':
            return showConfig(ctx, bb, c)
          case 'toggle': {
            const on = !(c.enabled && !c.pausedReason)
            return showConfig(ctx, bb, bb.store.updateConfig(c.id, { enabled: on, pausedReason: null }) as BuybotConfig)
          }
          case 'min': {
            if (!MIN_CHOICES.includes(value as (typeof MIN_CHOICES)[number])) return
            return showConfig(ctx, bb, bb.store.updateConfig(c.id, { minNear: yocto(value) }) as BuybotConfig)
          }
          case 'step': {
            if (!STEP_CHOICES.includes(value as (typeof STEP_CHOICES)[number])) return
            return showConfig(ctx, bb, bb.store.updateConfig(c.id, { stepNear: yocto(value) }) as BuybotConfig)
          }
          case 'emoji': {
            const e = EMOJIS[Number(value)]
            if (!e) return
            return showConfig(ctx, bb, bb.store.updateConfig(c.id, { emoji: e }) as BuybotConfig)
          }
          case 'silent':
            return showConfig(ctx, bb, bb.store.updateConfig(c.id, { silent: !c.silent }) as BuybotConfig)
          case 'test':
            return sendPreview(ctx, bb, c)
          case 'rm':
            return ctx.show(`Stop posting ${bold(c.symbol)} buys here?`, keyboard([btn('🗑 Yes, remove', `bb:rmyes:${c.id}`), btn('Cancel', `bb:cfg:${c.id}`)]))
          case 'rmyes':
            bb.store.removeConfig(c.id)
            return showMenu(ctx, bb, `Removed ${bold(c.symbol)}.`)
        }
      },
    },
    flows: {
      'buybot.add': async (ctx, text) => {
        const bb = ctx.deps.buybot
        if (!bb || ctx.isPrivate || !(await isAdmin(ctx))) return
        const contract = plainText(text, 80).toLowerCase()
        const network = bb.near.ctx.network
        const error = accountIdError(contract)
        if (error || isForeignToNetwork(contract, network.id)) {
          await ctx.reply(`⚠️ ${esc(contract || 'That')} is not a ${esc(network.label.toLowerCase())} contract ID. Reply with the exact contract, or /cancel.`, {
            force_reply: true,
            selective: true,
          })
          return
        }
        ctx.deps.store.clearSession(ctx.chat.id, ctx.user.id)
        let listing
        try {
          listing = await bb.near.tokens.lookupToken(contract)
        } catch (e) {
          await ctx.reply(`⚠️ ${esc(describeError(e).message)}`)
          return
        }
        const supply = await bb.market.totalSupply(contract)
        const id = ctx.deps.store.putCallback(
          { token: listing.id, symbol: listing.symbol, name: listing.name, decimals: listing.decimals },
          ctx.user.id,
          ctx.chat.id,
          CALLBACK_TTL_MS,
        )
        await ctx.reply(
          [
            bold(`Token found on ${network.label.toLowerCase()}`),
            '',
            `Name: ${esc(listing.name)}`,
            `Symbol: ${esc(listing.symbol)}`,
            `Decimals: ${listing.decimals}`,
            `Contract: ${link(explorerTokenUrl(network, listing.id), listing.id)}`,
            ...(supply !== null ? [`Total supply: ${esc(formatUnits(supply, listing.decimals, { maxFraction: 0, group: true }))}`] : []),
            '',
            'Read from the token contract. This proves it is a token, not that it trades anywhere.',
          ].join('\n'),
          keyboard([btn('✅ Post its buys here', `bb:confirm:${id}`), btn('Cancel', 'bb:menu')]),
        )
      },
    },
    async onMembership(deps: BotDeps, u: TgChatMemberUpdated) {
      if (!deps.buybot || u.new_chat_member.user.id !== deps.me.id) return
      const status = u.new_chat_member.status
      if (status === 'left' || status === 'kicked') {
        deps.buybot.store.pauseChat(u.chat.id, 'NearKit was removed from the chat')
        deps.log.info('removed from chat; buy alerts paused', { chat: u.chat.id })
        return
      }
      if ((status === 'member' || status === 'administrator') && (u.old_chat_member.status === 'left' || u.old_chat_member.status === 'kicked')) {
        deps.buybot.store.resumeChat(u.chat.id)
        if (u.chat.type === 'group' || u.chat.type === 'supergroup') {
          await deps.tg
            .sendMessage(u.chat.id, `Hi! I’m the NearKit bot. Admins can set up buy alerts for a NEAR token with /buybot. I never ask for keys or seed phrases.`)
            .catch(() => undefined)
        }
      }
    },
    async onChatMigrated(deps, from, to) {
      deps.buybot?.store.migrateChat(from, to)
    },
  }
}
