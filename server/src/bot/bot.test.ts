import { describe, expect, it } from 'vitest'
import { accountsModule } from './accounts'
import { coreModule } from './core'
import { settingsModule, parseBuyPresets, parseSellPresets, parseSlippage } from './settings'
import { ALICE, botHarness, GROUP, privateChat } from './testing'
import type { BotModule } from './context'

const BOB = { id: 202, is_bot: false, first_name: 'Bob', username: 'bob' }

async function bot(extra: BotModule[] = []) {
  let list: () => { name: string; command: import('./context').Command }[] = () => []
  const h = await botHarness({
    modules: () => [coreModule(() => list(), {}), accountsModule(), settingsModule(), ...extra],
  })
  list = () => h.app.commands()
  return h
}

describe('onboarding', () => {
  it('/start is short: NearKit, the wallet (none yet), the network and the no-seed-phrase rule, then the menu', async () => {
    const h = await bot()
    await h.say('/start')
    const m = h.last()
    expect(m?.chatId).toBe(ALICE.id)
    expect(m?.text).toContain('<b>NearKit</b> · NEAR trading')
    expect(m?.text).toContain('No wallet linked yet')
    expect(m?.text).toContain('Testnet beta')
    expect(m?.text).toMatch(/never asks for your seed phrase/)
    expect(m?.text.split('\n').length).toBeLessThanOrEqual(5)
    expect(m?.buttons[0]?.text).toBe('🔗 Link wallet')
    expect(m?.buttons.map((b) => b.text)).toEqual(expect.arrayContaining(['⚙️ Settings', '❓ Help']))
    // Features that don't exist in this bot are not offered.
    expect(m?.buttons.map((b) => b.text)).not.toContain('🟢 Buy')
    expect((await h.store.getUser(ALICE.id))?.firstName).toBe('Alice')
  })

  it('never echoes the user’s name, so nothing a name carries reaches the chat', async () => {
    const h = await bot()
    await h.say('/start', { ...ALICE, first_name: '<b>Eve</b>' })
    expect(h.last()?.text).not.toContain('Eve')
  })

  it('/help lists the commands this bot really has', async () => {
    const h = await bot()
    await h.say('/help')
    const text = h.last()?.text ?? ''
    expect(text).toContain('/link')
    expect(text).toContain('/settings')
    expect(text).not.toContain('/buy')
    expect(text).toContain('No NearKit fee on testnet')
    expect(text).toMatch(/never asks for your seed phrase/)
  })

  it('ignores commands meant for another bot and answers unknown ones', async () => {
    const h = await bot()
    await h.say('/start@SomeOtherBot')
    expect(h.fake.messages()).toHaveLength(0)
    await h.say('/frobnicate')
    expect(h.last()?.text).toContain('I don’t know /frobnicate')
  })

  it('keeps private commands out of groups', async () => {
    const h = await bot()
    await h.say('/link', ALICE, GROUP)
    const m = h.last()
    expect(m?.chatId).toBe(GROUP.id)
    expect(m?.text).toContain('works in a private chat')
    expect(m?.buttons[0]?.url).toBe('https://t.me/NearKitBot?start=link')
    expect((await h.store.counts()).linkRequests).toBe(0)
  })
})

