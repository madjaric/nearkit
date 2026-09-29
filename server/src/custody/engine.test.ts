import { randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { NETWORKS } from '@/config/networks'
import { base64Encode } from '@/lib/encoding'
import { createRpcClient } from '@/services/near/rpc'
import { createFakeChain, type FakeChain } from '@/services/real/testing/fakeChain'
import { migrate } from '../db/schema'
import { Db } from '../db/sqlite'
import { Store } from '../db/store'
import { createLogger } from '../log'
import { createChainAccess, type ChainAccess } from './chain'
import { AMBIGUOUS_GRACE_BLOCKS, createEngine, type IntentHandler, type PlanOutcome } from './engine'
import { secretKeyText } from './keys'
import { createLocalSigner, walletAad, type TradingSigner } from './signer'
import { CustodyStore, type TradingWallet } from './store'
import { localKeyWrapper, openSecret, parseSealed } from './vault'

const ONE = 10n ** 24n
const KEK = randomBytes(32)
const net = NETWORKS.testnet

let clock: number
let chain: FakeChain
let store: CustodyStore
let access: ChainAccess
let signer: TradingSigner
let wallet: TradingWallet
let logs: string[]
let planOverride: ((p: { to: string; amount: string }) => PlanOutcome) | null

const withdraw: IntentHandler = {
  async plan(intent) {
    const p = intent.params as { to: string; amount: string }
    if (planOverride) return planOverride(p)
    return {
      kind: 'plan',
      op: { kind: 'withdraw-near', to: p.to, amount: BigInt(p.amount) },
      plan: [{ receiverId: p.to, actions: [{ kind: 'transfer', deposit: p.amount }], label: 'Withdraw' }],
    }
  },
  async summarize(_intent, _wallet, confirmed) {
    const ok = confirmed.every((c) => 'SuccessValue' in (c.result.status as object))
    return { ok, message: ok ? 'Sent.' : 'Failed on chain.', hashes: confirmed.map((c) => c.hash) }
  },
}

const engineFor = (settled: string[] = []) =>
  createEngine({
    store,
    signer,
    chain: access,
    handlers: { withdraw },
    log: createLogger({ level: 'debug', sink: (l) => logs.push(l) }),
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    confirmMs: 5_000,
    onSettled: async (i) => void settled.push(i.id),
  })

const intent = (amount = ONE, ttlMs = 60_000, to = 'bob.testnet') =>
  store.createIntent({ walletId: wallet.id, userId: 101, chatId: 101, kind: 'withdraw', params: { to, amount: amount.toString() }, ttlMs })

beforeEach(async () => {
  clock = 50_000_000
  logs = []
  planOverride = null
  const db = await Db.open(null)
  migrate(db)
  new Store(db, () => clock).upsertUser({ userId: 101, username: 'alice', firstName: 'Alice', languageCode: null })
  store = new CustodyStore(db, () => clock)
  chain = createFakeChain({ accounts: { 'bob.testnet': { amount: 0n } } })
  access = createChainAccess({ rpc: createRpcClient({ urls: ['https://rpc.test'], fetch: chain.fetch }), fetch: chain.fetch })
  signer = createLocalSigner({ wrapper: localKeyWrapper(KEK), network: net, store, now: () => clock })
  const key = await signer.createKey('testnet')
  wallet = store.createWallet({ userId: 101, network: 'testnet', ...key, keyRef: signer.keyRef }).wallet
  chain.fund(wallet.accountId, 5n * ONE)
})

describe('one Confirm, at most one transaction', () => {
  it('sends exactly once: a second press, a replayed callback or a duplicate update sends nothing', async () => {
    const engine = engineFor()
    const i = intent()
    const first = await engine.execute(i.id, 101)
    expect(first).toMatchObject({ kind: 'finished', intent: { status: 'done', result: { ok: true } } })
    expect(await engine.execute(i.id, 101)).toMatchObject({ kind: 'refused', reason: 'not-open' })
    expect(await engine.execute(i.id, 101)).toMatchObject({ kind: 'refused', reason: 'not-open' })
    expect(await engine.execute(i.id, 202)).toMatchObject({ kind: 'refused', reason: 'not-yours' })
    expect(chain.sent).toHaveLength(1)
    expect(chain.accounts.get('bob.testnet')?.amount).toBe(ONE)
    expect(store.txsOf(i.id)).toMatchObject([{ step: 0, status: 'success' }])
  })

  it('two presses at the same moment still send once', async () => {
    const engine = engineFor()
    const i = intent()
    const [a, b] = await Promise.all([engine.execute(i.id, 101), engine.execute(i.id, 101)])
    expect([a.kind, b.kind].sort()).toEqual(['finished', 'refused'])
    expect(chain.sent).toHaveLength(1)
  })

  it('a stale or expired quote is refused before anything is signed', async () => {
    const engine = engineFor()
    const i = intent(ONE, 10_000)
    clock += 10_001
    expect(await engine.execute(i.id, 101)).toMatchObject({ kind: 'refused', reason: 'expired', intent: { status: 'expired' } })
    expect(chain.sent).toHaveLength(0)
  })

  it('a changed quote replaces the old one and sends nothing', async () => {
    const engine = engineFor()
    planOverride = () => ({ kind: 'requote', quote: { minOut: '5' }, ttlMs: 60_000 })
    const i = intent()
    const r = await engine.execute(i.id, 101)
    expect(r).toMatchObject({ kind: 'requoted', intent: { status: 'replaced' }, next: { status: 'quoted', quote: { minOut: '5' } } })
    expect(store.intent(i.id)?.replacedBy).toBe(r.kind === 'requoted' ? r.next.id : null)
    expect(chain.sent).toHaveLength(0)
  })

  it('one intent in flight per wallet', async () => {
    const engine = engineFor()
    chain.onSend('drop')
    const a = intent()
    expect((await engine.execute(a.id, 101)).kind).toBe('pending')
    const b = intent()
    expect(await engine.execute(b.id, 101)).toMatchObject({ kind: 'refused', reason: 'busy' })
    expect(chain.sent).toHaveLength(1)
  })

  it('an unfunded wallet (no key on chain yet) sends nothing', async () => {
    chain.accounts.delete(wallet.accountId)
    const r = await engineFor().execute(intent().id, 101)
    expect(r).toMatchObject({ kind: 'finished', intent: { status: 'failed', result: { message: expect.stringMatching(/deposit NEAR/) } } })
    expect(chain.sent).toHaveLength(0)
  })

  it('a transaction the network refuses fails cleanly: nothing was sent', async () => {
    const r = await engineFor().execute(intent(100n * ONE).id, 101)
    expect(r).toMatchObject({ kind: 'finished', intent: { status: 'failed', result: { message: expect.stringMatching(/network refused/) } } })
    expect(chain.accounts.get('bob.testnet')?.amount).toBe(0n)
  })
})

describe('unclear sends and restarts', () => {
  it('an RPC timeout after the transaction landed is confirmed from the chain, never sent twice', async () => {
    chain.onSend('timeout')
    const r = await engineFor().execute(intent().id, 101)
    expect(r).toMatchObject({ kind: 'finished', intent: { status: 'done' } })
    expect(chain.sent).toHaveLength(1)
  })

  it('a transaction that never lands stays pending, then is proven failed once past its expiry height', async () => {
    const settled: string[] = []
    const engine = engineFor(settled)
    chain.onSend('drop')
    const i = intent()
    expect((await engine.execute(i.id, 101)).kind).toBe('pending')
    expect(await engine.resolvePending()).toEqual([])
    expect(store.intent(i.id)?.status).toBe('submitted')
    const tx = store.txsOf(i.id)[0]
    // Anchored ~10 minutes before expiry, not a day.
    expect((tx?.expiresHeight ?? 0) - chain.height()).toBeLessThanOrEqual(600)
    chain.advance(601)
    const done = await engine.resolvePending()
    expect(done.map((x) => x.status)).toEqual(['failed'])
    expect(done[0]?.result?.message).toMatch(/never reached the chain/)
    expect(settled).toEqual([i.id])
    expect(chain.sent).toHaveLength(1)
    expect(chain.accounts.get('bob.testnet')?.amount).toBe(0n)
  })

  it('after a restart the new process only reads the chain: a late landing settles as done', async () => {
    chain.onSend('drop')
    const i = intent()
    expect((await engineFor().execute(i.id, 101)).kind).toBe('pending')
    // The network delivers the same signed bytes later (same hash, same nonce).
    const stored = store.txsOf(i.id)[0]
    chain.onSend('apply')
    const rpc = createRpcClient({ urls: ['https://rpc.test'], fetch: chain.fetch })
    await rpc.call('send_tx', { signed_tx_base64: stored?.signed, wait_until: 'FINAL' })
    // A new process: fresh engine and signer over the same database.
    signer = createLocalSigner({ wrapper: localKeyWrapper(KEK), network: net, store, now: () => clock })
    const settled: string[] = []
    const restarted = engineFor(settled)
    const sentBefore = chain.sent.length
    const done = await restarted.resolvePending()
    expect(done.map((x) => x.status)).toEqual(['done'])
    expect(settled).toEqual([i.id])
    expect(chain.sent.length).toBe(sentBefore)
    expect(new Set(chain.sent.map((s) => s.hash)).size).toBe(1)
    expect(chain.accounts.get('bob.testnet')?.amount).toBe(ONE)
  })

  it('a crash after Confirm but before signing is settled as failed: nothing can have been sent', async () => {
    const i = intent()
    store.confirmIntent(i.id, 101)
    const done = await engineFor().resolvePending()
    expect(done).toMatchObject([{ id: i.id, status: 'failed', result: { message: expect.stringMatching(/before sending anything/) } }])
    expect(chain.sent).toHaveLength(0)
  })

  it('a signed transaction saved just before a crash is resolved from chain, not sent again', async () => {
    // Sign and save like the engine does, then "crash" before sending.
    const i = intent()
    store.confirmIntent(i.id, 101)
    const nonce = ((await access.keyNonce(wallet.accountId, wallet.publicKey)) ?? 0n) + 1n
    const anchor = await access.anchor()
    const plan = [{ receiverId: 'bob.testnet', actions: [{ kind: 'transfer' as const, deposit: ONE.toString() }], label: 'Withdraw' }]
    const signed = await signer.sign({ wallet, op: { kind: 'withdraw-near', to: 'bob.testnet', amount: ONE }, plan, index: 0, nonce, blockHash: anchor.hash })
    store.recordSigned({
      intentId: i.id,
      step: 0,
      hash: signed.hash,
      signerId: wallet.accountId,
      receiverId: 'bob.testnet',
      nonce,
      expiresHeight: anchor.expiresHeight,
      signed: signed.base64,
      plan: { tx: plan[0], total: 1 },
    })
    const engine = engineFor()
    expect(await engine.resolvePending()).toEqual([])
    chain.advance(601)
    expect((await engine.resolvePending()).map((x) => x.status)).toEqual(['failed'])
    expect(chain.sent).toHaveLength(0)
  })
})

describe('lagging chain index and a resolver that runs twice', () => {
  it('a transaction that landed but isn’t returned yet stays pending, even past its expiry, and settles once visible', async () => {
    const settled: string[] = []
    const engine = engineFor(settled)
    chain.onSend('hidden')
    const i = intent()
    expect((await engine.execute(i.id, 101)).kind).toBe('pending')
    // It landed: bob has the NEAR and NearKit's key used the nonce, but the index doesn't show it.
    expect(chain.accounts.get('bob.testnet')?.amount).toBe(ONE)
    expect(await engine.resolvePending()).toEqual([])
    chain.advance(700)
    expect(await engine.resolvePending()).toEqual([])
    expect(store.intent(i.id)?.status).toBe('submitted')
    chain.reveal()
    expect((await engine.resolvePending()).map((x) => [x.id, x.status])).toEqual([[i.id, 'done']])
    expect(settled).toEqual([i.id])
    expect(chain.sent).toHaveLength(1)
  })

  it('if the index never shows it, NearKit says it can’t confirm, never that nothing was sent', async () => {
    const engine = engineFor()
    chain.onSend('hidden')
    const i = intent()
    await engine.execute(i.id, 101)
    chain.advance(700 + AMBIGUOUS_GRACE_BLOCKS)
    const [done] = await engine.resolvePending()
    expect(done?.status).toBe('failed')
    expect(done?.result?.message).toMatch(/couldn’t confirm whether a transaction went through/)
    expect(done?.result?.message).not.toMatch(/Nothing was sent/)
    expect(store.txsOf(i.id)[0]?.status).toBe('unconfirmed')
  })

  it('two resolver runs at once settle an intent once and tell the user once', async () => {
    const settled: string[] = []
    const engine = engineFor(settled)
    chain.onSend('timeout')
    // The live run gives up waiting before the chain answers.
    const slow = createEngine({
      store,
      signer,
      chain: { ...access, status: async () => null },
      handlers: { withdraw },
      log: createLogger({ sink: () => {} }),
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
      confirmMs: 1_000,
    })
    const i = intent()
    expect((await slow.execute(i.id, 101)).kind).toBe('pending')
    const [a, b] = await Promise.all([engine.resolvePending(), engine.resolvePending()])
    expect([...a, ...b].map((x) => x.id)).toEqual([i.id])
    expect(settled).toEqual([i.id])
    expect(store.auditOf(wallet.id).filter((e) => e.action === 'intent-done')).toHaveLength(1)
  })
})

describe('secrets', () => {
  it('the wallet key never appears in logs, the security log or stored intents', async () => {
    const engine = engineFor()
    await engine.execute(intent().id, 101)
    chain.onSend('drop')
    await engine.execute(intent().id, 101)
    await engine.execute(intent(100n * ONE).id, 101)
    const seed = await openSecret(localKeyWrapper(KEK), parseSealed(wallet.sealedKey as string), walletAad('testnet', wallet.accountId))
    const secret = secretKeyText(seed)
    const everything = [
      ...logs,
      JSON.stringify(store.auditOf(wallet.id)),
      JSON.stringify(store.db.all('SELECT * FROM wallet_intents')),
      JSON.stringify(store.db.all('SELECT * FROM wallet_txs')),
      JSON.stringify(store.db.all('SELECT id, user_id, network, account_id, public_key, key_ref, status FROM trading_wallets')),
    ].join('\n')
    for (const needle of [secret, secret.slice(8), seed.toString('hex'), seed.toString('base64'), base64Encode(seed), KEK.toString('base64')])
      expect(everything).not.toContain(needle)
    expect(logs.length).toBeGreaterThan(0)
  })
})
