import { resolve } from 'node:path'
import { loadEnvFile } from '../env-file'
import { createLogger } from '../log'
import { loadSignerConfig } from './config'
import { resealWalletKey } from './envelope'
import { buildSigner, signerSecrets } from './service'

/**
 * The signer operator's command line, run on the signer's host with the signer's own
 * configuration (`npm run signer:admin -- <command>`):
 *
 *   status            health, pause state, KEK, keys held, the last events
 *   pause <reason>    stop all signing, exports, approvals and erasures now
 *   resume <reason>   the only way to resume (the app can pause, never resume)
 *   reseal [--apply]  move every key to the current KEK and the owner-bound sealing
 *                     (without --apply: only counts what would move)
 *
 * It never prints a key, a secret or a sealed key: counts, references and reasons only.
 */

export async function runAdmin(argv: string[], env: Record<string, string | undefined>, out: (line: string) => void): Promise<number> {
  const [command, ...rest] = argv
  const { config, issues } = loadSignerConfig(env)
  if (!config) {
    for (const i of issues) out(`configuration problem: ${i.key}: ${i.message}`)
    return 2
  }
  const log = createLogger({ level: 'warn', secrets: signerSecrets(env, config) })
  const s = await buildSigner(config, { log })
  try {
    switch (command) {
      case 'status': {
        const h = (await s.core.handle('health', {})) as Record<string, unknown>
        const held = (await s.store.activeKeys()).length
        out(`network ${String(h.network)} · paused ${String(h.paused)} · KEK ${String(h.kek)} (${String(h.keyRef)}) · database ${String(h.db)} · keys held ${held}`)
        for (const e of (await s.store.recentEvents(10)).reverse()) out(`${new Date(e.at).toISOString()} ${e.kind}${e.accountId ? ` ${e.accountId}` : ''}`)
        return h.ok ? 0 : 1
      }
      case 'pause':
      case 'resume': {
        const reason = rest.join(' ').trim()
        if (!reason) {
          out(`usage: ${command} <reason>`)
          return 2
        }
        await s.core.setPaused(command === 'pause', reason)
        out(command === 'pause' ? 'signer paused: nothing is signed, exported, approved or erased' : 'signer resumed')
        return 0
      }
      case 'reseal': {
        const apply = rest.includes('--apply')
        let moved = 0
        let kept = 0
        let failed = 0
        for (const k of await s.store.activeKeys()) {
          try {
            const r = await resealWalletKey(s.keys, k.sealedKey as string, { network: k.network, accountId: k.accountId, publicKey: k.publicKey, owner: k.ownerAccount })
            if (!r.changed) {
              kept++
              continue
            }
            if (apply && !(await s.store.resealed(k.network, k.accountId, k.sealedKey as string, r.sealed, s.keys.current.ref))) {
              failed++
              continue
            }
            moved++
          } catch (e) {
            failed++
            out(`could not reseal ${k.accountId}: ${e instanceof Error ? e.message : 'error'}`)
          }
        }
        if (apply) await s.store.event('keys-resealed', { detail: { moved, kept, failed, keyRef: s.keys.current.ref } })
        out(`${apply ? 'resealed' : 'would reseal'} ${moved} · already current ${kept} · failed ${failed}${apply ? '' : ' (dry run: add --apply)'}`)
        return failed ? 1 : 0
      }
      default:
        out('usage: status | pause <reason> | resume <reason> | reseal [--apply]')
        return 2
    }
  } finally {
    await s.db.close()
  }
}

// Run as a script (not when imported by tests).
if (process.argv[1] && /admin\.(js|ts)$/.test(process.argv[1])) {
  const envFile = resolve(process.env.NEARKIT_SIGNER_ENV_FILE ?? 'server/.env.signer.local')
  loadEnvFile(envFile)
  process.exitCode = await runAdmin(process.argv.slice(2), process.env, (line) => process.stdout.write(`${line}\n`))
}
