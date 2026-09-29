import { resolve } from 'node:path'
import { loadEnvFile } from '../env-file'
import { createLogger } from '../log'
import { signerSecrets, startSignerService } from './service'

/**
 * Entry point of the signer service: `npm run signer`. It reads the git-ignored
 * `server/.env.signer.local` for anything the host environment doesn't set (only the
 * NAMES of loaded variables are printed), then serves signed requests from the app.
 * It needs no Telegram token and no app database credentials, and must not have them.
 */

const envFile = resolve(process.env.NEARKIT_SIGNER_ENV_FILE ?? 'server/.env.signer.local')
const loaded = loadEnvFile(envFile)
const boot = createLogger({ secrets: signerSecrets(process.env, null) })
if (loaded.length) boot.info('loaded settings from env file', { file: envFile, keys: loaded })
for (const forbidden of ['TELEGRAM_BOT_TOKEN', 'NEARKIT_DATABASE_URL', 'NEARKIT_WALLET_KEK'])
  if (process.env[forbidden]) boot.warn('the signer does not use this setting; remove it from the signer host', { key: forbidden })

try {
  const service = await startSignerService({ env: process.env })
  let stopping = false
  const shutdown = async (signal: string) => {
    if (stopping) return
    stopping = true
    boot.info('shutting down', { signal })
    await service.stop().catch((e: unknown) => boot.error('shutdown failed', { error: e }))
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
} catch (e) {
  boot.error('NearKit signer failed to start', { error: e })
  process.exit(1)
}
