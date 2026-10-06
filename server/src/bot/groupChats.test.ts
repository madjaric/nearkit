import { describe, expect, it } from 'vitest'
import { ALICE, GROUP } from './testing'
import { tradingWallet } from './tradingWallet'
import { walletBot, ONE } from './walletTesting'

/**
 * A group chat is read by everyone in it. A button pressed there must never draw the presser's
 * private screens into it: their wallet, their deposit address, a one-time link that binds a NEAR
 * account to their Telegram, or a sign-in link. Only the group's own buttons (buy alerts) work there.
 */

const MALLORY = { id: 666, is_bot: false, first_name: 'Mallory', username: 'mallory', language_code: 'en' }

/** Every call that would show something in the group. */
const groupOutput = (h: Awaited<ReturnType<typeof walletBot>>, from: number) =>
  h.fake
    .messages()
    .slice(from)
    .filter((m) => m.chatId === GROUP.id)
const answers = (h: Awaited<ReturnType<typeof walletBot>>) =>
  h.fake.calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => String((c.params as { text?: unknown }).text ?? ''))

describe('group chats', () => {
  it('/help in a group offers a private chat, never the private menu', async () => {
    const h = await walletBot({ link: false })
    await h.say('/help', ALICE, GROUP)
    const m = h.last()
    expect(m?.chatId).toBe(GROUP.id)
    expect(m?.buttons.some((b) => b.data?.startsWith('menu:'))).toBe(false)
    expect(m?.buttons.some((b) => b.url === 'https://t.me/NearKitBot')).toBe(true)
  })

  it('« Menu, Link wallet and the sign-in button pressed in a group show nothing there and issue no code', async () => {
    const h = await walletBot({ link: false })
    await h.say('/help', ALICE, GROUP)
    const before = h.fake.messages().length
    for (const data of [
      'menu:home',
      'menu:wallet',
      'menu:help',
      'acct:link',
      'acct:list',
      'web:open',
      'cw:home',
      'cw:create',
      'cw:dep',
      'cr:show',
      'pf:positions',
      'set:show',
      'ref:show',
    ])
      await h.press(data, ALICE, GROUP, 42)
    expect(groupOutput(h, before)).toHaveLength(0)
    expect(h.fake.messages().some((m) => /#(link|login)=/.test(JSON.stringify(m)))).toBe(false)
    expect((await h.store.counts()).linkRequests).toBe(0)
    expect((await h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM web_login_codes'))?.n).toBe(0)
    expect(await tradingWallet(h.deps, ALICE.id)).toBeNull()
    expect(answers(h).at(-1)).toMatch(/private chat/)
  })

  it('a group message is never redrawn as someone’s wallet or deposit address', async () => {
    const h = await walletBot()
    await h.funded(3n * ONE)
    await h.say('/start', MALLORY)
    await h.press('cw:create', MALLORY)
    expect(await tradingWallet(h.deps, MALLORY.id)).not.toBeNull()
    const before = h.fake.messages().length
    await h.press('menu:wallet', ALICE, GROUP, 42)
    await h.press('cw:dep', MALLORY, GROUP, 42)
    expect(groupOutput(h, before)).toHaveLength(0)
  })

  it('the same buttons still work in a private chat', async () => {
    const h = await walletBot({ link: false })
    await h.press('acct:link')
    expect(h.last()?.chatId).toBe(ALICE.id)
    expect(h.last()?.buttons.some((b) => b.url?.includes('#link='))).toBe(true)
  })
})
