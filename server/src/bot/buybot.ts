import { NEAR_DECIMALS } from '@/config/networks'
import { formatUnits, parseUnits } from '@/lib/amounts'
import { formatAgo, formatUsd } from '@/lib/format'
import { accountIdError, isForeignToNetwork } from '@/lib/validation'
import { explorerTokenUrl } from '@/services/near/explorer'
import { renderBuy } from '../buybot/format'
import { MAX_CONFIGS_PER_CHAT, type BuybotConfig, type MediaKind } from '../buybot/store'
import { bold, code, esc, link, plainText } from '../telegram/html'
import type { TgChatMemberUpdated, TgMessage } from '../telegram/types'
import { btn, documented, FLOW_TTL_MS, keyboard, type BotCtx, type BotDeps, type BotModule, type BuybotDeps } from './context'
import { friendlyError } from './ui'

/**
 * Buy alerts in groups. Admins choose tokens (/add or /buybot), then per token: the
 * minimum trade in NEAR or USD, the emoji and how much value each one stands for, a
 * cap on emoji, a photo/GIF/video, sells on or off, sound. /pause and /resume stop
 * and restart every alert in the group; /list shows them; /remove drops a token.
 * Every command and button re-checks that the sender is an admin of that chat. With
 * privacy mode on, the bot reads an admin's answer through a reply to its own prompt.
 */

const ANONYMOUS_ADMIN = 1087968824
const ADMIN_TTL_MS = 60_000
const CALLBACK_TTL_MS = 60 * 60_000
const EMOJIS = ['🟢', '🚀', '🔥', '💎', '🐸', '🐉'] as const
const MIN_NEAR = ['0', '0.1', '0.5', '1', '5', '10'] as const
const MIN_USD = [0, 10, 50, 100, 500, 1000] as const
const STEP_NEAR = ['0.1', '0.5', '1', '5'] as const
const STEP_USD = [5, 10, 50, 100] as const
const MAX_EMOJI = [10, 20, 30, 50] as const
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
const usd = (v: number) => formatUsd(v, { decimals: 0 })

function minimumText(c: BuybotConfig): string {
  if (c.unit === 'USD') return c.minUsd <= 0 ? 'any size' : `${usd(c.minUsd)}+`
  return c.minNear === 0n ? 'any size' : `${near(c.minNear)} NEAR+`
}
const stepText = (c: BuybotConfig) => (c.unit === 'USD' ? usd(c.stepUsd) : `${near(c.stepNear)} NEAR`)
const stateText = (c: BuybotConfig) => (c.pausedReason ? `paused (${esc(c.pausedReason)})` : c.enabled ? 'on' : 'paused')
const MEDIA_NAME: Record<MediaKind, string> = { photo: 'photo', animation: 'GIF', video: 'video' }

function describeConfig(c: BuybotConfig): string {
  return `• ${bold(c.symbol)} · ${stateText(c)} · min ${esc(minimumText(c))} · ${c.emoji} per ${esc(stepText(c))}${c.sells ? ' · sells on' : ''}\n  ${code(c.token)}`
}

async function showMenu(ctx: BotCtx, bb: BuybotDeps, note?: string) {
  const configs = await bb.store.configsForChat(ctx.chat.id)
  const anyOn = configs.some((c) => c.enabled && !c.pausedReason)
  await ctx.show(
    [
      ...(note ? [note, ''] : []),
      `📣 ${bold('Buy alerts')} · ${esc(ctx.chat.title ?? 'this chat')}`,
      `${esc(bb.near.ctx.network.label)} · read from final blocks`,
      '',
      configs.length ? configs.map(describeConfig).join('\n') : 'No token yet. Add one by its exact contract ID.',
    ].join('\n'),
    keyboard(configs.length < MAX_CONFIGS_PER_CHAT ? [btn('➕ Add token', 'bb:add')] : [], ...configs.map((c) => [btn(`⚙️ ${c.symbol}`, `bb:cfg:${c.id}`)]), [
      ...(configs.length ? [anyOn ? btn('⏸ Pause all', 'bb:pauseall') : btn('▶️ Resume all', 'bb:resumeall')] : []),
      btn('📊 Status', 'bb:status'),
    ]),
  )
}

