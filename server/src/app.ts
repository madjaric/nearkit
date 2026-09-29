import type { Server } from 'node:http'
import { createApiServer, listen } from './api/http'
import { handoffRoutes } from './api/handoffRoutes'
import { linkRoutes } from './api/linkRoutes'
import { accountsModule, linkedText, movedAwayText, startLink } from './bot/accounts'
import { createBotApp, type BotApp } from './bot/app'
import { buybotModule } from './bot/buybot'
import type { BotDeps, BotModule, BuybotDeps, Command } from './bot/context'
import { coreModule } from './bot/core'
import { portfolioModule } from './bot/portfolio'
import { settingsModule } from './bot/settings'
import { tradeModule } from './bot/trade'
import { loadConfig, type ServerConfig } from './config'
import { migrate } from './db/schema'
import { Db } from './db/sqlite'
import { Store } from './db/store'
import { createLinkService } from './link/service'
import { createLogger, type Logger } from './log'
import { createFollower, createTxIndex } from './buybot/follower'
import { createBuyMarket } from './buybot/market'
import { createDeliverer, createProcessor, startBuybot } from './buybot/pipeline'
import { BuybotStore } from './buybot/store'
import { createServerNear } from './near'
import { createTelegramApi, type TelegramApi } from './telegram/api'
import { startPolling } from './telegram/poller'
import { createHandoffs } from './trade/handoff'
import { createChainAccess } from './custody/chain'
import { createEngine } from './custody/engine'
import { createLocalSigner } from './custody/signer'
import { CustodyStore, type Intent } from './custody/store'
import { localKeyWrapper } from './custody/vault'
import type { CustodyDeps } from './custody/wallets'
import { withdrawHandler } from './custody/withdraw'
import { createSwapService } from './custody/swap'
import { unwrapHandler } from './custody/unwrap'
import { backupKeyHandler, createRecoveryService, revokeHandler } from './custody/recovery'
import { recoveryRoutes } from './api/recoveryRoutes'
import { exportedText, recoveryModule } from './bot/recovery'
import { btn, keyboard } from './bot/context'
import { nativeTradeModule } from './bot/nativeTrade'
import { intentsModule, notifySettled } from './bot/intents'
import { tradingWalletModule } from './bot/tradingWallet'
import { walletErrorText } from './bot/ui'

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
  return [
    coreModule(list, { link: startLink }),
    accountsModule(),
    settingsModule(),
    tradeModule(),
    portfolioModule(),
    buybotModule(),
    tradingWalletModule(),
    nativeTradeModule(),
    recoveryModule(),
    intentsModule(),
  ]
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
  const secrets = [config.telegramToken, options.env.NEARKIT_WALLET_KEK?.trim()].filter((s): s is string => Boolean(s))
  const log = options.log ?? createLogger({ level: config.logLevel, secrets })
  if (issues.length) {
    for (const i of issues) log.error('configuration problem', { key: i.key, problem: i.message })
    throw new Error(`Configuration has ${issues.length} problem(s); see the log above`)
  }
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  const now = options.now ?? Date.now

  const db = await Db.open(config.dbPath)
  migrate(db)
  const store = new Store(db, now)
  const boot = store.recordBoot()
  log.info('database ready', { path: config.dbPath, boot: boot.boot, since: new Date(boot.since).toISOString(), ...store.counts() })
  const near = createServerNear(config, fetchImpl, now)
  const link = createLinkService({ store, config, rpc: near.ctx.rpc, now })
  // Trade results reach the user through the bot once it is running; they respect /settings.
  let notifyUser: (userId: number, html: string) => Promise<void> = async () => {}
  const handoffs = createHandoffs({
    db,
    network: config.network,
    rpc: near.ctx.rpc,
    webUrl: config.webUrl,
    now,
    describeToken: async (id) => {
      const m = await near.ctx.reader.metadata(id)
      return { symbol: m.symbol, decimals: m.decimals }
    },
    notify: (userId, html) => notifyUser(userId, html),
  })
  log.info('NearKit server starting', { network: config.network.id, web: config.webUrl, db: config.dbPath, bot: Boolean(config.telegramToken) })

  // NearKit trading wallets: testnet only, and only with a key-encryption key (config.ts).
  let custody: CustodyDeps | null = null
  let onSettled: (intent: Intent) => Promise<void> = async () => {}
  if (config.custody.enabled && config.custody.kek) {
    const cstore = new CustodyStore(db, now)
    const signer = createLocalSigner({ wrapper: localKeyWrapper(config.custody.kek), network: config.network, store: cstore, now })
    const chain = createChainAccess({ rpc: near.ctx.rpc, fetch: fetchImpl })
    const swaps = createSwapService(near)
    const engine = createEngine({
      store: cstore,
      signer,
      chain,
      handlers: {
        withdraw: withdrawHandler({ near, network: config.network }),
        buy: swaps.handler,
        sell: swaps.handler,
        unwrap: unwrapHandler(near),
        'backup-key': backupKeyHandler({ near, links: store, custody: cstore }),
        revoke: revokeHandler({ near, custody: cstore }),
      },
      log,
      now,
      explain: (e) => walletErrorText(e, { network: config.network.id }),
      onSettled: (intent) => onSettled(intent),
    })
    const recovery = createRecoveryService({ store, custody: cstore, signer, config, rpc: near.ctx.rpc, now })
    custody = { store: cstore, signer, engine, chain, swaps, recovery }
    log.info('trading wallets on', { network: config.network.id, keyRef: signer.keyRef })
  } else {
    log.info('trading wallets off', { reason: config.custody.reason })
  }

  // Buy alerts read the chain on their own network; they need the bot to post.
  let buybot: BuybotDeps | null = null
  if (config.buybot.enabled && config.telegramToken) {
    const bbNetwork = config.buybot.network
    const bbNear =
      bbNetwork === config.network
        ? near
        : createServerNear({ env: { ...config.env, network: bbNetwork.id, feeRecipient: null, kitContract: null }, network: bbNetwork }, fetchImpl, now)
    const bbStore = new BuybotStore(db, now)
    const index = createTxIndex(config.buybot.dataUrl, fetchImpl)
    const follower = createFollower({ network: bbNetwork.id, rpc: bbNear.ctx.rpc, index, store: bbStore, log })
    buybot = { store: bbStore, near: bbNear, market: createBuyMarket(bbNear, now), follower, index }
  }

  let tg: TelegramApi | null = null
  let bot: BotApp | null = null
  let poller: ReturnType<typeof startPolling> | null = null
  let buybotRunner: ReturnType<typeof startBuybot> | null = null
  if (config.telegramToken) {
    tg = createTelegramApi({ token: config.telegramToken, fetch: fetchImpl, baseUrl: config.telegramApiUrl })
    const me = await tg.getMe()
    const webhook = await tg.getWebhookInfo()
    if (webhook.url) throw new Error('A webhook is set for this bot, so long polling cannot run. Remove the webhook (deleteWebhook) or stop the other deployment first.')
    const deps: BotDeps = { tg, store, config, near, link, log, now, me: { id: me.id, username: me.username ?? 'NearKitBot' }, features: new Set(), buybot, handoffs, custody }
    let list: () => { name: string; command: Command }[] = () => []
    bot = createBotApp(
      deps,
      botModules(deps, () => list()),
    )
    const app = bot
    list = () => app.commands()
    notifyUser = async (userId, html) => {
      if (store.getSettings(userId).notifyTrades) await app.notify(userId, html)
    }
    // Results the resolver settles in the background (after a timeout or a restart) always reach the user.
    onSettled = (intent) => notifySettled(deps, (userId, html, markup) => app.notify(userId, html, markup), intent)
    await tg.setMyCommands(menuCommands(bot, 'private'), { type: 'all_private_chats' })
    await tg.setMyCommands(menuCommands(bot, 'group'), { type: 'all_group_chats' })
    poller = startPolling({ tg, store, log, handle: (u) => app.handle(u) })
    log.info('Telegram bot polling', { bot: `@${deps.me.username}` })
    if (buybot) {
      const bb = buybot
      const process = createProcessor({ network: bb.near.ctx.network, index: bb.index, finalHeight: () => bb.follower.finalHeight(), store: bb.store, market: bb.market, log })
      const deliver = createDeliverer({ tg, store: bb.store, market: bb.market, network: bb.near.ctx.network, webUrl: config.webUrl, webNetwork: config.network.id, log, now })
      buybotRunner = startBuybot({ follow: () => bb.follower.step(), process: () => process(), deliver: () => deliver(), log })
      log.info('buybot following final blocks', { network: bb.near.ctx.network.id, data: config.buybot.dataUrl })
    }
  }

  const onLinked = async (r: { accountId: string; userId: number; previousUserId: number | null }) => {
    if (!bot) return
    await bot.notify(r.userId, linkedText(r.accountId, config.network.label))
    if (r.previousUserId !== null) await bot.notify(r.previousUserId, movedAwayText(r.accountId))
  }
  const api: Server = createApiServer({
    config,
    log,
    routes: {
      ...linkRoutes({ link, onLinked }),
      ...handoffRoutes(handoffs),
      ...(custody
        ? recoveryRoutes({
            recovery: custody.recovery,
            // The owner hears about every export in Telegram, whoever did it.
            onExported: async (r) => void (await bot?.notify(r.userId, exportedText(r.wallet, r.signedBy), keyboard([btn('📤 Withdraw', 'cw:wd'), btn('👛 Wallet', 'cw:home')]))),
          })
        : {}),
    },
    limits: { '/api/link/describe': 30, '/api/link/confirm': 10, '/api/handoff/describe': 30, '/api/handoff/result': 20, '/api/recovery/describe': 30, '/api/recovery/export': 5 },
    // Public and secret-free: whether the bot and buy alerts run, and the boot count (see Store.recordBoot).
    health: () => ({
      bot: bot ? true : false,
      buybot: buybotRunner ? 'running' : !config.buybot.enabled ? 'off' : 'needs the bot token',
      wallets: custody ? 'on' : 'off',
      boot: boot.boot,
    }),
    now,
  })
  const apiPort = await listen(api, config.api.port, config.api.host)
  log.info('API listening', { url: `http://${config.api.host}:${apiPort}`, public: config.api.publicUrl, origins: config.api.allowedOrigins })

  // Anything in flight when the process stopped is settled from the chain (read only), then every 15 s.
  let resolving = false
  const resolve = async () => {
    if (!custody || resolving) return
    resolving = true
    try {
      const settled = await custody.engine.resolvePending()
      if (settled.length) log.info('settled wallet intents', { count: settled.length })
    } catch (e) {
      log.warn('resolving wallet intents failed', { error: e })
    } finally {
      resolving = false
    }
  }
  void resolve()
  const resolver = setInterval(() => void resolve(), 15_000)
  resolver.unref()

  const housekeeping = setInterval(() => {
    try {
      store.prune()
      buybot?.store.prune(7 * 86_400_000)
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
      clearInterval(resolver)
      await buybotRunner?.stop()
      await poller?.stop()
      await new Promise<void>((resolve) => api.close(() => resolve()))
      db.close()
      log.info('NearKit server stopped')
    },
  }
}
