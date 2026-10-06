import { VolumeBotStore } from '../volumebot/store'
import { createFakeChain, type FakeChainOptions } from '@/services/real/testing/fakeChain'
import { WebSessions } from '../web/sessions'
import type { Follower, TxIndex } from '../buybot/follower'
import { createBuyMarket } from '../buybot/market'
import { BuybotStore } from '../buybot/store'
import { loadConfig } from '../config'
import { Leases } from '../db/leases'
import { openTestDatabase, type TestEngine } from '../db/testing'
import { Store } from '../db/store'
import { createLinkService } from '../link/service'
import { createHandoffs } from '../trade/handoff'
import { silentLogger, type Logger } from '../log'
import { createServerNear } from '../near'
import { createTelegramApi } from '../telegram/api'
import { createFakeTelegram } from '../telegram/fake'
import type { TgChat, TgUpdate, TgUser } from '../telegram/types'
import { createChainAccess } from '../custody/chain'
import { createEngine } from '../custody/engine'
import { createSignerClient, inProcessTransport } from '../custody/signer'
import { CustodyStore } from '../custody/store'
import { keyring, localKeyWrapper } from '../custody/vault'
import { MAX_SLIPPAGE } from '@/lib/fees'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSignerChain } from '../signer/chain'
import { httpSignerTransport } from '../signer/client'
import { startSignerService } from '../signer/service'
import { createSignerCore } from '../signer/core'
import { createRouteOracle } from '../signer/routes'
import { migrateSigner } from '../signer/schema'
import { SignerStore } from '../signer/store'
import { telegramSigner } from '../signer/testing'
import { createTelegramApprovals } from '../custody/telegramApprovals'
import type { CustodyDeps } from '../custody/wallets'
import { withdrawHandler } from '../custody/withdraw'
import { createSwapService } from '../custody/swap'
import { unwrapHandler } from '../custody/unwrap'
import { backupKeyHandler, createRecoveryService, revokeHandler } from '../custody/recovery'
import { createBotApp } from './app'
import type { BotDeps, BotModule } from './context'
import { notifySettled } from './intents'
import { walletErrorText } from './ui'
import { createReferrals } from '../referrals/service'
import { OpsSwitches } from '../ops/switches'

/**
 * A whole bot wired to fakes: Telegram (fake.ts), NEAR (fakeChain) and an
 * in-memory database. Tests drive it with the same updates Telegram sends.
 */

export const ALICE: TgUser = { id: 101, is_bot: false, first_name: 'Alice', username: 'alice', language_code: 'en' }
export const privateChat = (user: TgUser): TgChat => ({ id: user.id, type: 'private', first_name: user.first_name })
export const GROUP: TgChat = { id: -100555, type: 'supergroup', title: 'Test group' }

/** Test-only key-encryption key for trading wallets. */
export const TEST_KEK = Buffer.alloc(32, 42).toString('base64')

/** The harness bot (getMe): Telegram signs its Mini App launches for this id. */
export const BOT_ME = { id: 1111111111, username: 'NearKitBot' }

