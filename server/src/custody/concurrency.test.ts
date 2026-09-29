import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { NETWORKS } from '@/config/networks'
import { createRpcClient } from '@/services/near/rpc'
import { createFakeChain, type FakeChain } from '@/services/real/testing/fakeChain'
import type { Database } from '../db/database'
import { Store } from '../db/store'
import { anotherInstance, ENGINE_TIMEOUT_MS, openTestDatabase, TEST_ENGINES, type TestEngine } from '../db/testing'
import { silentLogger } from '../log'
import { createChainAccess } from './chain'
import { createEngine, type Engine, type IntentHandler, type PlanOutcome } from './engine'
import { createLocalSigner, type TradingSigner } from './signer'
import { CustodyStore, EXECUTION_LEASE_MS, type TradingWallet } from './store'
import { localKeyWrapper } from './vault'

/**
 * The invariant for production (many server instances on one Postgres): one
 * Confirm executes at most once, whoever races. On Postgres each "instance" here
 * has its own connection pool, so the races are real; on SQLite and PGlite (one
 * connection) the same checks exercise the logic.
 */

const ONE = 10n ** 24n
const KEK = randomBytes(32)

interface World {
  chain: FakeChain
  wallet: TradingWallet
  clock: { t: number }
  /** A server instance: its own database connection(s), store and engine. */
  instance(
    name: string,
    plan?: (p: { to: string; amount: string }) => Promise<PlanOutcome>,
    /** Runs while the signer signs (e.g. a stall long enough to lose the lease). */
    whileSigning?: () => Promise<void>,
  ): { store: CustodyStore; engine: Engine; db: Database }
  intent(amount?: bigint): Promise<string>
}

async function world(engine: TestEngine): Promise<World> {
  const db = await openTestDatabase(engine)
  const clock = { t: 50_000_000 }
  await new Store(db, () => clock.t).upsertUser({ userId: 101, username: 'alice', firstName: 'Alice', languageCode: null })
  const chain = createFakeChain({ accounts: { 'bob.testnet': { amount: 0n } } })
  const access = createChainAccess({ rpc: createRpcClient({ urls: ['https://rpc.test'], fetch: chain.fetch }), fetch: chain.fetch })
  const base = new CustodyStore(db, () => clock.t)
  const signer = createLocalSigner({ wrapper: localKeyWrapper(KEK), network: NETWORKS.testnet, store: base, now: () => clock.t })
  const wallet = (await base.createWallet({ userId: 101, network: 'testnet', ...(await signer.createKey('testnet')), keyRef: signer.keyRef })).wallet
  chain.fund(wallet.accountId, 50n * ONE)
  let first = true
  return {
    chain,
    wallet,
    clock,
    instance(name, plan, whileSigning) {
      // The first instance uses the test database; each later one opens its own pool (on Postgres).
      const idb = first || engine !== 'postgres' ? db : anotherInstance(db)
      first = false
      const store = new CustodyStore(idb, () => clock.t)
      const withdraw: IntentHandler = {
        async plan(intent) {
          const p = intent.params as { to: string; amount: string }
          if (plan) return plan(p)
          return {
            kind: 'plan',
            op: { kind: 'withdraw-near', to: p.to, amount: BigInt(p.amount) },
            plan: [{ receiverId: p.to, actions: [{ kind: 'transfer', deposit: p.amount }], label: 'Withdraw' }],
          }
        },
        async summarize(_i, _w, confirmed) {
          return { ok: true, message: 'Sent.', hashes: confirmed.map((c) => c.hash) }
        },
      }
      const local = createLocalSigner({ wrapper: localKeyWrapper(KEK), network: NETWORKS.testnet, store, now: () => clock.t })
      const signer: TradingSigner = {
        ...local,
        async sign(req) {
          const signed = await local.sign(req)
          await whileSigning?.()
          return signed
        },
      }
      const engineOf = createEngine({
        store,
        signer,
        chain: access,
        handlers: { withdraw },
        log: silentLogger,
        now: () => clock.t,
        sleep: async () => undefined,
        confirmMs: 1_000,
        instanceId: name,
      })
      return { store, engine: engineOf, db: idb }
    },
    async intent(amount = ONE) {
      return (
        await base.createIntent({ walletId: wallet.id, userId: 101, chatId: 101, kind: 'withdraw', params: { to: 'bob.testnet', amount: amount.toString() }, ttlMs: 600_000 })
      ).id
    },
  }
}