async function showConfig(ctx: BotCtx, bb: BuybotDeps, c: BuybotConfig, note?: string) {
  const on = c.enabled && !c.pausedReason
  await ctx.show(
    [
      ...(note ? [note, ''] : []),
      `⚙️ ${bold(c.symbol)} · ${esc(c.name)} · alerts ${stateText(c)}`,
      link(explorerTokenUrl(bb.near.ctx.network, c.token), c.token),
      '',
      `Minimum ${esc(minimumText(c))}`,
      `Emoji ${c.emoji} per ${esc(stepText(c))} · max ${c.maxEmoji}`,
      `Sells ${c.sells ? 'on' : 'off'}`,
      `Media ${c.media ? MEDIA_NAME[c.media.kind] : 'none'}`,
      `Sound ${c.silent ? 'off' : 'on'}`,
    ].join('\n'),
    keyboard(
      [btn(on ? '⏸ Pause' : '▶️ Resume', `bb:toggle:${c.id}`)],
      [btn('💰 Minimum', `bb:minm:${c.id}`), btn('😀 Emoji', `bb:emom:${c.id}`)],
      [btn(c.sells ? '📉 Sells: on' : '📉 Sells: off', `bb:sells:${c.id}`), btn('🖼 Media', `bb:media:${c.id}`)],
      [btn(c.silent ? '🔔 Sound on' : '🔕 Silent', `bb:silent:${c.id}`), btn('🧪 Preview', `bb:test:${c.id}`)],
      [btn('🗑 Remove', `bb:rm:${c.id}`), btn('« Back', 'bb:menu')],
    ),
  )
}

async function showMinimum(ctx: BotCtx, c: BuybotConfig) {
  const nearRow = MIN_NEAR.map((m) => btn(`${c.unit === 'NEAR' && c.minNear === yocto(m) ? '● ' : ''}${m === '0' ? 'Any' : m}`, `bb:min:${c.id}:${m}`))
  const usdRow = MIN_USD.map((m) => btn(`${c.unit === 'USD' && c.minUsd === m ? '● ' : ''}${m === 0 ? 'Any' : usd(m)}`, `bb:minusd:${c.id}:${m}`))
  await ctx.show(
    [
      `💰 ${bold(`Minimum for ${c.symbol} alerts`)}`,
      '',
      `Now: ${esc(minimumText(c))}. Smaller trades aren’t posted.`,
      c.unit === 'USD' ? 'In USD: a trade whose USD value isn’t known is posted only with Any.' : 'In NEAR: trades paid in other tokens are valued at current prices.',
    ].join('\n'),
    keyboard(
      [btn(`${c.unit === 'NEAR' ? '● ' : ''}NEAR`, `bb:unit:${c.id}:NEAR`), btn(`${c.unit === 'USD' ? '● ' : ''}USD`, `bb:unit:${c.id}:USD`)],
      c.unit === 'USD' ? usdRow : nearRow,
      [btn('« Back', `bb:cfg:${c.id}`)],
    ),
  )
}

async function showEmoji(ctx: BotCtx, c: BuybotConfig) {
  const steps =
    c.unit === 'USD'
      ? STEP_USD.map((s) => btn(`${c.stepUsd === s ? '● ' : ''}${usd(s)}`, `bb:stepusd:${c.id}:${s}`))
      : STEP_NEAR.map((s) => btn(`${c.stepNear === yocto(s) ? '● ' : ''}${s}`, `bb:step:${c.id}:${s}`))
  await ctx.show(
    [`😀 ${bold(`Emoji for ${c.symbol} alerts`)}`, '', `One ${c.emoji} per ${esc(stepText(c))} of value, up to ${c.maxEmoji}.`].join('\n'),
    keyboard(
      EMOJIS.map((e, i) => btn(`${c.emoji === e ? '●' : ''}${e}`, `bb:emoji:${c.id}:${i}`)),
      steps,
      MAX_EMOJI.map((m) => btn(`${c.maxEmoji === m ? '● ' : ''}max ${m}`, `bb:max:${c.id}:${m}`)),
      [btn('« Back', `bb:cfg:${c.id}`)],
    ),
  )
}

