import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { silentLogger } from '../log'
import { startBuybotService } from './service'

const TOKEN = '1111111111:FAKE-token-for-tests-only-0000000000'

describe('the buybot as its own process', () => {
  it('refuses to start with any custody setting, or without the bot token', async () => {
    const base = { NEAR_NETWORK: 'testnet', TELEGRAM_BOT_TOKEN: TOKEN }
    for (const key of ['NEARKIT_WALLET_KEK', 'NEARKIT_SIGNER_AUTH_KEY', 'NEARKIT_KMS_KEY_ARN'])
      await expect(startBuybotService({ env: { ...base, [key]: 'x' }, log: silentLogger })).rejects.toThrow(/configuration/)
    await expect(startBuybotService({ env: { NEAR_NETWORK: 'testnet' }, log: silentLogger })).rejects.toThrow(/configuration/)
  })

  it('runs with its own database and says how it is doing on a secret-free /health', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nearkit-buybot-'))
    try {
      // No group follows a token yet, so its loop runs without asking the network.
      const offline = (async () => {
        throw new Error('offline')
      }) as typeof fetch
      const s = await startBuybotService({
        env: { NEAR_NETWORK: 'testnet', TELEGRAM_BOT_TOKEN: TOKEN, NEARKIT_DB_PATH: join(dir, 'app.sqlite'), BUYBOT_HEALTH_PORT: '0' },
        fetch: offline,
        log: silentLogger,
      })
      const health = (await (await fetch(`http://127.0.0.1:${s.healthPort}/health`)).json()) as Record<string, unknown>
      expect(health).toMatchObject({ ok: true, network: 'mainnet', posting: true, lastPostAt: null })
      expect(JSON.stringify(health)).not.toContain(TOKEN)
      await s.stop()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
