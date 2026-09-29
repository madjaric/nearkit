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
import { instanceId, Leases } from './db/leases'
import { databaseSecrets, describeDatabase, openDatabase } from './db/open'
import { migrate } from './db/schema'
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
import { createSignerClient, inProcessTransport } from './custody/signer'
import { CustodyStore, type Intent } from './custody/store'
import { keyring, localKeyWrapper } from './custody/vault'
import { MAX_SLIPPAGE } from '@/lib/fees'
import { createSignerChain } from './signer/chain'
import { httpSignerTransport } from './signer/client'
import { createSignerCore } from './signer/core'
import { importLegacyKeys } from './signer/legacy'
import { createRouteOracle } from './signer/routes'
import { migrateSigner } from './signer/schema'
import { SignerStore } from './signer/store'
import type { CustodyDeps } from './custody/wallets'
import { withdrawHandler } from './custody/withdraw'
import { createSwapService } from './custody/swap'
import { unwrapHandler } from './custody/unwrap'
import { backupKeyHandler, createRecoveryService, revokeHandler } from './custody/recovery'
import { recoveryRoutes } from './api/recoveryRoutes'
import { approvedText, exportedText, recoveryModule } from './bot/recovery'
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
  const secrets = [config.telegramToken, options.env.NEARKIT_WALLET_KEK?.trim(), options.env.NEARKIT_SIGNER_AUTH_KEY?.trim(), ...databaseSecrets(config.database)].filter(
    (s): s is string => Boolean(s),
  )
  const log = options.log ?? createLogger({ level: config.logLevel, secrets })
  if (issues.length) {
    for (const i of issues) log.error('configuration problem', { key: i.key, problem: i.message })
    throw new Error(`Configuration has ${issues.length} problem(s); see the log above`)
  }
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  const now = options.now ?? Date.now

  const db = await openDatabase(config.database)
  const schema = await migrate(db)
  const store = new Store(db, now)
  const leases = new Leases(db, now)
  // This process's name in leases: several instances may share the database.
  const instance = instanceId()
  const boot = await store.recordBoot()
  log.info('database ready', { database: describeDatabase(config.database), schema, boot: boot.boot, since: new Date(boot.since).toISOString(), ...(await store.counts()) })
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
  log.info('NearKit server starting', { network: config.network.id, web: config.webUrl, db: describeDatabase(config.database), bot: Boolean(config.telegramToken) })

  // NearKit trading wallets: testnet only, and only with a key-encryption key (config.ts).
  let custody: CustodyDeps | null = null
  let onSettled: (intent: Intent) => Promise<void> = async () => {}
  if (config.custody.enabled && config.custody.signer) {
    const cstore = new CustodyStore(db, now)
    const signerConfig = config.custody.signer
    let transport
    let signerMode: string
    if (signerConfig.kind === 'in-process') {
      // Testnet, one process: the signer runs in this process and its tables share this database.
      await migrateSigner(db)
      const moved = await importLegacyKeys(db, now)
      if (moved) log.info('wallet keys moved into the signer vault', { count: moved })
      const core = createSignerCore({
        store: new SignerStore(db, now),
        keys: keyring(localKeyWrapper(signerConfig.kek)),
        chain: createSignerChain({ rpcUrls: config.network.rpcUrls, quorum: 1, fetch: fetchImpl }),
        oracle: createRouteOracle(config.network, fetchImpl),
        config: { network: config.network, feeRecipient: null, recipient: config.linkRecipient, maxSlippagePpm: MAX_SLIPPAGE * 10_000 },
        now,
        log,
      })
      transport = inProcessTransport(core)
      signerMode = `in-process (${core.keyRef})`
    } else {
      transport = httpSignerTransport({ url: signerConfig.url, authKey: signerConfig.authKey, fetch: fetchImpl })
      signerMode = 'service'
    }
    const signer = createSignerClient(transport)
    // The signer must serve this network; if it can't be asked now, wallet actions fail closed until it answers.
    const signerHealth = await signer.health().catch((e: unknown) => {
      log.error('the signer is not answering; wallet actions fail until it does', { error: e })
      return null
    })
    if (signerHealth && signerHealth.network !== config.network.id)
      throw new Error(`The signer serves ${signerHealth.network}, but this server runs ${config.network.id}. Fix the configuration.`)
    if (signerHealth) log.info('signer', { mode: signerMode, ok: signerHealth.ok, paused: signerHealth.paused, kek: signerHealth.kek })
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
        'backup-key': backupKeyHandler({ near, custody: cstore }),
        revoke: revokeHandler({ near, custody: cstore, signer }),
      },
      log,
      now,
      explain: (e) => walletErrorText(e, { network: config.network.id }),
      onSettled: (intent) => onSettled(intent),
      instanceId: instance,
    })
    const recovery = createRecoveryService({ custody: cstore, signer, config })
    custody = { store: cstore, signer, engine, chain, swaps, recovery }
    log.info('trading wallets on', { network: config.network.id, signer: signerMode })
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
      { firstDelivery: (id) => leases.firstDelivery(id) },
    )
    const app = bot
    list = () => app.commands()
    notifyUser = async (userId, html) => {
      if ((await store.getSettings(userId)).notifyTrades) await app.notify(userId, html)
    }
    // Results the resolver settles in the background (after a timeout or a restart) always reach the user.
    onSettled = (intent) => notifySettled(deps, (userId, html, markup) => app.notify(userId, html, markup), intent)
    await tg.setMyCommands(menuCommands(bot, 'private'), { type: 'all_private_chats' })
    await tg.setMyCommands(menuCommands(bot, 'group'), { type: 'all_group_chats' })
    poller = startPolling({
      tg,
      store,
      log,
      handle: (u) => app.handle(u),
      lease: { hold: () => leases.acquire('telegram-poller', instance, 60_000), release: () => leases.release('telegram-poller', instance) },
    })
    log.info('Telegram bot polling', { bot: `@${deps.me.username}` })
    if (buybot) {
      const bb = buybot
      const process = createProcessor({ network: bb.near.ctx.network, index: bb.index, finalHeight: () => bb.follower.finalHeight(), store: bb.store, market: bb.market, log })
      const deliver = createDeliverer({ tg, store: bb.store, market: bb.market, network: bb.near.ctx.network, webUrl: config.webUrl, webNetwork: config.network.id, log, now })
      buybotRunner = startBuybot({
        follow: () => bb.follower.step(),
        process: () => process(),
        deliver: () => deliver(),
        log,
        lease: { hold: () => leases.acquire('buybot-runner', instance, 60_000), release: () => leases.release('buybot-runner', instance) },
      })
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
            onExported: async (r) => void (await bot?.notify(r.userId, exportedText(r.wallet, r.owner), keyboard([btn('📤 Withdraw', 'cw:wd'), btn('👛 Wallet', 'cw:home')]))),
            onDestinationApproved: async (r) =>
              void (await bot?.notify(r.userId, approvedText(r.wallet, r.destination), keyboard([btn('▶️ Continue withdrawal', 'cw:wcont'), btn('👛 Wallet', 'cw:home')]))),
          })
        : {}),
    },
    limits: {
      '/api/link/describe': 30,
      '/api/link/confirm': 10,
      '/api/handoff/describe': 30,
      '/api/handoff/result': 20,
      '/api/recovery/challenge': 20,
      '/api/recovery/wallets': 10,
      '/api/recovery/export': 5,
      '/api/recovery/destination': 10,
    },
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
    void (async () => {
      try {
        await store.prune()
        await leases.prune()
        await buybot?.store.prune(7 * 86_400_000)
        // Keys of wallets closed lately that the signer couldn't erase yet (the chain wasn't sure).
        if (custody) {
          const c = custody
          for (const w of await c.store.closedSince(now() - 7 * 86_400_000)) {
            if ((await c.signer.keyInfo(w.accountId)).held)
              await c.signer.eraseKey({ accountId: w.accountId, reason: w.status === 'revoked' ? 'revoked' : 'deleted' }).catch(() => false)
          }
        }
      } catch (e) {
        log.warn('prune failed', { error: e })
      }
    })()
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
      await db.close()
      log.info('NearKit server stopped')
    },
  }
}