async function askMedia(ctx: BotCtx, c: BuybotConfig) {
  await ctx.deps.store.setSession(ctx.chat.id, ctx.user.id, 'buybot.media', { configId: c.id }, FLOW_TTL_MS)
  await ctx.deps.tg.sendMessage(
    ctx.chat.id,
    `<a href="tg://user?id=${ctx.user.id}">${esc(ctx.user.first_name)}</a>, reply to this message with a photo, GIF or short video for ${bold(c.symbol)} alerts. /cancel to keep ${c.media ? 'the current one' : 'none'}.`,
    { reply_markup: { force_reply: true, selective: true, input_field_placeholder: 'photo, GIF or video' } },
  )
  if (c.media) await ctx.reply(`${bold(c.symbol)} alerts post a ${MEDIA_NAME[c.media.kind]} now.`, keyboard([btn('🗑 Remove media', `bb:mediarm:${c.id}`)]))
}

async function showStatus(ctx: BotCtx, bb: BuybotDeps) {
  const network = bb.near.ctx.network.id
  const configs = await bb.store.configsForChat(ctx.chat.id)
  const stats = await bb.store.stats(
    network,
    configs.map((c) => c.id),
  )
  const cursors = (await bb.store.tokenCursors(network)).filter((c) => configs.some((cfg) => cfg.token === c.token))
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
  const html = renderBuy({
    preview: true,
    side: 'buy',
    symbol: c.symbol,
    name: c.name,
    token: c.token,
    decimals: c.decimals,
    amount,
    paid: [{ text: '1 NEAR' }],
    paidUsd: nearUsd,
    valueNear: 10n ** 24n,
    paidInNear: true,
    buyer: 'example.near',
    buyerUrl: explorerTokenUrl(network, c.token),
    txUrl: explorerTokenUrl(network, c.token),
    priceUsd: tokenUsd,
    marketCapUsd: null,
    fdvUsd: null,
    holders: null,
    emoji: c.emoji,
    emojiCount: 1,
    networkLabel: network.label,
  })
  if (c.media) await ctx.deps.tg.sendMedia(ctx.chat.id, c.media.kind, c.media.fileId, html)
  else await ctx.reply(html)
}

async function configOf(ctx: BotCtx, bb: BuybotDeps, id: string): Promise<BuybotConfig | null> {
  const c = await bb.store.config(Number(id))
  return c && c.chatId === ctx.chat.id ? c : null
}

/** A group command: only an identifiable admin of this group gets through. */
async function groupAdmin(ctx: BotCtx): Promise<BuybotDeps | null> {
  const bb = ctx.deps.buybot
  if (!bb) {
    await ctx.reply('Buy alerts are switched off on this NearKit server.')
    return null
  }
  if (ctx.isPrivate) {
    await ctx.reply(`Buy alerts post in a group. Add me to your group (as a member is enough), then send /buybot there as an admin.\n\nNetwork: ${esc(bb.near.ctx.network.label)}.`)
    return null
  }
  if (ctx.chat.type === 'channel') return null
  if (ctx.user.id === ANONYMOUS_ADMIN) {
    await ctx.reply('I can’t check the permissions of an anonymous admin. Turn off “Remain anonymous” for a moment and try again.')
    return null
  }
  if (!(await isAdmin(ctx))) {
    await ctx.reply('Only admins of this group can set up buy alerts.')
    return null
  }
  return bb
}

async function askToken(ctx: BotCtx, bb: BuybotDeps) {
  await ctx.deps.store.setSession(ctx.chat.id, ctx.user.id, 'buybot.add', {}, FLOW_TTL_MS)
  await ctx.deps.tg.sendMessage(
    ctx.chat.id,
    `<a href="tg://user?id=${ctx.user.id}">${esc(ctx.user.first_name)}</a>, reply to this message with the token’s exact contract ID (e.g. ${code(bb.near.ctx.network.id === 'mainnet' ? 'token.example.near' : 'token.example.testnet')}).`,
    { reply_markup: { force_reply: true, selective: true, input_field_placeholder: 'token contract' } },
  )
}

async function setAll(ctx: BotCtx, bb: BuybotDeps, on: boolean) {
  const n = await bb.store.setChatEnabled(ctx.chat.id, on)
  return n ? `${on ? '▶️ Resumed' : '⏸ Paused'} alerts for ${n} ${n === 1 ? 'token' : 'tokens'}.` : 'No token is followed here yet.'
}

