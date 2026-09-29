import type { Server } from 'node:http'
import { createApiServer, listen } from './api/http'
import { linkRoutes } from './api/linkRoutes'
import { accountsModule, linkedText, movedAwayText, startLink } from './bot/accounts'
import { createBotApp, type BotApp } from './bot/app'
import type { BotDeps, BotModule, Command } from './bot/context'
import { coreModule } from './bot/core'
import { settingsModule } from './bot/settings'
import { loadConfig, type ServerConfig } from './config'
import { migrate } from './db/schema'
import { Db } from './db/sqlite'
import { Store } from './db/store'
import { createLinkService } from './link/service'
import { createLogger, type Logger } from './log'
import { createServerNear } from './near'
import { createTelegramApi, type TelegramApi } from './telegram/api'
import { startPolling } from './telegram/poller'

/**
 * Wires the server together: configuration, database, NearKit services, the
 * Telegram bot (long polling) and the HTTP API. Each part can be absent: no
 * token means no bot; the API still answers.
 */

export interface RunningServer {
  config: ServerConfig
  store: Store
  bot: BotApp | null
  apiPort: number
  stop(): Promise<void>
}

export function botModules(_deps: BotDeps, list: () => { name: string; command: Command }[]): BotModule[] {
  // `/start link` (from the "open a private chat" button) goes straight to linking.
  return [coreModule(list, { link: startLink }), accountsModule(), settingsModule()]
}

/** Commands for Telegram's menu, per chat type. */
export function menuCommands(bot: BotApp, scope: 'private' | 'group') {
  return bot
    .commands()
    .filter((c) => c.command.description && (c.command.scope === 'any' || c.command.scope === scope))
    .map((c) => ({ command: c.name, description: (c.command.description as string).slice(0, 256) }))
}

export async function startServer(options: { env: Record<string, string | undefined>; fetch?: typeof fetch; log?: Logger; now?: () => number }): Promise<RunningServer> {
  const { config, issues } = loadConfig(options.env)
  const log = options.log ?? createLogger({ level: config.logLevel, secrets: config.telegramToken ? [config.telegramToken] : [] })
  if (issues.length) {
    for (const i of issues) log.error('configuration problem', { key: i.key, problem: i.message })
    throw new Error(`Configuration has ${issues.length} problem(s); see the log above`)
  }
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  const now = options.now ?? Date.now

  const db = await Db.open(config.dbPath)
  migrate(db)
  const store = new Store(db, now)
  const near = createServerNear(config, fetchImpl, now)
  const link = createLinkService({ store, config, rpc: near.ctx.rpc, now })
  log.info('NearKit server starting', { network: config.network.id, web: config.webUrl, db: config.dbPath, bot: Boolean(config.telegramToken) })

  let tg: TelegramApi | null = null
  let bot: BotApp | null = null
  let poller: ReturnType<typeof startPolling> | null = null
  if (config.telegramToken) {
    tg = createTelegramApi({ token: config.telegramToken, fetch: fetchImpl, baseUrl: config.telegramApiUrl })
    const me = await tg.getMe()
    const webhook = await tg.getWebhookInfo()
    if (webhook.url) throw new Error('A webhook is set for this bot, so long polling cannot run. Remove the webhook (deleteWebhook) or stop the other deployment first.')
    const deps: BotDeps = { tg, store, config, near, link, log, now, me: { id: me.id, username: me.username ?? 'NearKitBot' }, features: new Set() }
    let list: () => { name: string; command: Command }[] = () => []
    bot = createBotApp(
      deps,
      botModules(deps, () => list()),
    )
    const app = bot
    list = () => app.commands()
    await tg.setMyCommands(menuCommands(bot, 'private'), { type: 'all_private_chats' })
    await tg.setMyCommands(menuCommands(bot, 'group'), { type: 'all_group_chats' })
    poller = startPolling({ tg, store, log, handle: (u) => app.handle(u) })
    log.info('Telegram bot polling', { bot: `@${deps.me.username}` })
  }

  const onLinked = async (r: { accountId: string; userId: number; previousUserId: number | null }) => {
    if (!bot) return
    await bot.notify(r.userId, linkedText(r.accountId, config.network.label))
    if (r.previousUserId !== null) await bot.notify(r.previousUserId, movedAwayText(r.accountId))
  }
  const api: Server = createApiServer({
    config,
    log,
    routes: { ...linkRoutes({ link, onLinked }) },
    limits: { '/api/link/describe': 30, '/api/link/confirm': 10 },
    health: () => ({ bot: bot ? true : false }),
    now,
  })
  const apiPort = await listen(api, config.api.port, config.api.host)
  log.info('API listening', { url: `http://${config.api.host}:${apiPort}`, public: config.api.publicUrl, origins: config.api.allowedOrigins })

  const housekeeping = setInterval(() => {
    try {
      store.prune()
    } catch (e) {
      log.warn('prune failed', { error: e })
    }
  }, 10 * 60_000)
  housekeeping.unref()

  return {
    config,
    store,
    bot,
    apiPort,
    async stop() {
      clearInterval(housekeeping)
      await poller?.stop()
      await new Promise<void>((resolve) => api.close(() => resolve()))
      db.close()
      log.info('NearKit server stopped')
    },
  }
}
