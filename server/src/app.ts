import { volumeModule } from './bot/volume'
import { botRoutes } from './volumebot/routes'
import { createVolumeBotRunner } from './volumebot/runner'
import { VolumeBotStore } from './volumebot/store'
import type { Server } from 'node:http'
import { API_LIMITS } from './api/limits'
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
import { buildBuybotDeps, runBuybot } from './buybot/service'
import { checkChainIds } from './chainId'
import { createKitsBurnTracker } from './kits/burns'
import { kitsRoutes } from './kits/routes'
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
import { pinnedFetch } from './signer/tls'
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
import { telegramRoutes } from './api/telegramRoutes'
import { approvedText, exportCancelledText, exportedText, exportRequestedNotice, recoveryModule, telegramApprovedText } from './bot/recovery'
import { createTelegramApprovals } from './custody/telegramApprovals'
import { TELEGRAM_LAUNCH_KEYS } from './signer/telegram'
import { hexDecode } from '@/lib/encoding'
import { btn, keyboard } from './bot/context'
import { nativeTradeModule } from './bot/nativeTrade'
import { intentsModule, notifySettled } from './bot/intents'
import { telegramApprovalsOn, tradingWalletModule } from './bot/tradingWallet'
import { linkedAccountOf } from './bot/wallet'
import { startWeb, webModule } from './bot/web'
import { WEB_CHAT, webRunsSettled } from './web/execute'
import { webRoutes } from './web/routes'
import { WebSessions } from './web/sessions'
import { referralsModule } from './bot/referrals'
import { OpsSwitches } from './ops/switches'
import { createOneClick } from './bridge/oneclick'
import { bridgeRoutes } from './bridge/routes'
import { createBridgeService } from './bridge/service'
import { createSolanaReads } from './bridge/solana'
import { BridgeStore } from './bridge/store'
import { createBridgeWorker } from './bridge/worker'
import { createReferrals } from './referrals/service'
import { walletErrorText } from './bot/ui'
import { esc } from './telegram/html'

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
  // `/start link` (from the "open a private chat" button) goes straight to linking; `/start web`
  // (NearKit web's "Sign in with Telegram") sends the one-time sign-in link.
  return [
    coreModule(list, { link: startLink, web: startWeb }),
    accountsModule(),
    settingsModule(),
    tradeModule(),
    portfolioModule(),
    buybotModule(),
    tradingWalletModule(),
    nativeTradeModule(),
    recoveryModule(),
    intentsModule(),
    referralsModule(),
    webModule(),
    volumeModule(),
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
  const secrets = [
    config.telegramToken,
    config.bridge.apiKey,
    options.env.NEARKIT_WALLET_KEK?.trim(),
    options.env.NEARKIT_SIGNER_AUTH_KEY?.trim(),
    ...databaseSecrets(config.database),
  ].filter((s): s is string => Boolean(s))
  const log = options.log ?? createLogger({ level: config.logLevel, secrets })
  if (issues.length) {
    for (const i of issues) log.error('configuration problem', { key: i.key, problem: i.message })
    throw new Error(`Configuration has ${issues.length} problem(s); see the log above`)
  }
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  const now = options.now ?? Date.now

  // Each RPC provider must serve this network: a wrong one stops the server here.
  const rpcCheck = await checkChainIds(config.network.rpcUrls, config.network.id, fetchImpl)
  if (rpcCheck.unreachable.length) log.warn('some RPC providers did not answer at start', { urls: rpcCheck.unreachable })

  const db = await openDatabase(config.database)
  const schema = await migrate(db)
  const store = new Store(db, now)
  const leases = new Leases(db, now)
  // This process's name in leases: several instances may share the database.
  const instance = instanceId()
  const boot = await store.recordBoot()
  log.info('database ready', { database: describeDatabase(config.database), schema, boot: boot.boot, since: new Date(boot.since).toISOString(), ...(await store.counts()) })
  const near = createServerNear(config, fetchImpl, now)
  // $KITS exists on mainnet only: its Buyback & Burn tracker (a public, cached, read-only route) runs there.
  const kitsBurns =
    config.network.id === 'mainnet' && config.network.kitsContract ? createKitsBurnTracker({ rpc: near.ctx.rpc, fetch: fetchImpl, network: config.network, now, log }) : null
  const link = createLinkService({ store, config, rpc: near.ctx.rpc, now })
  // Trade results reach the user through the bot once it is running; they respect /settings.
  let notifyUser: (userId: number, html: string) => Promise<void> = async () => {}
  // Referral accounting hears about settled trades (bound once referrals exist, below).
  let onTradeDone: (intent: Intent) => Promise<void> = async () => {}
  let onHandoffTraded: NonNullable<Parameters<typeof createHandoffs>[0]['onTraded']> = async () => {}
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
    onTraded: (t) => onHandoffTraded(t),
  })
  log.info('NEARKITS server starting', { network: config.network.id, web: config.webUrl, db: describeDatabase(config.database), bot: Boolean(config.telegramToken) })

  // NearKit trading wallets: testnet only, and only with a key-encryption key (config.ts).
  let custody: CustodyDeps | null = null
  let onSettled: (intent: Intent) => Promise<void> = async () => {}
  if (config.custody.enabled && config.custody.signer) {
    const cstore = new CustodyStore(db, now)
    const ops = new OpsSwitches(db, cstore, now, config.ops.hostPaused)
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
        config: {
          network: config.network,
          feeRecipient: null,
          recipient: config.linkRecipient,
          maxSlippagePpm: MAX_SLIPPAGE * 10_000,
          // One process: the signer checks Mini App approvals for this process's own bot (its id is the token's public prefix).
          telegram: config.telegramToken ? { botId: Number(config.telegramToken.split(':')[0]), publicKey: hexDecode(TELEGRAM_LAUNCH_KEYS.production) as Uint8Array } : null,
        },
        now,
        log,
      })
      transport = inProcessTransport(core)
      signerMode = `in-process (${core.keyRef})`
    } else {
      transport = httpSignerTransport({ url: signerConfig.url, authKey: signerConfig.authKey, fetch: signerConfig.tlsPin ? pinnedFetch(signerConfig.tlsPin) : fetchImpl })
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
        withdraw: withdrawHandler({ near, network: config.network, store: cstore }),
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
      onDone: (intent) => onTradeDone(intent),
      gate: ops.gate,
      instanceId: instance,
    })
    const recovery = createRecoveryService({ custody: cstore, signer, config })
    // Mini App links name the bot; its username is known once the bot token answers (getMe below).
    const telegram = createTelegramApprovals({ custody: cstore, signer, network: config.network.id, botUsername: () => botUsername })
    custody = { store: cstore, signer, engine, chain, swaps, recovery, ops, telegram }
    log.info('trading wallets on', { network: config.network.id, signer: signerMode })
  } else {
    log.info('trading wallets off', { reason: config.custody.reason })
  }

  // Invites and referral earnings: from what NearKit's fee account actually received on chain.
  const referrals = createReferrals({
    db,
    store,
    custody: custody?.store ?? null,
    network: config.network,
    feeRecipient: config.env.feeRecipient,
    audit: new CustodyStore(db, now),
    now,
    log,
  })
  onTradeDone = async (intent) => {
    const w = custody ? await custody.store.wallet(intent.walletId) : null
    await referrals.recordIntent(intent, w)
  }
  onHandoffTraded = async (t) =>
    void (await referrals.recordTrade({ source: 'handoff', sourceId: t.handoff.id, userId: t.handoff.userId, fee: t.fee, txHash: t.txHash, trader: t.handoff.accountId }))

  // Buy alerts read the chain on their own network; they need the bot to post. With
  // BUYBOT_RUNNER=separate this process only handles the groups' /buybot settings.
  const buybot: BuybotDeps | null = config.buybot.enabled && config.telegramToken ? buildBuybotDeps(config, db, fetchImpl, now, log, near) : null

  // NearKit web sign-in: sessions for the user's NearKit wallets on the website.
  const web = custody ? new WebSessions(db, now) : null
  // Volume Bots: configured on the web, stepped by the worker below, trading only through custody.
  const volumeBots = custody && web ? new VolumeBotStore(db, now) : null
  let botDeps: BotDeps | null = null

  let tg: TelegramApi | null = null
  let botUsername = config.telegramBotUsername ?? 'NearKitBot'
  let bot: BotApp | null = null
  let poller: ReturnType<typeof startPolling> | null = null
  let buybotRunner: ReturnType<typeof runBuybot> | null = null
  if (config.telegramToken) {
    tg = createTelegramApi({ token: config.telegramToken, fetch: fetchImpl, baseUrl: config.telegramApiUrl })
    const me = await tg.getMe()
    if (config.telegramBotUsername && me.username?.toLowerCase() !== config.telegramBotUsername.toLowerCase())
      throw new Error(`The bot token belongs to @${me.username ?? '?'}, not @${config.telegramBotUsername} (TELEGRAM_BOT_USERNAME).`)
    const webhook = await tg.getWebhookInfo()
    if (webhook.url) throw new Error('A webhook is set for this bot, so long polling cannot run. Remove the webhook (deleteWebhook) or stop the other deployment first.')
    botUsername = me.username ?? botUsername
    if (custody) {
      // Wallets with no owner wallet withdraw only to addresses approved in this bot's Mini App: the signer must check them.
      const h = await custody.signer.health().catch(() => null)
      if (h && h.telegram !== me.id)
        log.warn('the signer checks no Mini App approvals for this bot: new wallets need a linked wallet as their owner', { signerBot: h.telegram, bot: me.id })
    }
    const deps: BotDeps = {
      tg,
      store,
      config,
      near,
      link,
      log,
      now,
      me: { id: me.id, username: me.username ?? 'NearKitBot' },
      features: new Set(),
      buybot,
      handoffs,
      custody,
      referrals,
      web,
      volumeBots,
    }
    botDeps = deps
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
    // Results the resolver settles in the background (after a timeout or a restart) always reach the user:
    // in Telegram for what was started there, on NearKit web (its status) for what was started on the web.
    onSettled = async (intent) => {
      if (intent.chatId === WEB_CHAT) return
      await notifySettled(deps, (userId, html, markup) => app.notify(userId, html, markup), intent)
    }
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
    if (buybot && config.buybot.runner === 'app') buybotRunner = runBuybot({ bb: buybot, tg, config, leases, instance, log, now })
    else if (buybot) log.info('buybot settings here; alerts are posted by the separate buybot process')
  }

  // What /health reports about the kill switches and the signer, refreshed every 15 s (fails closed to "unknown").
  const health: { pauses: Record<string, boolean> | 'unknown'; signer: string } = { pauses: 'unknown', signer: custody ? 'unknown' : 'off' }
  const refreshHealth = async () => {
    const switches = new OpsSwitches(db, new CustodyStore(db, now), now, config.ops.hostPaused)
    health.pauses = await switches
      .state()
      .then((s) => ({ trading: s.trading.paused, withdrawals: s.withdrawals.paused, volumebot: s.volumebot.paused, bridge: s.bridge.paused }))
      .catch(() => 'unknown' as const)
    if (custody) {
      const h = await custody.signer.health().catch(() => null)
      health.signer = h === null ? 'unavailable' : h.paused ? 'paused' : h.ok ? 'ok' : `unhealthy (${h.kek !== 'ok' ? 'KEK' : 'database'})`
    }
  }
  await refreshHealth()
  const healthTimer = setInterval(() => void refreshHealth(), 15_000)
  healthTimer.unref()

  const onLinked = async (r: { accountId: string; userId: number; previousUserId: number | null }) => {
    if (!bot) return
    await bot.notify(r.userId, linkedText(r.accountId, config.network.label))
    if (r.previousUserId !== null) await bot.notify(r.previousUserId, movedAwayText(r.accountId))
  }
  // Bridge & Buy $KITS: NEAR Intents' 1Click API brings SOL, ETH or BNB to NEAR, then $KITS is bought (mainnet only).
  const bridgeStore = config.bridge.enabled ? new BridgeStore(db, now) : null
  const bridge =
    bridgeStore && config.env.feeRecipient
      ? createBridgeService({
          network: config.network,
          oneclick: createOneClick({ fetch: fetchImpl, baseUrl: config.bridge.oneclickUrl, apiKey: config.bridge.apiKey, now, log }),
          store: bridgeStore,
          near,
          feeRecipient: config.env.feeRecipient,
          custody,
          ops: new OpsSwitches(db, new CustodyStore(db, now), now, config.ops.hostPaused),
          fetch: fetchImpl,
          now,
          log,
        })
      : null
  if (!bridge) log.info('Bridge & Buy off', { reason: config.bridge.reason ?? 'no fee account' })

  const api: Server = createApiServer({
    config,
    log,
    routes: {
      ...linkRoutes({ link, onLinked }),
      ...handoffRoutes(handoffs),
      ...(kitsBurns ? kitsRoutes({ burns: kitsBurns }) : {}),
      ...(bridge ? bridgeRoutes({ bridge, sessions: web, solana: createSolanaReads({ rpcUrl: config.bridge.solanaRpcUrl, fetch: fetchImpl, now }) }) : {}),
      ...(custody
        ? recoveryRoutes({
            recovery: custody.recovery,
            // The wallet's Telegram account hears about every export at once, with Release it now (the Mini App) and Cancel.
            // Not told (no bot here, blocked, Telegram down): the route cancels the export.
            onExportRequested: async (r) => {
              if (!bot) return false
              if (r.wallet.userId !== r.userId) log.warn('export notice: the signer and this app name different Telegram accounts', { wallet: r.accountId })
              const n = exportRequestedNotice({ ...r, wallet: r.wallet }, custody.telegram.link(r))
              return bot.notify(r.userId, n.text, n.markup)
            },
            // And when the key was collected, or the export cancelled on the web.
            onExported: async (r) => void (await bot?.notify(r.userId, exportedText(r), keyboard([btn('📤 Withdraw', 'cw:wd'), btn('👛 Wallet', 'cw:home')]))),
            onExportCancelled: async (r) => void (await bot?.notify(r.userId, exportCancelledText(r))),
            onDestinationApproved: async (r) =>
              void (await bot?.notify(r.userId, approvedText(r.wallet, r.destination), keyboard([btn('▶️ Continue withdrawal', 'cw:wcont'), btn('👛 Wallet', 'cw:home')]))),
          })
        : {}),
      ...(custody && web
        ? webRoutes({
            sessions: web,
            custody,
            store,
            near,
            network: config.network,
            now,
            // With no bot running here, no wallet without an owner wallet is created (fail-safe).
            approvalsOn: async () => (botDeps ? telegramApprovalsOn(botDeps) : false),
            linkedAccount: (userId) => linkedAccountOf(store, userId, config.network.id),
            // Security notices only (a wallet created on the web); nothing waits for them.
            notify: async (userId, html, markup) => (bot ? bot.notify(userId, html, markup) : false),
            log,
            volumeBots,
          })
        : {}),
      ...(custody && web && volumeBots
        ? botRoutes({
            sessions: web,
            custody,
            bots: volumeBots,
            near,
            network: config.network,
            now,
            // The security notice when a bot starts on the web; nothing waits for it.
            notify: async (userId, html) => (bot ? bot.notify(userId, html) : false),
            log,
          })
        : {}),
      ...(custody
        ? telegramRoutes({
            approvals: custody.telegram,
            // The wallet's Telegram user hears about every approval given in the Mini App.
            onApproved: async (r) => {
              const n = telegramApprovedText(r)
              await bot?.notify(r.userId, n.text, n.markup)
            },
          })
        : {}),
    },
    limits: API_LIMITS,
    // Public and secret-free: whether the bot and buy alerts run, the kill switches, the signer, and the boot count (see Store.recordBoot).
    health: () => ({
      bot: bot ? true : false,
      buybot: buybotRunner ? 'running' : !config.buybot.enabled ? 'off' : config.buybot.runner === 'separate' ? 'separate process' : 'needs the bot token',
      wallets: custody ? 'on' : 'off',
      volumebot: volumeRunner ? 'running' : 'off',
      bridge: bridge ? 'on' : 'off',
      pauses: health.pauses,
      signer: health.signer,
      boot: boot.boot,
    }),
    now,
  })
  // The Volume Bot's worker: each bot is stepped under its own lease, so instances never double up.
  const volumeRunner =
    custody && volumeBots && config.volumeBot.runner === 'app'
      ? createVolumeBotRunner({
          store: volumeBots,
          custody,
          near,
          network: config.network,
          log,
          instanceId: instance,
          now,
          notify: async (userId, text) => void (bot ? await bot.notify(userId, esc(text)) : undefined),
        })
      : null
  volumeRunner?.start()
  // Bridge & Buy orders, each stepped under its own lease (NEAR Intents' status, then the $KITS purchase).
  const bridgeWorker = bridge && bridgeStore ? createBridgeWorker({ bridge, store: bridgeStore, instanceId: instance, log }) : null
  bridgeWorker?.start()
  if (volumeRunner) log.info('Volume Bot worker running')

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
        await web?.prune()
        await buybot?.store.prune(7 * 86_400_000)
        await volumeBots?.prune()
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
      clearInterval(healthTimer)
      clearInterval(housekeeping)
      clearInterval(resolver)
      // No bot starts a new step; the one under way finishes (its trade is settled from its intent after a restart anyway).
      await volumeRunner?.stop()
      await bridgeWorker?.stop()
      await buybotRunner?.stop()
      await poller?.stop()
      await new Promise<void>((resolve) => api.close(() => resolve()))
      // Trades started on NearKit web finish recording their state before the database closes,
      // as the poller lets Telegram's finish.
      await webRunsSettled()
      await db.close()
      log.info('NEARKITS server stopped')
    },
  }
}