export function buybotModule(): BotModule {
  return {
    commands: {
      buybot: { ...documented('buybot'), run: async (ctx) => void ((await groupAdmin(ctx)) && (await showMenu(ctx, ctx.deps.buybot as BuybotDeps))) },
      list: { ...documented('list'), run: async (ctx) => void ((await groupAdmin(ctx)) && (await showMenu(ctx, ctx.deps.buybot as BuybotDeps))) },
      add: {
        ...documented('add'),
        run: async (ctx, args) => {
          const bb = await groupAdmin(ctx)
          if (!bb) return
          if ((await bb.store.configsForChat(ctx.chat.id)).length >= MAX_CONFIGS_PER_CHAT)
            return void (await ctx.reply(`A group can follow at most ${MAX_CONFIGS_PER_CHAT} tokens.`))
          // "/add token.near" skips the prompt.
          if (plainText(args, 80)) return addFlow(ctx, args)
          await askToken(ctx, bb)
        },
      },
      remove: {
        ...documented('remove'),
        run: async (ctx) => {
          const bb = await groupAdmin(ctx)
          if (!bb) return
          const configs = await bb.store.configsForChat(ctx.chat.id)
          if (!configs.length) return void (await ctx.reply('No token is followed here.'))
          await ctx.reply('Which token should stop posting here?', keyboard(...configs.map((c) => [btn(`🗑 ${c.symbol}`, `bb:rm:${c.id}`)]), [btn('Keep them all', 'bb:menu')]))
        },
      },
      pause: {
        ...documented('pause'),
        run: async (ctx) => {
          const bb = await groupAdmin(ctx)
          if (bb) await ctx.reply(await setAll(ctx, bb, false))
        },
      },
      resume: {
        ...documented('resume'),
        run: async (ctx) => {
          const bb = await groupAdmin(ctx)
          if (bb) await ctx.reply(await setAll(ctx, bb, true))
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
          case 'pauseall':
          case 'resumeall':
            return showMenu(ctx, bb, await setAll(ctx, bb, action === 'resumeall'))
          case 'add':
            await ctx.answer()
            return askToken(ctx, bb)
          case 'confirm': {
            const payload = await ctx.deps.store.getCallback<{ token: string; symbol: string; name: string; decimals: number }>(id, ctx.user.id)
            if (!payload) return ctx.answer('That button expired. Add the token again.', true)
            if (await bb.store.findConfig(ctx.chat.id, bb.near.ctx.network.id, payload.token)) return showMenu(ctx, bb, `${bold(payload.symbol)} is already followed here.`)
            try {
              const c = await bb.store.addConfig({ chatId: ctx.chat.id, chatTitle: ctx.chat.title ?? null, network: bb.near.ctx.network.id, ...payload, createdBy: ctx.user.id })
              return showConfig(ctx, bb, c, `✅ Following ${bold(c.symbol)}. Buys from now on are posted here.`)
            } catch (e) {
              return ctx.answer(e instanceof Error ? e.message : 'Could not add the token', true)
            }
          }
        }
        const c = await configOf(ctx, bb, id)
        if (!c) return ctx.answer('That token isn’t followed here any more.', true)
        const update = async (patch: Parameters<typeof bb.store.updateConfig>[1]) => (await bb.store.updateConfig(c.id, patch)) as BuybotConfig
        switch (action) {
          case 'cfg':
            return showConfig(ctx, bb, c)
          case 'toggle': {
            const on = !(c.enabled && !c.pausedReason)
            return showConfig(ctx, bb, await update({ enabled: on, pausedReason: null }))
          }
          case 'minm':
            return showMinimum(ctx, c)
          case 'emom':
            return showEmoji(ctx, c)
          case 'unit':
            if (value !== 'NEAR' && value !== 'USD') return
            return showMinimum(ctx, await update({ unit: value }))
          case 'min':
            if (!MIN_NEAR.includes(value as (typeof MIN_NEAR)[number])) return
            return showMinimum(ctx, await update({ unit: 'NEAR', minNear: yocto(value) }))
          case 'minusd': {
            const v = Number(value)
            if (!MIN_USD.includes(v as (typeof MIN_USD)[number])) return
            return showMinimum(ctx, await update({ unit: 'USD', minUsd: v }))
          }
          case 'step':
            if (!STEP_NEAR.includes(value as (typeof STEP_NEAR)[number])) return
            return showEmoji(ctx, await update({ stepNear: yocto(value) }))
          case 'stepusd': {
            const v = Number(value)
            if (!STEP_USD.includes(v as (typeof STEP_USD)[number])) return
            return showEmoji(ctx, await update({ stepUsd: v }))
          }
          case 'max': {
            const v = Number(value)
            if (!MAX_EMOJI.includes(v as (typeof MAX_EMOJI)[number])) return
            return showEmoji(ctx, await update({ maxEmoji: v }))
          }
          case 'emoji': {
            const e = EMOJIS[Number(value)]
            if (!e) return
            return showEmoji(ctx, await update({ emoji: e }))
          }
          case 'sells':
            return showConfig(ctx, bb, await update({ sells: !c.sells }))
          case 'silent':
            return showConfig(ctx, bb, await update({ silent: !c.silent }))
          case 'media':
            await ctx.answer()
            return askMedia(ctx, c)
          case 'mediarm':
            return showConfig(ctx, bb, await update({ media: null }), `${bold(c.symbol)} alerts post text only now.`)
          case 'test':
            return sendPreview(ctx, bb, c)
          case 'rm':
            return ctx.show(`Stop posting ${bold(c.symbol)} alerts here?`, keyboard([btn('🗑 Yes, remove', `bb:rmyes:${c.id}`), btn('Cancel', `bb:cfg:${c.id}`)]))
          case 'rmyes':
            await bb.store.removeConfig(c.id)
            return showMenu(ctx, bb, `Removed ${bold(c.symbol)}.`)
        }
      },
    },
    flows: {
      'buybot.add': (ctx, text) => addFlow(ctx, text),
      'buybot.media': async (ctx, _text, data, message) => {
        const bb = ctx.deps.buybot
        if (!bb || ctx.isPrivate || !(await isAdmin(ctx))) return
        const c = await configOf(ctx, bb, String((data as { configId?: number }).configId ?? ''))
        if (!c) return
        const media = mediaOf(message)
        if (!media) {
          await ctx.reply('That isn’t a photo, GIF or video. Reply with one, or /cancel.', { force_reply: true, selective: true })
          return
        }
        await ctx.deps.store.clearSession(ctx.chat.id, ctx.user.id)
        await showConfig(ctx, bb, (await bb.store.updateConfig(c.id, { media })) as BuybotConfig, `✅ ${bold(c.symbol)} alerts now come with this ${MEDIA_NAME[media.kind]}.`)
      },
    },
    async onMembership(deps: BotDeps, u: TgChatMemberUpdated) {
      if (!deps.buybot || u.new_chat_member.user.id !== deps.me.id) return
      const status = u.new_chat_member.status
      if (status === 'left' || status === 'kicked') {
        await deps.buybot.store.pauseChat(u.chat.id, 'NearKit was removed from the chat')
        deps.log.info('removed from chat; buy alerts paused', { chat: u.chat.id })
        return
      }
      if ((status === 'member' || status === 'administrator') && (u.old_chat_member.status === 'left' || u.old_chat_member.status === 'kicked')) {
        await deps.buybot.store.resumeChat(u.chat.id)
        if (u.chat.type === 'group' || u.chat.type === 'supergroup') {
          await deps.tg
            .sendMessage(u.chat.id, `Hi! I’m the NearKit bot. Admins can set up buy alerts for a NEAR token with /buybot or /add. I never ask for keys or seed phrases.`)
            .catch(() => undefined)
        }
      }
    },
    async onChatMigrated(deps, from, to) {
      await deps.buybot?.store.migrateChat(from, to)
    },
  }
}

/** The biggest photo, or the GIF or video, an admin replied with. */
function mediaOf(message: TgMessage | undefined): { kind: MediaKind; fileId: string } | null {
  if (!message) return null
  if (message.animation) return { kind: 'animation', fileId: message.animation.file_id }
  if (message.video) return { kind: 'video', fileId: message.video.file_id }
  const photo = message.photo?.at(-1)
  return photo ? { kind: 'photo', fileId: photo.file_id } : null
}

/** Reads a token by its exact contract and asks the admin to confirm before anything is saved. */
async function addFlow(ctx: BotCtx, text: string) {
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
  await ctx.deps.store.clearSession(ctx.chat.id, ctx.user.id)
  let listing
  try {
    listing = await bb.near.tokens.lookupToken(contract)
  } catch (e) {
    await ctx.reply(`⚠️ ${esc(friendlyError(e, { network: network.id, log: ctx.deps.log, context: 'buybot token lookup failed' }))}`)
    return
  }
  const supply = await bb.market.totalSupply(contract)
  const id = await ctx.deps.store.putCallback(
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
}
