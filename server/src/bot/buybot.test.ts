import { describe, expect, it } from 'vitest'
import { buybotModule } from './buybot'
import type { Command } from './context'
import { coreModule } from './core'
import { ALICE, botHarness, GROUP, privateChat } from './testing'

const BOB = { id: 202, is_bot: false, first_name: 'Bob', username: 'bob' }
const TOKEN = 'fresh.nearlytrade.testnet'

async function bot() {
  let list: () => { name: string; command: Command }[] = () => []
  const h = await botHarness({
    buybot: true,
    chain: {
      accounts: { [TOKEN]: { amount: 10n ** 24n, global: 'GlobalToken111' }, 'wallet.testnet': { amount: 10n ** 24n } },
      tokens: { [TOKEN]: { symbol: 'FRESH', name: 'Fresh <Launch>', decimals: 18, boundsMin: 1n, totalSupply: 10n ** 27n } },
    },
    modules: () => [coreModule(() => list(), {}), buybotModule()],
  })
  list = () => h.app.commands()
  h.fake.members.set(`${GROUP.id}:${ALICE.id}`, { status: 'administrator', user: ALICE })
  h.fake.members.set(`${GROUP.id}:${BOB.id}`, { status: 'member', user: BOB })
  return h
}

async function addToken(h: Awaited<ReturnType<typeof bot>>) {
  await h.say('/buybot', ALICE, GROUP)
  await h.press('bb:add', ALICE, GROUP)
  expect(h.fake.calls.at(-1)?.params.reply_markup).toMatchObject({ force_reply: true, selective: true })
  await h.say(TOKEN, ALICE, GROUP)
  const confirm = h.buttons().find((b) => b.text.includes('Post its buys here'))
  await h.press(confirm?.data ?? '', ALICE, GROUP)
  return h.deps.buybot?.store.configsForChat(GROUP.id)[0]
}

