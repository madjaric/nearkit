import { resolve } from 'node:path'
import { loadConfig, type ServerConfig } from '../config'
import { createSignerClient } from '../custody/signer'
import { CustodyStore } from '../custody/store'
import { openDatabase } from '../db/open'
import { migrate } from '../db/schema'
import { loadEnvFile, loadSecretFiles } from '../env-file'
import { httpSignerTransport } from '../signer/client'
import { migrateSigner } from '../signer/schema'
import { SignerStore } from '../signer/store'
import { pinnedFetch, type TlsPin } from '../signer/tls'
import { createTelegramApi } from '../telegram/api'
import { OpsSwitches, SWITCHES, type SwitchName } from './switches'

/**
 * The operator's kill switches, run with the app's configuration (`npm run ops -- <command>`):
 *
 *   status                                   the switches, frozen wallets, the signer
 *   pause <trading|withdrawals|volumebot|bridge|automation> <reason>     stop it now (fails closed; see ops/switches.ts for what keeps working)
 *   resume <trading|withdrawals|volumebot|bridge|automation> <reason>
 *   freeze <wallet id or account> <reason>   that wallet neither trades nor withdraws
 *   unfreeze <wallet id or account> <reason>
 *   signer-pause <reason>                    stop every signature, export and approval (resume on the signer's host)
 *   events [count]                           the latest security events (no secrets are ever recorded)
 *   bot-commands [command …]                 the menus Telegram holds for the bot (getMyCommands); with names,
 *                                            fails unless each is in the menu private chats show
 */

const MENU_SCOPES = ['default', 'all_private_chats', 'all_group_chats'] as const