describe.each(TEST_ENGINES)(
  'two server instances on %s',
  (engine) => {
    it('pressing Confirm on both at once: exactly one sends, once', async () => {
      const w = await world(engine)
      const a = w.instance('a')
      const b = w.instance('b')
      const id = await w.intent()
      const results = await Promise.all([a.engine.execute(id, 101), b.engine.execute(id, 101), a.engine.execute(id, 101), b.engine.execute(id, 101)])
      expect(results.filter((r) => r.kind === 'finished')).toHaveLength(1)
      expect(results.filter((r) => r.kind === 'refused')).toHaveLength(3)
      expect(w.chain.sent).toHaveLength(1)
      expect(w.chain.accounts.get('bob.testnet')?.amount).toBe(ONE)
      expect((await a.store.txsOf(id)).map((t) => t.step)).toEqual([0])
    })

    it('two intents of one wallet confirmed at once on two instances: one goes in flight, the other is refused as busy', async () => {
      const w = await world(engine)
      const a = w.instance('a')
      const b = w.instance('b')
      const [x, y] = [await w.intent(), await w.intent(2n * ONE)]
      const [cx, cy] = await Promise.all([a.store.confirmIntent(x, 101, { owner: 'a', ms: 60_000 }), b.store.confirmIntent(y, 101, { owner: 'b', ms: 60_000 })])
      expect([cx.ok, cy.ok].filter(Boolean)).toHaveLength(1)
      expect([cx, cy].find((c) => !c.ok)).toMatchObject({ reason: 'busy' })
      expect(await a.store.inFlight(w.wallet.id)).toHaveLength(1)
    })

    it('resolvers on both instances race for an unattended intent: exactly one takes it', async () => {
      const w = await world(engine)
      const a = w.instance('a')
      const b = w.instance('b')
      const id = await w.intent()
      await a.store.confirmIntent(id, 101, { owner: 'crashed', ms: 60_000 })
      // While the crashed instance's lease lasts, nobody may take it.
      expect(await Promise.all([a.store.claimIntent(id, 'ra', 60_000), b.store.claimIntent(id, 'rb', 60_000)])).toEqual([false, false])
      w.clock.t += 60_001
      const won = await Promise.all([a.store.claimIntent(id, 'ra', 60_000), b.store.claimIntent(id, 'rb', 60_000), a.store.claimIntent(id, 'ra2', 60_000)])
      expect(won.filter(Boolean)).toHaveLength(1)
      // And both resolvers sweeping at once settle it once.
      w.clock.t += 60_001
      const settled = (await Promise.all([a.engine.resolvePending(), b.engine.resolvePending()])).flat()
      expect(settled.map((i) => i.id)).toEqual([id])
      expect(w.chain.sent).toHaveLength(0)
    })

    it('an instance that stalls past its lease signs nothing: the one that took over reports, nothing is sent', async () => {
      const w = await world(engine)
      const b = w.instance('b')
      let tookOver: unknown[] = []
      const a = w.instance('a', async (p) => {
        // Stalls (a long GC pause, a hung RPC) past its lease; meanwhile b's resolver takes the intent.
        w.clock.t += EXECUTION_LEASE_MS + 1
        tookOver = await b.engine.resolvePending()
        return {
          kind: 'plan',
          op: { kind: 'withdraw-near', to: p.to, amount: BigInt(p.amount) },
          plan: [{ receiverId: p.to, actions: [{ kind: 'transfer', deposit: p.amount }], label: 'Withdraw' }],
        }
      })
      const id = await w.intent()
      const r = await a.engine.execute(id, 101)
      expect(tookOver).toMatchObject([{ id, status: 'failed', result: { message: expect.stringMatching(/before sending anything/) } }])
      expect(r.kind).toBe('pending')
      expect(w.chain.sent).toHaveLength(0)
      expect(await a.store.txsOf(id)).toEqual([])
      expect((await a.store.auditOf(w.wallet.id)).filter((e) => e.action === 'intent-failed')).toHaveLength(1)
    })

    it('an instance that loses its lease while signing records nothing and sends nothing', async () => {
      const w = await world(engine)
      const b = w.instance('b')
      let tookOver: unknown[] = []
      const a = w.instance('a', undefined, async () => {
        // The signature took so long (a slow key service) that the lease expired and b took over.
        w.clock.t += EXECUTION_LEASE_MS + 1
        tookOver = await b.engine.resolvePending()
      })
      const id = await w.intent()
      const r = await a.engine.execute(id, 101)
      expect(tookOver).toMatchObject([{ id, status: 'failed' }])
      expect(r.kind).toBe('pending')
      // The signed transaction was never recorded, so it was never sent: "nothing was sent" is true.
      expect(await a.store.txsOf(id)).toEqual([])
      expect(w.chain.sent).toHaveLength(0)
    })
  },
  ENGINE_TIMEOUT_MS,
)