describe('/buybot', () => {
  it('explains itself in a private chat', async () => {
    const h = await bot()
    await h.say('/buybot')
    expect(h.last()?.text).toContain('Add me to your group')
  })

  it('refuses members who are not admins', async () => {
    const h = await bot()
    await h.say('/buybot', BOB, GROUP)
    expect(h.last()?.text).toContain('Only admins')
  })

  it('adds a token by exact contract, showing real metadata (escaped) before anything is saved', async () => {
    const h = await bot()
    await h.say('/buybot', ALICE, GROUP)
    expect(h.last()?.text).toContain('No token yet')
    await h.press('bb:add', ALICE, GROUP)
    await h.say(TOKEN, ALICE, GROUP)
    const card = h.last()?.text ?? ''
    expect(card).toContain('Token found on testnet')
    expect(card).toContain('Fresh &lt;Launch&gt;')
    expect(card).toContain('Decimals: 18')
    expect(card).toContain('Total supply: 1,000,000,000')
    expect(card).toContain('not that it trades')
    expect(h.deps.buybot?.store.configsForChat(GROUP.id)).toEqual([])
    const cfg = await addToken(h)
    expect(cfg).toMatchObject({ token: TOKEN, symbol: 'FRESH', decimals: 18, enabled: true, network: 'testnet' })
    expect(h.last()?.text).toContain('Following')
  })

  it('refuses a contract that isn’t a token, and one from the other network', async () => {
    const h = await bot()
    await h.say('/buybot', ALICE, GROUP)
    await h.press('bb:add', ALICE, GROUP)
    await h.say('wallet.testnet', ALICE, GROUP)
    expect(h.last()?.text).toContain('without a contract')
    await h.press('bb:add', ALICE, GROUP)
    await h.say('token.near', ALICE, GROUP)
    expect(h.last()?.text).toContain('is not a testnet contract ID')
  })

  it('changes settings with buttons, only for admins', async () => {
    const h = await bot()
    const cfg = await addToken(h)
    const id = cfg?.id as number
    await h.press(`bb:min:${id}:1`, ALICE, GROUP)
    await h.press(`bb:emoji:${id}:1`, ALICE, GROUP)
    await h.press(`bb:step:${id}:0.5`, ALICE, GROUP)
    await h.press(`bb:silent:${id}`, ALICE, GROUP)
    await h.press(`bb:toggle:${id}`, ALICE, GROUP)
    expect(h.deps.buybot?.store.config(id)).toMatchObject({ minNear: 10n ** 24n, emoji: '🚀', stepNear: 5n * 10n ** 23n, silent: true, enabled: false })
    await h.press(`bb:toggle:${id}`, BOB, GROUP)
    expect(h.deps.buybot?.store.config(id)?.enabled).toBe(false)
    expect(h.fake.calls.at(-1)).toMatchObject({ method: 'answerCallbackQuery', params: { show_alert: true } })
  })

  it('sends a preview that says it is not a real buy', async () => {
    const h = await bot()
    const cfg = await addToken(h)
    await h.press(`bb:test:${cfg?.id}`, ALICE, GROUP)
    expect(h.last()?.text).toContain('Preview')
    expect(h.last()?.text).toContain('not a real buy')
    await h.press(`bb:test:${cfg?.id}`, ALICE, GROUP)
    expect(h.fake.messages().filter((m) => m.text.includes('Preview'))).toHaveLength(1)
  })

  it('removes a token after confirmation', async () => {
    const h = await bot()
    const cfg = await addToken(h)
    await h.press(`bb:rm:${cfg?.id}`, ALICE, GROUP)
    await h.press(`bb:rmyes:${cfg?.id}`, ALICE, GROUP)
    expect(h.deps.buybot?.store.configsForChat(GROUP.id)).toEqual([])
  })

  it('pauses alerts when removed from the group and greets when added back', async () => {
    const h = await bot()
    const cfg = await addToken(h)
    const me = { id: 1111111111, is_bot: true, first_name: 'NearKit' }
    await h.app.handle({
      update_id: 1,
      my_chat_member: { chat: GROUP, from: ALICE, date: 0, old_chat_member: { status: 'member', user: me }, new_chat_member: { status: 'kicked', user: me } },
    })
    expect(h.deps.buybot?.store.config(cfg?.id as number)?.pausedReason).toMatch(/removed/)
    await h.app.handle({
      update_id: 2,
      my_chat_member: { chat: GROUP, from: ALICE, date: 0, old_chat_member: { status: 'left', user: me }, new_chat_member: { status: 'member', user: me } },
    })
    expect(h.deps.buybot?.store.config(cfg?.id as number)?.pausedReason).toBeNull()
    expect(h.last()?.text).toContain('/buybot')
  })

  it('follows the group when it becomes a supergroup', async () => {
    const h = await bot()
    const cfg = await addToken(h)
    await h.app.handle({ update_id: 3, message: { message_id: 1, date: 0, chat: GROUP, migrate_to_chat_id: -1009999 } })
    expect(h.deps.buybot?.store.config(cfg?.id as number)?.chatId).toBe(-1009999)
  })

  it('shows status with the follower’s progress', async () => {
    const h = await bot()
    await addToken(h)
    await h.press('bb:status', ALICE, GROUP)
    expect(h.last()?.text).toContain('Buybot status')
    expect(h.last()?.text).toContain('Alerts here: 0 sent')
  })
})

