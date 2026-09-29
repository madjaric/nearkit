import { createFakeChain, type FakeChainOptions } from '@/services/real/testing/fakeChain'
import type { Follower, TxIndex } from '../buybot/follower'
import { createBuyMarket } from '../buybot/market'
import { BuybotStore } from '../buybot/store'
import { loadConfig } from '../config'
import { migrate } from '../db/schema'
import { Db } from '../db/sqlite'
import { Store } from '../db/store'
import { createLinkService } from '../link/service'
import { createHandoffs } from '../trade/handoff'
import { silentLogger } from '../log'
import { createServerNear } from '../near'
import { createTelegramApi } from '../telegram/api'
import { createFakeTelegram } from '../telegram/fake'
import type { TgChat, TgUpdate, TgUser } from '../telegram/types'
import { createBotApp } from './app'
import type { BotDeps, BotModule } from './context'

/**
 * A whole bot wired to fakes: Telegram (fake.ts), NEAR (fakeChain) and an
 * in-memory database. Tests drive it with the same updates Telegram sends.
 */

export const ALICE: TgUser = { id: 101, is_bot: false, first_name: 'Alice', username: 'alice', language_code: 'en' }
export const privateChat = (user: TgUser): TgChat => ({ id: user.id, type: 'private', first_name: user.first_name })
export const GROUP: TgChat = { id: -100555, type: 'supergroup', title: 'Test group' }

export async function botHarness(options: { env?: Record<string, string>; chain?: FakeChainOptions; modules?: (deps: BotDeps) => BotModule[]; buybot?: boolean } = {}) {
  let clock = 10_000_000
  const now = () => clock
  const fake = createFakeTelegram()
  const tg = createTelegramApi({ token: fake.token, fetch: fake.fetch, sleep: async () => {}, now })
  const db = await Db.open(null)
  migrate(db)
  const store = new Store(db, now)
  const { config } = loadConfig({ NEAR_NETWORK: 'testnet', ...options.env })
  const chain = createFakeChain(options.chain ?? {})
  const near = createServerNear(config, chain.fetch, now)
  const link = createLinkService({ store, config, rpc: near.ctx.rpc, now })
  let notify: (userId: number, html: string) => Promise<void> = async () => {}
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
  })
  const deps: BotDeps = { tg, store, config, near, link, handoffs, log: silentLogger, now, me: { id: 1111111111, username: 'NearKitBot' }, features: new Set(), buybot: null }
  if (options.buybot) {
    const follower = { step: async () => 'idle' as const, finalHeight: async () => 5000 } as unknown as Follower
    const index = { recent: async () => ({ txs: [], resumeToken: null }), transactions: async () => new Map() } as unknown as TxIndex
    deps.buybot = { store: new BuybotStore(db, now), near, market: createBuyMarket(near, now), follower, index }
  }
  const modules = options.modules?.(deps) ?? []
  const app = createBotApp(deps, modules)
  notify = async (userId, html) => void (await app.notify(userId, html))
  let messageId = 500

  const send = async (update: Omit<TgUpdate, 'update_id'>) => {
    const u = fake.push(update)
    await app.handle(u)
  }

  return {
    fake,
    store,
    chain,
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
