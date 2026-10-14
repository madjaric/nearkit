import { describe, expect, it } from 'vitest'
import { botModules, menuCommands } from '../app'
import type { TgChat } from '../telegram/types'
import { ALICE, botHarness } from './testing'

/**
 * Telegram's command menu, as the server publishes it (setMyCommands, per chat type). Telegram shows
 * the list in the order it is sent. Before 2026-10-12 /start wasn't in it at all (it had no
 * description) and the core module's /help and /cancel led, with /bridge, /kits and /community last.
 */

/** What a new or returning user should see first, in this order. */
const FIRST = ['start', 'bridge', 'kits', 'community', 'help', 'accounts', 'link', 'unlink', 'cancel']

/** The trading automation commands, in the menu since 2026-10-14 (before that only in /help). */
const AUTOMATION = ['orders', 'copy', 'snipe', 'dca', 'auto']

/** Every command the private menu had on 2026-10-12 (none may be dropped), plus /start, then automation's. */
const PRIVATE = [
  ...FIRST,
  'settings',
  'buy',
  'sell',
  'quote',
  'token',
  'balance',
  'positions',
  'pnl',
  'buybot',
  'wallet',
  'deposit',
  'withdraw',
  'referral',
  'web',
  'volume',
  ...AUTOMATION,
]

async function fullBot() {
  const h: Awaited<ReturnType<typeof botHarness>> = await botHarness({ custody: true, modules: (deps) => botModules(deps, () => h.app.commands()) })
  return h
}

describe('the command menu Telegram shows', () => {
  it('private chats: /start first, then /bridge, /kits, /community, /help, /accounts, /link, /unlink, /cancel, then every other command as before, then /orders, /copy, /snipe, /dca and /auto', async () => {
    const h = await fullBot()
    const menu = menuCommands(h.app, 'private').map((c) => c.command)
    expect(menu.slice(0, FIRST.length)).toEqual(FIRST)
    expect(menu).toEqual(PRIVATE)
  })

  it('groups: /start, /help and /cancel first, then the buy-alert commands as before; no private-only command', async () => {
    const h = await fullBot()
    expect(menuCommands(h.app, 'group').map((c) => c.command)).toEqual(['start', 'help', 'cancel', 'buybot', 'list', 'add', 'remove', 'pause', 'resume'])
  })

  it('every entry is one Telegram accepts: a 1–32 character name of lowercase letters, digits or _, and a 1–256 character description', async () => {
    const h = await fullBot()
    for (const scope of ['private', 'group'] as const) {
      const menu = menuCommands(h.app, scope)
      expect(menu.length).toBeLessThanOrEqual(100)
      for (const c of menu) {
        expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/)
        expect(c.description.length).toBeGreaterThan(0)
        expect(c.description.length).toBeLessThanOrEqual(256)
      }
      expect(new Set(menu.map((c) => c.command)).size).toBe(menu.length)
    }
    expect(menuCommands(h.app, 'private').find((c) => c.command === 'start')?.description).toMatch(/menu/i)
  })

  it('every command in the private menu answers in a private chat: none is unknown, none fails', async () => {
    const h = await fullBot()
    for (const { command } of menuCommands(h.app, 'private')) {
      // A minute apart, as a person would: the flood limit stays out of it. Each command drops the last one's step.
      h.advance(60_000)
      const before = h.fake.messages().length
      await h.say(`/${command}`)
      const replies = h.fake.messages().slice(before)
      expect(replies.length, `/${command} answered`).toBeGreaterThan(0)
      for (const r of replies) {
        expect(r.text, `/${command}`).not.toContain('I don’t know')
        expect(r.text, `/${command}`).not.toContain('Something went wrong')
      }
    }
  })

  it('/start still opens the home screen in a private chat, and still points a group to /buybot and a private chat', async () => {
    const h = await fullBot()
    await h.say('/start')
    const home = h.last()
    expect(home?.chatId).toBe(ALICE.id)
    // A new user (custody on, no wallet yet): the home screen leads to creating one, with the menu.
    expect(home?.text).toContain('No NEARKITS wallet yet')
    expect(home?.buttons.map((b) => b.text)).toEqual(expect.arrayContaining(['💼 Create wallet', '❓ Help']))
    await h.say('/start', ALICE, { id: -100123, type: 'supergroup', title: 'Group' } as TgChat)
    expect(h.last()?.text).toContain('/buybot')
    expect(h.last()?.buttons.map((b) => b.text)).toContain('Open a private chat')
  })
})
