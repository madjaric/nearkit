import { dirname, join, resolve } from 'node:path'
import { startServer } from './app'
import { loadEnvFile, loadSecretFiles } from './env-file'
import { createLogger } from './log'

/**
 * Entry point: `npm run server`. Reads `server/.env.local` and
 * `server/.env.wallet.local` (both git-ignored) for anything the host environment
 * doesn't set, then starts the bot and the API. Only the NAMES of loaded
 * variables are ever printed.
 */

const envFile = resolve(process.env.NEARKIT_ENV_FILE ?? 'server/.env.local')
const loaded = loadEnvFile(envFile)
// The trading-wallet key-encryption key sits in its own git-ignored file next to the env file
// (npm run server:wallet-key), wherever the process was started from.
const walletFile = resolve(process.env.NEARKIT_WALLET_ENV_FILE ?? join(dirname(envFile), '.env.wallet.local'))
const walletLoaded = loadEnvFile(walletFile)
// Container secrets mounted as files (NAME_FILE), for the secrets that allow it.
const fromFiles = loadSecretFiles()
const secrets = [process.env.TELEGRAM_BOT_TOKEN, process.env.NEARKIT_WALLET_KEK].filter((s): s is string => Boolean(s))
const boot = createLogger({ secrets })
if (loaded.length) boot.info('loaded settings from env file', { file: envFile, keys: loaded })
if (walletLoaded.length) boot.info('loaded settings from env file', { file: walletFile, keys: walletLoaded })
if (fromFiles.length) boot.info('loaded secrets from files', { keys: fromFiles })

try {
  const server = await startServer({ env: process.env })
  let stopping = false
  const shutdown = async (signal: string) => {
    if (stopping) return
    stopping = true
    boot.info('shutting down', { signal })
    await server.stop().catch((e: unknown) => boot.error('shutdown failed', { error: e }))
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
} catch (e) {
  boot.error('NearKit server failed to start', { error: e })
  process.exit(1)
}
