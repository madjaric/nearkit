import { randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { NETWORKS } from '@/config/networks'
import { createRpcClient, type RpcTxResult } from '@/services/near/rpc'
import { createFakeChain, type FakeChain } from '@/services/real/testing/fakeChain'
import { migrate } from '../db/schema'
import { SqliteDatabase } from '../db/sqlite'
import { Store } from '../db/store'
import { createLogger } from '../log'
import { TEST_OWNER_KEY, testSigner } from '../signer/testing'
import { createChainAccess, type ChainAccess } from './chain'
import { createEngine, type IntentHandler } from './engine'
import type { TradingSigner } from './signer'
import { CustodyStore, type TradingWallet } from './store'

/**
 * A Telegram buy is reported as bought when its tokens arrive; the chain's last settlement
 * callbacks are filed afterwards, in the background, without telling the user twice. Until
 * the chain shows either, it stays in progress: never failed on a timeout.
 */

const ONE = 10n ** 24n
const KEK = randomBytes(32)
const net = NETWORKS.testnet

let clock: number
let chain: FakeChain
let store: CustodyStore
let access: ChainAccess
let signer: TradingSigner
let wallet: TradingWallet
/** What the chain shows for the trade's transaction: still running, tokens delivered (settlement running), or final. */
let stage: 'running' | 'delivered' | 'final'
let deliveredAfterPolls: number
let polls: number

const DELIVERED_LOG = 'EVENT_JSON:{"event":"withdraw_succeeded","data":[{"token_id":"token.testnet"}]}'

/** A stand-in trade: its plan is one transfer the fake chain runs; "delivered" is a log line in its partial record. */
const trade: IntentHandler = {
  async plan(intent) {
    const p = intent.params as { to: string; amount: string }
    return {
      kind: 'plan',
      op: { kind: 'withdraw-near', to: p.to, amount: BigInt(p.amount) },
      plan: [{ receiverId: p.to, actions: [{ kind: 'transfer', deposit: p.amount }], label: 'Trade' }],
    }
  },
  async summarize(_intent, _wallet, confirmed) {
    const ok = confirmed.every((c) => 'SuccessValue' in (c.result.status as object))
    return { ok, message: ok ? 'Buy confirmed.' : 'Buy failed.', hashes: confirmed.map((c) => c.hash), facts: { settledBy: 'final' } }
  },
  delivered(_intent, _wallet, earlier, last) {
    const arrived = last.result.receipts_outcome.some((o) => o.outcome.logs.includes(DELIVERED_LOG))
    return arrived ? { ok: true, message: 'Buy confirmed.', hashes: [...earlier, last].map((c) => c.hash), facts: { delivered: true } } : null
  },
}

function running(hash: string, signerId: string, delivered: boolean): RpcTxResult {
  return {
    final_execution_status: 'INCLUDED_FINAL',
    status: 'Started',
    transaction: { hash, signer_id: signerId, receiver_id: 'bob.testnet', actions: [] },
    transaction_outcome: { id: hash, outcome: { logs: [], receipt_ids: ['r1'], gas_burnt: 1, tokens_burnt: '0', executor_id: signerId, status: { SuccessReceiptId: 'r1' } } },
    receipts_outcome: delivered
      ? [{ id: 'r1', outcome: { logs: [DELIVERED_LOG], receipt_ids: [], gas_burnt: 1, tokens_burnt: '0', executor_id: 'aggregator.testnet', status: { SuccessValue: '' } } }]
      : [],
  }
}

/** The real chain access, with the trade's status scripted: running → delivered → final. */
function scripted(real: ChainAccess): ChainAccess {
  const shows = () => (stage === 'running' && polls >= deliveredAfterPolls ? 'delivered' : stage)
  return {
    ...real,
    status: async (hash, signerId) => (shows() === 'final' ? real.status(hash, signerId) : null),
    seen: async () => true,
    progress: async (hash, signerId) => {
      polls += 1
      const now = shows()
      return now === 'final' ? real.status(hash, signerId) : running(hash, signerId, now === 'delivered')
    },
  }
}

const engineFor = (settled: string[]) =>
  createEngine({
    store,
    signer,
    chain: scripted(access),
    handlers: { buy: trade },
    log: createLogger({ level: 'error', sink: () => undefined }),
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    confirmMs: 5_000,
    onSettled: async (i) => void settled.push(i.id),
  })

const buyIntent = () => store.createIntent({ walletId: wallet.id, userId: 101, chatId: 101, kind: 'buy', params: { to: 'bob.testnet', amount: ONE.toString() }, ttlMs: 60_000 })

beforeEach(async () => {
  clock = 50_000_000
  stage = 'running'
  deliveredAfterPolls = Number.POSITIVE_INFINITY
  polls = 0
  const db = await SqliteDatabase.open(null)
  await migrate(db)
  await new Store(db, () => clock).upsertUser({ userId: 101, username: 'alice', firstName: 'Alice', languageCode: null })
  store = new CustodyStore(db, () => clock)
  chain = createFakeChain({ accounts: { 'bob.testnet': { amount: 0n } } })
  access = createChainAccess({ rpc: createRpcClient({ urls: ['https://rpc.test'], fetch: chain.fetch }), fetch: chain.fetch })
  const s = await testSigner(db, { network: net, kek: KEK, fetch: chain.fetch, now: () => clock })
  signer = s.signer
  const owner = { accountId: 'bob.testnet', publicKey: TEST_OWNER_KEY }
  const key = await signer.createKey({ userId: 101, owner })
  wallet = (await store.createWallet({ userId: 101, network: 'testnet', accountId: key.accountId, publicKey: key.publicKey, keyRef: key.keyRef, owner })).wallet
  chain.fund(wallet.accountId, 5n * ONE)
})

describe('Bought at delivery (Telegram)', () => {
  it('reports the buy as done the moment the tokens arrive, while the chain’s settlement still runs', async () => {
    deliveredAfterPolls = 3
    const settled: string[] = []
    const i = await buyIntent()
    const r = await engineFor(settled).execute(i.id, 101)
    expect(r).toMatchObject({ kind: 'finished', intent: { status: 'done', result: { ok: true, message: 'Buy confirmed.', facts: { delivered: true } } } })
    // The swap transaction itself isn't final yet: it stays open until the settlement is filed.
    expect(await store.txsOf(i.id)).toMatchObject([{ step: 0, status: 'submitted' }])
    expect(chain.sent).toHaveLength(1)
  })

  it('files the final settlement later in the background, without a second message', async () => {
    deliveredAfterPolls = 1
    const settled: string[] = []
    const engine = engineFor(settled)
    const i = await buyIntent()
    await engine.execute(i.id, 101)
    stage = 'final'
    await engine.resolvePending()
    expect(await store.txsOf(i.id)).toMatchObject([{ step: 0, status: 'success' }])
    expect((await store.auditOf(wallet.id)).some((a) => a.action === 'tx-settled')).toBe(true)
    expect(settled).toEqual([])
    // The result the user saw stays as it was.
    expect((await store.intent(i.id))?.result).toMatchObject({ ok: true, facts: { delivered: true } })
  })

  it('a buy still running when the live wait ends is handed to the resolver, which reports it bought on delivery, once', async () => {
    const settled: string[] = []
    const engine = engineFor(settled)
    const i = await buyIntent()
    expect((await engine.execute(i.id, 101)).kind).toBe('pending')
    // Still running on chain: the resolver leaves it in progress, not failed.
    await engine.resolvePending()
    expect((await store.intent(i.id))?.status).toBe('submitted')
    expect(settled).toEqual([])
    stage = 'delivered'
    await engine.resolvePending()
    expect(await store.intent(i.id)).toMatchObject({ status: 'done', result: { ok: true, facts: { delivered: true } } })
    expect(settled).toEqual([i.id])
    stage = 'final'
    await engine.resolvePending()
    expect(settled).toEqual([i.id])
    expect(await store.txsOf(i.id)).toMatchObject([{ status: 'success' }])
  })

  it('once bought, the wallet can trade again while the settlement is still filed in the background', async () => {
    deliveredAfterPolls = 1
    const engine = engineFor([])
    await engine.execute((await buyIntent()).id, 101)
    const next = await buyIntent()
    expect((await engine.execute(next.id, 101)).kind).not.toBe('refused')
  })

  it('a trade the chain finished without delivering is judged from its final record', async () => {
    stage = 'final'
    const r = await engineFor([]).execute((await buyIntent()).id, 101)
    // The stand-in's final record (a plain transfer) is summarized as usual.
    expect(r).toMatchObject({ kind: 'finished', intent: { status: 'done', result: { facts: { settledBy: 'final' } } } })
  })
})

describe('a delivery check that breaks', () => {
  it('never breaks the trade: it stays in progress and is judged from its final record', async () => {
    const settled: string[] = []
    const broken: IntentHandler = {
      ...trade,
      delivered() {
        throw new Error('unreadable receipts')
      },
    }
    const engine = createEngine({
      store,
      signer,
      chain: scripted(access),
      handlers: { buy: broken },
      log: createLogger({ level: 'error', sink: () => undefined }),
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
      confirmMs: 5_000,
      onSettled: async (i) => void settled.push(i.id),
    })
    const i = await buyIntent()
    expect((await engine.execute(i.id, 101)).kind).toBe('pending')
    await engine.resolvePending()
    expect((await store.intent(i.id))?.status).toBe('submitted')
    stage = 'final'
    await engine.resolvePending()
    expect(await store.intent(i.id)).toMatchObject({ status: 'done', result: { facts: { settledBy: 'final' } } })
    expect(settled).toEqual([i.id])
  })
})