describe('linking', () => {
  it('/link sends a one-time link to the NearKit web app, never the code in text', async () => {
    const h = await bot()
    await h.say('/link')
    const m = h.last()
    const url = m?.buttons[0]?.url ?? ''
    expect(url).toMatch(/^https:\/\/nearkit\.vercel\.app\/telegram#link=[A-Za-z0-9_-]{22}$/)
    const code = url.split('#link=')[1] as string
    expect(m?.text).not.toContain(code)
    expect(m?.text).toContain('expires in 10 minutes')
    expect((await h.store.counts()).linkRequests).toBe(1)
  })

  it('shows linked accounts, switches the default and unlinks after a confirmation', async () => {
    const h = await bot()
    await h.store.upsertUser({ userId: ALICE.id, username: 'alice', firstName: 'Alice', languageCode: null })
    for (const [code, account] of [
      ['h1', 'alice.testnet'],
      ['h2', 'alice2.testnet'],
    ] as const) {
      await h.store.createLinkRequest({ codeHash: code, userId: ALICE.id, network: 'testnet', nonce: 'n', message: 'm', ttlMs: 60_000 })
      await h.store.completeLink({ codeHash: code, network: 'testnet', accountId: account, userId: ALICE.id, publicKey: 'ed25519:K' })
    }
    await h.store.updateSettings(ALICE.id, { defaultAccount: 'alice.testnet' })

    await h.say('/accounts')
    expect(h.last()?.text).toContain('⭐ ')
    const makeDefault = h.buttons().find((b) => b.text.startsWith('⭐ Make'))
    await h.press(makeDefault?.data ?? '')
    expect((await h.store.getSettings(ALICE.id)).defaultAccount).toBe('alice2.testnet')

    await h.say('/unlink')
    const pick = h.buttons().find((b) => b.text.includes('alice.testnet'))
    await h.press(pick?.data ?? '')
    expect(h.last()?.text).toContain('Unlink <code>alice.testnet</code>')
    const yes = h.buttons().find((b) => b.text.includes('Yes, unlink'))
    await h.press(yes?.data ?? '')
    expect((await h.store.linksOf(ALICE.id, 'testnet')).map((l) => l.accountId)).toEqual(['alice2.testnet'])
  })

  it('refuses another user’s buttons', async () => {
    const h = await bot()
    await h.store.upsertUser({ userId: ALICE.id, username: 'alice', firstName: 'Alice', languageCode: null })
    await h.store.createLinkRequest({ codeHash: 'h1', userId: ALICE.id, network: 'testnet', nonce: 'n', message: 'm', ttlMs: 60_000 })
    await h.store.completeLink({ codeHash: 'h1', network: 'testnet', accountId: 'alice.testnet', userId: ALICE.id, publicKey: 'ed25519:K' })
    await h.say('/unlink')
    const pick = h.buttons().find((b) => b.text.includes('alice.testnet'))
    // Bob replays Alice's button data in his own chat.
    const confirm = pick?.data?.replace('acct:ask:', 'acct:do:') ?? ''
    await h.press(confirm, BOB, privateChat(BOB))
    expect(await h.store.linksOf(ALICE.id, 'testnet')).toHaveLength(1)
  })
})

describe('settings', () => {
  it('saves slippage from a button and from typed input, and validates it', async () => {
    const h = await bot()
    await h.say('/settings')
    await h.press('set:slip:3')
    expect((await h.store.getSettings(ALICE.id)).slippagePct).toBe(3)
    await h.press('set:slip:custom')
    await h.say('abc')
    expect(h.last()?.text).toContain('is not a slippage')
    await h.say('0.8%')
    expect((await h.store.getSettings(ALICE.id)).slippagePct).toBe(0.8)
    expect(h.last()?.text).toContain('Slippage set to 0.8%')
  })

  it('saves buy amounts and survives /cancel', async () => {
    const h = await bot()
    await h.press('set:presets:buy')
    await h.say('/cancel')
    await h.say('0.3')
    expect((await h.store.getSettings(ALICE.id)).buyPresets).toEqual(['0.1', '0.5', '1', '5'])
    await h.press('set:presets:buy')
    await h.say('0.25 2 10')
    expect((await h.store.getSettings(ALICE.id)).buyPresets).toEqual(['0.25', '2', '10'])
  })

  it('shows trading and wallet settings in one place', async () => {
    const h = await bot()
    await h.say('/settings')
    const text = h.last()?.text ?? ''
    expect(text).toContain('<b>Trading</b>')
    expect(text).toContain('Slippage <code>1%</code>')
    expect(text).toContain('Buy buttons <code>0.1</code> <code>0.5</code> <code>1</code> <code>5</code> NEAR')
    expect(text).toContain('Sell buttons <code>25%</code> <code>50%</code> <code>75%</code> <code>100%</code>')
    expect(text).toContain('<b>Wallet</b>')
    expect(text).toContain('/buybot')
  })

  it('saves sell buttons, sorted, and refuses what is not a percentage', async () => {
    const h = await bot()
    await h.press('set:presets:sell')
    await h.say('150')
    expect(h.last()?.text).toContain('is not a whole percentage')
    await h.say('100 10 33')
    expect((await h.store.getSettings(ALICE.id)).sellPresets).toEqual([10, 33, 100])
    expect(h.last()?.text).toContain('Sell buttons saved')
  })

  it('toggles notifications', async () => {
    const h = await bot()
    await h.press('set:notify:toggle')
    expect((await h.store.getSettings(ALICE.id)).notifyTrades).toBe(false)
  })

  it('parses slippage and buy amounts strictly', () => {
    expect(parseSlippage('1')).toBe(1)
    expect(parseSlippage('0,5')).toBe(0.5)
    expect(parseSlippage('0')).toBeNull()
    expect(parseSlippage('51')).toBeNull()
    expect(parseSlippage('1e1')).toBeNull()
    expect(parseBuyPresets('0.1, 1; 01')).toEqual({ ok: true, value: ['0.1', '1'] })
    expect(parseBuyPresets('0').ok).toBe(false)
    expect(parseBuyPresets('1 2 3 4 5 6 7').ok).toBe(false)
    expect(parseBuyPresets('0.0000000000000000000000001').ok).toBe(false)
    expect(parseSellPresets('50%, 25')).toEqual({ ok: true, value: [25, 50] })
    expect(parseSellPresets('0').ok).toBe(false)
    expect(parseSellPresets('1 2 3 4 5').ok).toBe(false)
    expect(parseSellPresets('12.5').ok).toBe(false)
  })
})

describe('robustness', () => {
  it('an update Telegram delivers twice (a retry, a re-read after a restart) is handled once', async () => {
    const h = await bot()
    const update = h.fake.push({
      message: { message_id: 7, date: 0, chat: privateChat(ALICE), from: ALICE, text: '/help', entities: [{ type: 'bot_command', offset: 0, length: 5 }] },
    })
    await h.app.handle(update)
    await h.app.handle(update)
    await h.app.handle({ ...update })
    expect(h.fake.messages().filter((m) => m.text.includes('/help') || m.text.length > 0)).toHaveLength(1)
  })

  it('drops floods from one user and says so once', async () => {
    const h = await bot()
    for (let i = 0; i < 25; i++) await h.say('/help')
    const texts = h.fake.messages().map((m) => m.text)
    expect(texts.filter((t) => t.includes('Too many requests'))).toHaveLength(1)
    expect(texts.length).toBeLessThan(25)
  })

  it('answers a failing handler with a plain message and keeps running', async () => {
    const h = await bot([
      {
        commands: {
          boom: {
            scope: 'any',
            run: async () => {
              throw new Error('database exploded')
            },
          },
        },
      },
    ])
    await h.say('/boom')
    expect(h.last()?.text).toContain('Something went wrong on NearKit’s side')
    expect(h.last()?.text).not.toContain('database exploded')
    await h.say('/help')
    expect(h.last()?.text).toContain('NearKit · help')
  })

  it('stops messaging a user who blocked the bot', async () => {
    const h = await bot()
    await h.say('/start')
    h.fake.failNext('sendMessage', { code: 403, description: 'Forbidden: bot was blocked by the user' })
    await h.say('/help')
    expect((await h.store.getUser(ALICE.id))?.blockedAt).not.toBeNull()
    expect(await h.app.notify(ALICE.id, 'hello')).toBe(false)
  })
})