describe('buybot V2: group commands and per-token settings', () => {
  it('/add with a contract skips the prompt; /list shows what the group follows', async () => {
    const h = await bot()
    await h.say(`/add ${TOKEN}`, ALICE, GROUP)
    expect(h.last()?.text).toContain('Token found on testnet')
    await h.press(h.buttons().find((b) => b.text.includes('Post its buys here'))?.data ?? '', ALICE, GROUP)
    await h.say('/list', ALICE, GROUP)
    expect(h.last()?.text).toContain('<b>FRESH</b> · on · min any size · 🟢 per 1 NEAR')
  })

  it('/pause and /resume switch every alert in the group; /remove offers each token', async () => {
    const h = await bot()
    const cfg = await addToken(h)
    await h.say('/pause', ALICE, GROUP)
    expect(h.last()?.text).toContain('Paused alerts for 1 token')
    expect(h.deps.buybot?.store.config(cfg?.id as number)?.enabled).toBe(false)
    await h.say('/resume', ALICE, GROUP)
    expect(h.deps.buybot?.store.config(cfg?.id as number)?.enabled).toBe(true)
    await h.say('/remove', ALICE, GROUP)
    expect(h.buttons().map((b) => b.text)).toEqual(['🗑 FRESH', 'Keep them all'])
  })

  it('refuses group commands from members who are not admins', async () => {
    const h = await bot()
    await addToken(h)
    await h.say('/pause', BOB, GROUP)
    expect(h.last()?.text).toContain('Only admins')
    await h.say('/add fresh.nearlytrade.testnet', BOB, GROUP)
    expect(h.last()?.text).toContain('Only admins')
  })

  it('a minimum in USD or NEAR, a value per emoji and a cap on emoji', async () => {
    const h = await bot()
    const id = (await addToken(h))?.id as number
    await h.press(`bb:minm:${id}`, ALICE, GROUP)
    expect(h.buttons().map((b) => b.text)).toEqual(expect.arrayContaining(['● NEAR', 'USD']))
    await h.press(`bb:unit:${id}:USD`, ALICE, GROUP)
    await h.press(`bb:minusd:${id}:50`, ALICE, GROUP)
    expect(h.last()?.text).toContain('Now: $50+')
    await h.press(`bb:emom:${id}`, ALICE, GROUP)
    await h.press(`bb:stepusd:${id}:10`, ALICE, GROUP)
    await h.press(`bb:max:${id}:50`, ALICE, GROUP)
    expect(h.deps.buybot?.store.config(id)).toMatchObject({ unit: 'USD', minUsd: 50, stepUsd: 10, maxEmoji: 50 })
    // Values outside the offered choices are ignored.
    await h.press(`bb:minusd:${id}:7`, ALICE, GROUP)
    await h.press(`bb:max:${id}:999`, ALICE, GROUP)
    expect(h.deps.buybot?.store.config(id)).toMatchObject({ minUsd: 50, maxEmoji: 50 })
  })

  it('sells are off until turned on', async () => {
    const h = await bot()
    const id = (await addToken(h))?.id as number
    expect(h.deps.buybot?.store.config(id)?.sells).toBe(false)
    await h.press(`bb:sells:${id}`, ALICE, GROUP)
    expect(h.deps.buybot?.store.config(id)?.sells).toBe(true)
    expect(h.last()?.text).toContain('Sells on')
  })

  it('media: an admin replies with a photo, a GIF or a video; text is refused; the media can be removed', async () => {
    const h = await bot()
    const id = (await addToken(h))?.id as number
    await h.press(`bb:media:${id}`, ALICE, GROUP)
    expect(h.fake.calls.filter((c) => c.method === 'sendMessage').at(-1)?.params.reply_markup).toMatchObject({ force_reply: true })
    await h.say('not a picture', ALICE, GROUP)
    expect(h.last()?.text).toContain('isn’t a photo, GIF or video')
    await h.app.handle({
      update_id: 90,
      message: {
        message_id: 900,
        date: 0,
        chat: GROUP,
        from: ALICE,
        photo: [
          { file_id: 'small', file_unique_id: 's', width: 90, height: 90 },
          { file_id: 'large', file_unique_id: 'l', width: 800, height: 800 },
        ],
      },
    })
    expect(h.deps.buybot?.store.config(id)?.media).toEqual({ kind: 'photo', fileId: 'large' })
    // Previews are spaced 30 s apart per group.
    h.advance(60_000)
    await h.press(`bb:test:${id}`, ALICE, GROUP)
    const preview = h.fake.calls.filter((c) => c.method === 'sendPhoto').at(-1)
    expect(preview).toMatchObject({ method: 'sendPhoto', params: { photo: 'large', parse_mode: 'HTML' } })
    expect(String(preview?.params.caption)).toContain('not a real buy')
    await h.press(`bb:mediarm:${id}`, ALICE, GROUP)
    expect(h.deps.buybot?.store.config(id)?.media).toBeNull()
  })
})

describe('the bot in a private chat keeps its buybot keys out', () => {
  it('ignores buybot buttons pressed in private', async () => {
    const h = await bot()
    await h.press('bb:menu', ALICE, privateChat(ALICE))
    expect(h.fake.calls.at(-1)).toMatchObject({ method: 'answerCallbackQuery' })
  })
})
