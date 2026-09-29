import { resolve } from 'node:path'
import { startServer } from './app'
import { loadEnvFile } from './env-file'
import { createLogger } from './log'

/**
 * Entry point: `npm run server`. Reads `server/.env.local` (git-ignored) for
 * anything the host environment doesn't set, then starts the bot and the API.
 * Only the NAMES of loaded variables are ever printed.
 */

const envFile = resolve(process.env.NEARKIT_ENV_FILE ?? 'server/.env.local')
const loaded = loadEnvFile(envFile)
const boot = createLogger({ secrets: process.env.TELEGRAM_BOT_TOKEN ? [process.env.TELEGRAM_BOT_TOKEN] : [] })
if (loaded.length) boot.info('loaded settings from env file', { file: envFile, keys: loaded })

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