export async function botHarness(
  options: {
    env?: Record<string, string>
    chain?: FakeChainOptions
    modules?: (deps: BotDeps) => BotModule[]
    buybot?: boolean
    custody?: boolean
    /**
     * The signer as production runs it: a separate service reached over signed HTTP, with
     * its own database (the default is the signer in this process, as on testnet).
     */
    remoteSigner?: boolean
    /** Where the bot and the engine log (silent by default). */
    log?: Logger
    /** False: the signer checks no Mini App approvals (a server without them set up). */
    telegramApprovals?: boolean
  } = {},
) {
  const log = options.log ?? silentLogger
  let clock = 10_000_000
  const now = () => clock
  const fake = createFakeTelegram()
  const tg = createTelegramApi({ token: fake.token, fetch: fake.fetch, sleep: async () => {}, now })
  // SQLite by default; NEARKIT_TEST_BOT_DB=pglite runs the whole bot on the production dialect.
  const db = await openTestDatabase((process.env.NEARKIT_TEST_BOT_DB as TestEngine | undefined) ?? 'sqlite')
  const store = new Store(db, now)
  const { config } = loadConfig({ NEAR_NETWORK: 'testnet', ...(options.custody ? { NEARKIT_WALLET_KEK: TEST_KEK } : {}), ...options.env })
  const chain = createFakeChain(options.chain ?? {})
  const near = createServerNear(config, chain.fetch, now)
  const link = createLinkService({ store, config, rpc: near.ctx.rpc, now })
  let notify: (userId: number, html: string) => Promise<void> = async () => {}
  let onHandoffTraded: NonNullable<Parameters<typeof createHandoffs>[0]['onTraded']> = async () => {}
  let onTradeDone: (intent: import('../custody/store').Intent) => Promise<void> = async () => {}
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
    notify: (userId, html) => notify(userId, html),
    onTraded: (t) => onHandoffTraded(t),
  })
  let custody: CustodyDeps | null = null
  // Telegram, as far as the Mini App goes: a stand-in key signing launches for the harness bot.
  const telegram = await telegramSigner(BOT_ME.id)
  let signerCore: ReturnType<typeof createSignerCore> | null = null
  let signerVault: SignerStore | null = null
  let settledNotice: Parameters<typeof notifySettled>[1] = async () => false
  let stopSigner: (() => Promise<void>) | null = null
  if (config.custody.enabled && config.custody.signer?.kind === 'in-process') {
    const cstore = new CustodyStore(db, now)
    const ops = new OpsSwitches(db, cstore, now, config.ops.hostPaused)
    let transport
    if (options.remoteSigner) {
      const dir = mkdtempSync(join(tmpdir(), 'nearkit-harness-signer-'))
      const authKey = randomBytes(32)
      const service = await startSignerService({
        env: {
          NEAR_NETWORK: 'testnet',
          NEARKIT_SIGNER_AUTH_KEY: authKey.toString('base64'),
          NEARKIT_SIGNER_KEK: config.custody.signer.kek.toString('base64'),
          NEARKIT_SIGNER_DB_PATH: join(dir, 'signer.sqlite'),
          NEARKIT_SIGNER_RECIPIENT: config.linkRecipient,
          NEARKIT_SIGNER_PORT: '0',
        },
        fetch: chain.fetch,
        now,
        log,
        telegram: options.telegramApprovals === false ? null : telegram.check,
      })
      stopSigner = async () => {
        await service.stop()
        rmSync(dir, { recursive: true, force: true })
      }
      signerCore = service.core
      signerVault = service.store
      transport = httpSignerTransport({ url: `http://127.0.0.1:${service.port}`, authKey, now })
    } else {
      await migrateSigner(db)
      const signerStore = new SignerStore(db, now)
      const core = createSignerCore({
        store: signerStore,
        keys: keyring(localKeyWrapper(config.custody.signer.kek)),
        chain: createSignerChain({ rpcUrls: config.network.rpcUrls, quorum: 1, fetch: chain.fetch }),
        oracle: createRouteOracle(config.network, chain.fetch),
        config: {
          network: config.network,
          feeRecipient: null,
          recipient: config.linkRecipient,
          maxSlippagePpm: MAX_SLIPPAGE * 10_000,
          telegram: options.telegramApprovals === false ? null : telegram.check,
        },
        now,
        log,
      })
      signerCore = core
      signerVault = signerStore
      transport = inProcessTransport(core)
    }
    const signer = createSignerClient(transport)
    const access = createChainAccess({ rpc: near.ctx.rpc, fetch: chain.fetch })
    const swaps = createSwapService(near)
    const engine = createEngine({
      store: cstore,
      signer,
      chain: access,
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
      sleep: async (ms) => void (clock += ms),
      confirmMs: 2_000,
      explain: (e) => walletErrorText(e, { network: config.network.id }),
      onSettled: (intent) => notifySettled(deps, settledNotice, intent),
      onDone: (intent) => onTradeDone(intent),
      gate: ops.gate,
    })
    const recovery = createRecoveryService({ custody: cstore, signer, config })
    const approvals = createTelegramApprovals({ custody: cstore, signer, network: config.network.id, botUsername: BOT_ME.username })
    custody = { store: cstore, signer, engine, chain: access, swaps, recovery, ops, telegram: approvals }
  }
  const deps: BotDeps = {
    tg,
    store,
    config,
    near,
    link,
    handoffs,
    log,
    now,
    me: BOT_ME,
    features: new Set(),
    buybot: null,
    custody,
    referrals: null,
    web: custody ? new WebSessions(db, now) : null,
    volumeBots: custody ? new VolumeBotStore(db, now) : null,
  }
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
  deps.referrals = referrals
  onTradeDone = async (intent) => {
    const w = custody ? await custody.store.wallet(intent.walletId) : null
    await referrals.recordIntent(intent, w)
  }
  onHandoffTraded = async (t) =>
    void (await referrals.recordTrade({ source: 'handoff', sourceId: t.handoff.id, userId: t.handoff.userId, fee: t.fee, txHash: t.txHash, trader: t.handoff.accountId }))
  if (options.buybot) {
    const follower = { step: async () => 'idle' as const, finalHeight: async () => 5000 } as unknown as Follower
    const index = { recent: async () => ({ txs: [], resumeToken: null }), transactions: async () => new Map() } as unknown as TxIndex
    deps.buybot = { store: new BuybotStore(db, now), near, market: createBuyMarket(near, now), follower, index }
  }
  const modules = options.modules?.(deps) ?? []
  const leases = new Leases(db, now)
  // Like production: an update ID is handled once, however often Telegram delivers it.
  const app = createBotApp(deps, modules, { firstDelivery: (id) => leases.firstDelivery(id) })
  notify = async (userId, html) => void (await app.notify(userId, html))
  settledNotice = (userId, html, markup) => app.notify(userId, html, markup)
  let messageId = 500

  const send = async (update: Omit<TgUpdate, 'update_id'>) => {
    const u = fake.push(update)
    await app.handle(u)
  }

  return {
    fake,
    db,
    store,
    chain,
    /** Telegram's stand-in: signs the Mini App launch data a user's approval carries. */
    telegram,
    /** The signer (in this process, as on testnet, or the separate service) and its own tables. */
    signerCore,
    signerVault,
    /** Stops the separate signer service, when there is one. */
    stopSigner: async () => void (await stopSigner?.()),
    config,
    deps,
    app,
    advance: (ms: number) => void (clock += ms),
    /** A user typing `text` into `chat`. */
    say: (text: string, user: TgUser = ALICE, chat: TgChat = privateChat(user)) =>
      send({
        message: {
          message_id: messageId++,
          date: 0,
          chat,
          from: user,
          text,
          ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(/\s/)[0]?.length ?? 1 }] } : {}),
        },
      }),
    /** A user pressing a button with `data` on message `messageId`. */
    press: (data: string, user: TgUser = ALICE, chat: TgChat = privateChat(user), onMessage = 1) =>
      send({ callback_query: { id: `cb${messageId++}`, from: user, data, message: { message_id: onMessage, date: 0, chat, text: '' } } }),
    last: () => fake.messages().at(-1),
    /** Every button on the last message, by label. */
    buttons: () => fake.messages().at(-1)?.buttons ?? [],
  }
}
