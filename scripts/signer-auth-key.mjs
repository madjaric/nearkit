// Creates the shared key the app and the signer service sign their requests with
// (NEARKIT_SIGNER_AUTH_KEY): 32 random bytes, base64, written to both git-ignored env
// files, server/.env.wallet.local (the app) and server/.env.signer.local (the signer).
// The key is never printed. On real hosts, set the same value as a secret variable on
// both the app and the signer (never in a file on a shared volume).
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const files = [resolve(process.argv[2] ?? 'server/.env.wallet.local'), resolve(process.argv[3] ?? 'server/.env.signer.local')]
const present = files.filter((f) => existsSync(f) && /^\s*NEARKIT_SIGNER_AUTH_KEY\s*=\s*\S+/m.test(readFileSync(f, 'utf8')))
if (present.length) {
  console.log(`${present.join(' and ')} already set NEARKIT_SIGNER_AUTH_KEY; nothing was changed (both sides must hold the same key).`)
  process.exit(0)
}
const key = randomBytes(32).toString('base64')
for (const f of files) {
  const text = ['# SECRET. Signs requests between the NEARKITS app and its signer service. Never commit, share or print it.', `NEARKIT_SIGNER_AUTH_KEY=${key}`, ''].join('\n')
  writeFileSync(f, (existsSync(f) ? '\n' : '') + text, { flag: existsSync(f) ? 'a' : 'wx', mode: 0o600 })
  try {
    chmodSync(f, 0o600)
  } catch {
    // Windows keeps its own ACLs.
  }
}
console.log(`Wrote the same new NEARKIT_SIGNER_AUTH_KEY to ${files.join(' and ')} (value not shown).`)