/** Reads the bot's menus from Telegram (never the database), printing only command names: never the token. */
async function botCommands(config: ServerConfig, names: string[], out: (line: string) => void, f?: typeof fetch): Promise<number> {
  if (!config.telegramToken) {
    out('the Telegram bot is off on this server (no TELEGRAM_BOT_TOKEN)')
    return 1
  }
  const tg = createTelegramApi({ token: config.telegramToken, fetch: f, baseUrl: config.telegramApiUrl })
  const menus: Partial<Record<(typeof MENU_SCOPES)[number], string[]>> = {}
  try {
    for (const scope of MENU_SCOPES) {
      const list = (await tg.getMyCommands(scope === 'default' ? undefined : { type: scope })).map((c) => c.command)
      menus[scope] = list
      out(list.length ? `${scope} (${list.length}): ${list.join(' ')}` : `${scope}: (none)`)
    }
  } catch (e) {
    // The client keeps the token out of its errors.
    out(e instanceof Error ? e.message : 'Telegram did not answer')
    return 1
  }
  // Telegram shows a private chat the all_private_chats menu when there is one, else the default one.
  const own = menus.all_private_chats ?? []
  out(own.length ? 'private chats show all_private_chats (set), not the default scope' : 'private chats show the default scope (no all_private_chats menu)')
  if (!names.length) return 0
  const shown = own.length ? own : (menus.default ?? [])
  const missing = names.map((n) => n.replace(/^\//, '')).filter((n) => !shown.includes(n))
  if (missing.length) {
    out(`missing from the private menu: ${missing.map((n) => `/${n}`).join(' ')}`)
    return 1
  }
  out(`all ${names.length} named commands are in the private menu`)
  return 0
}

/** The signer's own certificate when one is pinned; otherwise the given (or global) fetch. */
const signerFetch = (signer: { tlsPin: TlsPin | null }, f?: typeof fetch) => (signer.tlsPin ? pinnedFetch(signer.tlsPin) : f)

export async function runOpsAdmin(
  argv: string[],
  env: Record<string, string | undefined>,
  out: (line: string) => void,
  o: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<number> {
  const { config, issues } = loadConfig(env)
  if (issues.length) {
    for (const i of issues) out(`configuration problem: ${i.key}: ${i.message}`)
    return 2
  }
  if (argv[0] === 'bot-commands') return botCommands(config, argv.slice(1), out, o.fetch)
  const db = await openDatabase(config.database)
  try {
    await migrate(db)
    const custody = new CustodyStore(db, o.now)
    const ops = new OpsSwitches(db, custody, o.now, config.ops.hostPaused)
    const by = `operator${env.USER ? `:${env.USER}` : env.USERNAME ? `:${env.USERNAME}` : ''}`
    const walletOf = async (ref: string) => (await custody.wallet(ref)) ?? (await custody.walletByAccount(config.network.id, ref))
    const [command, target, ...rest] = argv
    const reason = rest.join(' ').trim()
    switch (command) {
      case 'status': {
        const s = await ops.state()
        for (const name of SWITCHES) {
          const sw = s[name]
          out(
            `${name}: ${!sw.paused ? 'running' : sw.since === null ? `PAUSED ${sw.reason ?? ''}`.trim() : `PAUSED since ${new Date(sw.since).toISOString()} (${sw.reason ?? 'no reason'})`}`,
          )
        }
        const frozen = await db.all<{ id: string; account_id: string; frozen_reason: string | null }>(
          "SELECT id, account_id, frozen_reason FROM trading_wallets WHERE frozen_at IS NOT NULL AND status = 'active'",
        )
        out(`frozen wallets: ${frozen.length}`)
        for (const f of frozen) out(`  ${f.id} ${f.account_id} (${f.frozen_reason ?? 'no reason'})`)
        const signer = config.custody.signer
        if (signer?.kind === 'remote') {
          const h = await createSignerClient(httpSignerTransport({ url: signer.url, authKey: signer.authKey, fetch: signerFetch(signer, o.fetch) }))
            .health()
            .catch((e: unknown) => ({ ok: false, paused: null, kek: e instanceof Error ? e.message : 'unavailable' }))
          out(`signer (service): ok ${String(h.ok)} · paused ${String(h.paused)} · KEK ${String(h.kek)}`)
        } else if (signer?.kind === 'in-process') {
          await migrateSigner(db)
          out(`signer (in this process): paused ${String((await new SignerStore(db).getState('paused')) === 'true')}`)
        } else {
          out('signer: NEARKITS wallets are off on this server')
        }
        return 0
      }
      case 'pause':
      case 'resume': {
        if (!SWITCHES.includes(target as SwitchName) || !reason) {
          out(`usage: ${command} <${SWITCHES.join('|')}> <reason>`)
          return 2
        }
        await ops.set(target as SwitchName, command === 'pause', reason, by)
        if (command === 'resume' && (await ops.state())[target as SwitchName].paused) {
          out(`${target} stays paused: the host holds it (NEARKIT_OPS_PAUSED). Remove it there and restart.`)
          return 1
        }
        out(`${target} ${command === 'pause' ? 'paused' : 'resumed'}`)
        return 0
      }
      case 'freeze':
      case 'unfreeze': {
        if (!target || !reason) {
          out(`usage: ${command} <wallet id or account> <reason>`)
          return 2
        }
        const w = await walletOf(target)
        if (!w || w.status !== 'active') {
          out('no active NEARKITS wallet with that id or account')
          return 1
        }
        await custody.setFrozen(w.id, command === 'freeze' ? reason : null)
        await custody.audit({ userId: w.userId, walletId: w.id, action: command === 'freeze' ? 'wallet-frozen' : 'wallet-unfrozen', detail: { reason, by } })
        out(`${w.accountId} ${command === 'freeze' ? 'frozen' : 'unfrozen'}`)
        return 0
      }
      case 'signer-pause': {
        const why = [target, ...rest].filter(Boolean).join(' ').trim()
        if (!why) {
          out('usage: signer-pause <reason>')
          return 2
        }
        const signer = config.custody.signer
        if (signer?.kind === 'remote') await createSignerClient(httpSignerTransport({ url: signer.url, authKey: signer.authKey, fetch: signerFetch(signer, o.fetch) })).pause(why)
        else if (signer?.kind === 'in-process') {
          await migrateSigner(db)
          const store = new SignerStore(db, o.now)
          await store.setState('paused', 'true')
          await store.event('signer-paused', { detail: { reason: why, by } })
        } else {
          out('NEARKITS wallets are off on this server: there is no signer to pause')
          return 1
        }
        await custody.audit({ action: 'ops-signer-paused', detail: { reason: why, by } })
        out('signer paused: nothing is signed, exported, approved or erased (resume on the signer’s host: npm run signer:admin -- resume <reason>)')
        return 0
      }
      case 'events': {
        const n = Math.min(Math.max(Number(target ?? '20') || 20, 1), 500)
        const rows = await db.all<{ at: number; user_id: number | null; wallet_id: string | null; action: string; detail: string | null }>(
          'SELECT at, user_id, wallet_id, action, detail FROM custody_audit ORDER BY id DESC LIMIT ?',
          [n],
        )
        for (const r of rows.reverse())
          out(
            `${new Date(r.at).toISOString()} ${r.action}${r.user_id !== null ? ` user ${r.user_id}` : ''}${r.wallet_id ? ` wallet ${r.wallet_id}` : ''}${r.detail ? ` ${r.detail}` : ''}`,
          )
        return 0
      }
      default:
        out(`usage: status | pause|resume <${SWITCHES.join('|')}> <reason> | freeze|unfreeze <wallet> <reason> | signer-pause <reason> | events [count] | bot-commands [command …]`)
        return 2
    }
  } finally {
    await db.close()
  }
}

// Run as a script (not when imported by tests).
if (process.argv[1] && /ops-admin\.(js|ts)$/.test(process.argv[1])) {
  loadEnvFile(resolve(process.env.NEARKIT_ENV_FILE ?? 'server/.env.local'))
  loadSecretFiles()
  process.exitCode = await runOpsAdmin(process.argv.slice(2), process.env, (line) => process.stdout.write(`${line}\n`))
}
