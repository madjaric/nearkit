import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runOpsAdmin } from './admin'

const TOKEN = '123456789:AAEexampleexampleexampleexample_-12'

/** Telegram's getMyCommands as the bot's menus stand: per scope (no scope = the default one), never per language here. */
function telegram(menus: Record<string, string[]>, failing = false) {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const fake = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { scope?: { type: string }; language_code?: string }
    calls.push({ url, body })
    if (failing) return new Response(JSON.stringify({ ok: false, error_code: 401, description: `Unauthorized for bot${TOKEN}` }), { status: 401 })
    const list = body.language_code ? [] : (menus[body.scope?.type ?? 'default'] ?? [])
    return new Response(JSON.stringify({ ok: true, result: list.map((command) => ({ command, description: `about ${command}` })) }))
  }) as typeof globalThis.fetch
  return { fetch: fake, calls }
}

async function withDatabase(run: (env: Record<string, string>) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'nearkit-ops-'))
  try {
    await run({ NEAR_NETWORK: 'testnet', NEARKIT_DB_PATH: join(dir, 'app.sqlite'), TELEGRAM_BOT_TOKEN: TOKEN })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('ops-admin bot-commands: the menus Telegram holds for the bot (getMyCommands)', () => {
  const PRIVATE = ['start', 'help', 'web', 'orders', 'copy', 'snipe', 'dca', 'auto']

  it('prints the default, private-chat and group menus, and checks that the named commands are in the private one', async () => {
    await withDatabase(async (env) => {
      const tg = telegram({ all_private_chats: PRIVATE, all_group_chats: ['start', 'help', 'cancel'] })
      const out: string[] = []
      expect(await runOpsAdmin(['bot-commands', ...PRIVATE], env, (l) => void out.push(l), { fetch: tg.fetch })).toBe(0)
      expect(out).toEqual([
        'default: (none)',
        'all_private_chats (8): start help web orders copy snipe dca auto',
        'all_group_chats (3): start help cancel',
        'private chats show all_private_chats (set), not the default scope',
        'all 8 named commands are in the private menu',
      ])
      expect(tg.calls.map((c) => c.body.scope ?? null)).toEqual([null, { type: 'all_private_chats' }, { type: 'all_group_chats' }])
      expect(tg.calls.every((c) => c.url.endsWith('/getMyCommands'))).toBe(true)
      expect(out.join('\n')).not.toContain(TOKEN.split(':')[1])
    })
  })

  it('a named command missing from the private menu fails, and says which', async () => {
    await withDatabase(async (env) => {
      const tg = telegram({ all_private_chats: ['start', 'help', 'web'] })
      const out: string[] = []
      expect(await runOpsAdmin(['bot-commands', 'start', 'orders', 'auto'], env, (l) => void out.push(l), { fetch: tg.fetch })).toBe(1)
      expect(out).toContain('missing from the private menu: /orders /auto')
      expect(out).toContain('private chats show all_private_chats (set), not the default scope')
    })
  })

  it('with no private-chat menu, private chats fall back to the default scope: said plainly', async () => {
    await withDatabase(async (env) => {
      const tg = telegram({ default: ['start', 'help'] })
      const out: string[] = []
      expect(await runOpsAdmin(['bot-commands'], env, (l) => void out.push(l), { fetch: tg.fetch })).toBe(0)
      expect(out).toContain('all_private_chats: (none)')
      expect(out).toContain('private chats show the default scope (no all_private_chats menu)')
    })
  })

  it('Telegram refusing is a failure, without the token in what is printed; no bot token is a plain answer', async () => {
    await withDatabase(async (env) => {
      const out: string[] = []
      expect(await runOpsAdmin(['bot-commands'], env, (l) => void out.push(l), { fetch: telegram({}, true).fetch })).toBe(1)
      expect(out.join('\n')).toMatch(/getMyCommands/)
      expect(out.join('\n')).not.toContain(TOKEN.split(':')[1])
      out.length = 0
      const noBot = { ...env, TELEGRAM_BOT_TOKEN: undefined }
      expect(await runOpsAdmin(['bot-commands'], noBot, (l) => void out.push(l))).toBe(1)
      expect(out).toEqual(['the Telegram bot is off on this server (no TELEGRAM_BOT_TOKEN)'])
    })
  })
})
