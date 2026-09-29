import { createServer, type Server } from 'node:http'
import { resolve } from 'node:path'
import { listen } from '../api/http'
import type { BuybotDeps } from '../bot/context'
import { loadConfig, type ServerConfig } from '../config'
import type { Database } from '../db/database'
import { instanceId, Leases } from '../db/leases'
import { databaseSecrets, openDatabase } from '../db/open'
import { migrate } from '../db/schema'
import { loadEnvFile } from '../env-file'
import { createLogger, type Logger } from '../log'
import { createServerNear, type ServerNear } from '../near'
import { createTelegramApi, type TelegramApi } from '../telegram/api'
import { createFollower, createTxIndex } from './follower'
import { createBuyMarket } from './market'
import { createDeliverer, createProcessor, startBuybot } from './pipeline'
import { BuybotStore } from './store'

/**
 * NearKit's buy alerts as a process of their own (`npm run buybot`). They only read the
 * chain: the process holds no wallet key, no signer credential and no custody setting
 * (it refuses to start with one), so its failures can't touch trading. It needs the bot
 * token (to post), the database (the groups' settings, written by the app's /buybot
 * commands) and RPC access. Run the app with BUYBOT_RUNNER=separate next to it.
 * Several instances may run: one posts at a time (the 'buybot-runner' lease).
 */

/** The buybot's services for its network (it may follow mainnet while trading is testnet). */
export function buildBuybotDeps(config: ServerConfig, db: Database, fetchImpl: typeof fetch, now: () => number, log: Logger, tradingNear?: ServerNear): BuybotDeps {
  const network = config.buybot.network
  const near =
    tradingNear && network === config.network
      ? tradingNear
      : createServerNear({ env: { ...config.env, network: network.id, feeRecipient: null, kitContract: null }, network }, fetchImpl, now)
  const store = new BuybotStore(db, now)
  const index = createTxIndex(config.buybot.dataUrl, fetchImpl)
  const follower = createFollower({ network: network.id, rpc: near.ctx.rpc, index, store, log })
  return { store, near, market: createBuyMarket(near, now), follower, index }
}

/** Follows and posts until stopped; with a lease so only one process posts. */
export function runBuybot(o: { bb: BuybotDeps; tg: TelegramApi; config: ServerConfig; leases: Leases; instance: string; log: Logger; now: () => number }) {
  const { bb, tg, config, log } = o
  const process = createProcessor({ network: bb.near.ctx.network, index: bb.index, finalHeight: () => bb.follower.finalHeight(), store: bb.store, market: bb.market, log })
  const deliver = createDeliverer({ tg, store: bb.store, market: bb.market, network: bb.near.ctx.network, webUrl: config.webUrl, webNetwork: config.network.id, log, now: o.now })
  const state = { lastFollow: 0, lastPost: 0, holding: false }
  const runner = startBuybot({
    follow: async () => {
      const r = await bb.follower.step()
      state.lastFollow = o.now()
      return r
    },
    process: () => process(),
    deliver: async () => {
      const n = await deliver()
      if (n) state.lastPost = o.now()
      return n
    },
    log,
    lease: {
      hold: async () => (state.holding = await o.leases.acquire('buybot-runner', o.instance, 60_000)),
      release: () => o.leases.release('buybot-runner', o.instance),
    },
  })
  log.info('buybot following final blocks', { network: bb.near.ctx.network.id, data: config.buybot.dataUrl })
  return { ...runner, state }
}

const CUSTODY_SECRETS = ['NEARKIT_WALLET_KEK', 'NEARKIT_SIGNER_AUTH_KEY', 'NEARKIT_SIGNER_KEK', 'NEARKIT_KMS_KEY_ARN'] as const

export async function startBuybotService(o: { env: Record<string, string | undefined>; fetch?: typeof fetch; now?: () => number; log?: Logger }) {
  const { config, issues } = loadConfig(o.env)
  const log = o.log ?? createLogger({ level: config.logLevel, secrets: [config.telegramToken, ...databaseSecrets(config.database)].filter((s): s is string => Boolean(s)) })
  const held = CUSTODY_SECRETS.filter((k) => o.env[k]?.trim())
  if (held.length) issues.push(...held.map((key) => ({ key, message: 'The buy bot never holds custody settings: remove it from this process' })))
  if (!config.telegramToken) issues.push({ key: 'TELEGRAM_BOT_TOKEN', message: 'The buy bot posts with the bot token' })
  if (issues.length) {
    for (const i of issues) log.error('buybot configuration problem', { key: i.key, problem: i.message })
    throw new Error(`Buybot configuration has ${issues.length} problem(s); see the log above`)
  }
  const fetchImpl = o.fetch ?? globalThis.fetch.bind(globalThis)
  const now = o.now ?? Date.now
  const db = await openDatabase(config.database)
  await migrate(db)
  const tg = createTelegramApi({ token: config.telegramToken as string, fetch: fetchImpl, baseUrl: config.telegramApiUrl })
  const bb = buildBuybotDeps(config, db, fetchImpl, now, log)
  const leases = new Leases(db, now)
  const running = runBuybot({ bb, tg, config, leases, instance: instanceId(), log, now })

  // Health for the host's checks: secret-free.
  let server: Server | null = null
  const port = o.env.BUYBOT_HEALTH_PORT?.trim()
  if (port) {
    server = createServer((req, res) => {
      const body = {
        ok: running.state.lastFollow > 0 && now() - running.state.lastFollow < 120_000,
        network: bb.near.ctx.network.id,
        posting: running.state.holding,
        lastFollowAt: running.state.lastFollow || null,
        lastPostAt: running.state.lastPost || null,
      }
      res.writeHead(req.url === '/health' ? 200 : 404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(req.url === '/health' ? body : { error: 'not found' }))
    })
  }
  const healthPort = server ? await listen(server, Number(port), o.env.BUYBOT_HEALTH_HOST?.trim() || '127.0.0.1') : null
  const prune = setInterval(() => void bb.store.prune(7 * 86_400_000).catch(() => undefined), 10 * 60_000)
  prune.unref()
  return {
    state: running.state,
    healthPort,
    async stop() {
      clearInterval(prune)
      await running.stop()
      if (server) await new Promise<void>((r) => (server as Server).close(() => r()))
      await db.close()
    },
  }
}

// Run as a script (not when imported by tests).
if (process.argv[1] && /buybot\.(js|ts)$/.test(process.argv[1])) {
  loadEnvFile(resolve(process.env.NEARKIT_ENV_FILE ?? 'server/.env.local'))
  const boot = createLogger({ secrets: [process.env.TELEGRAM_BOT_TOKEN].filter((s): s is string => Boolean(s)) })
  try {
    const service = await startBuybotService({ env: process.env })
    const stop = async () => {
      await service.stop().catch(() => undefined)
      process.exit(0)
    }
    process.on('SIGINT', () => void stop())
    process.on('SIGTERM', () => void stop())
  } catch (e) {
    boot.error('NearKit buybot failed to start', { error: e })
    process.exit(1)
  }
}
