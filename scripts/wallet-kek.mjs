// Creates the key-encryption key for NearKit trading wallets (testnet) in
// server/.env.wallet.local, a git-ignored file the server reads next to
// server/.env.local. 32 random bytes, base64. The key is never printed: only
// whether the file was written. Run once; keep a backup of the file. Without it
// the stored wallet keys can't be opened (a wallet's backup key still works).
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const path = resolve(process.argv[2] ?? 'server/.env.wallet.local')
const has = existsSync(path) && /^\s*NEARKIT_WALLET_KEK\s*=\s*\S+/m.test(readFileSync(path, 'utf8'))
if (has) {
  console.log(`${path} already sets NEARKIT_WALLET_KEK; left unchanged.`)
  process.exit(0)
}
const text = [
  '# SECRET. Encrypts NearKit trading-wallet keys (testnet). Never commit, share or print it.',
  '# Losing it makes every stored wallet key unreadable.',
  `NEARKIT_WALLET_KEK=${randomBytes(32).toString('base64')}`,
  '',
].join('\n')
writeFileSync(path, (existsSync(path) ? '\n' : '') + text, { flag: existsSync(path) ? 'a' : 'wx', mode: 0o600 })
try {
  chmodSync(path, 0o600)
} catch {
  // Windows keeps its own ACLs.
}
console.log(`Wrote a new NEARKIT_WALLET_KEK to ${path} (value not shown). Back this file up.`)
