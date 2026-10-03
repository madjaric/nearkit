import { describe, expect, it } from 'vitest'
import { parseEnv } from '@/config/env'
import { NEARKIT_FEE_BPS } from '@/lib/fees'
import { NETWORKS, type NetworkId } from '@/config/networks'
import { tradeWalletPool } from '@/lib/wallets'
import { NETWORK_BUSY_WARNING } from '@/services/near/congestion'
import type { RpcTxResult } from '@/services/near/rpc'
import type { ConnectorTransaction, WalletSession } from '@/services/near/wallet'
import findPathSingle from '@/services/rhea/fixtures/findpath-testnet-wrap-usdt.json'
import smartxOldFee from '@/services/rhea/fixtures/smartx-usdt-to-near-fee200.json'
import smartxNearkitFee from '@/services/rhea/fixtures/smartx-usdt-to-near-fee50.json'
import type { OperationProgress } from '@/types/operations'
import type { NearKitWeb, NearKitWebWallet } from '../nearkitWeb'
import { createNearServices } from './index'
import { memoryStorage } from './stores'
import { createFakeChain, fakeWallet, successOutcome, type FakeChain, type FakeChainOptions } from './testing/fakeChain'

/**
 * The real services end to end against a fake chain: planning reads the chain,
 * the executor signs through a fake wallet and confirms through the fake RPC.
 */

const NEAR = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 18n
const MIN_STORAGE = 1_250_000_000_000_000_000_000n

function setup(opts: { network?: NetworkId; env?: Record<string, string>; chain: FakeChainOptions; session: WalletSession | null; now?: () => number; nearkit?: NearKitWeb }) {
  const network = opts.network ?? 'testnet'
  const chain = createFakeChain(opts.chain)
  const { env, issues } = parseEnv({ VITE_NEAR_NETWORK: network, ...opts.env })
  expect(issues).toEqual([])
  let n = 0
  const wallet = fakeWallet(opts.session, (signerId, transactions) =>
    (transactions as ConnectorTransaction[]).map((tx) => {
      n += 1
      const hash = `HASH${n}`
      chain.settle(hash, outcomes.get(tx.receiverId)?.(hash, signerId) ?? successOutcome(hash, signerId, tx.receiverId))
      return { transaction: { hash, signer_id: signerId } }
    }),
  )
  const outcomes = new Map<string, (hash: string, signer: string) => RpcTxResult>()
  // The saved mainnet quotes are real routes Rhea signed for fees.example.near.
  const services = createNearServices({
    env,
    network: NETWORKS[network],
    fetch: chain.fetch,
    kv: memoryStorage(),
    wallet: async () => wallet.adapter,
    now: opts.now,
    productionFeeRecipient: 'fees.example.near',
    ...(opts.nearkit ? { nearkit: opts.nearkit } : {}),
  })
  const run = (plan: Parameters<typeof services.execution.run>[0], prior: OperationProgress | null = null) => services.execution.run(plan, prior, () => undefined)
  return { chain, services, wallet, outcomes, run }
}

const session = (accounts: string[]): WalletSession => ({ walletId: 'fake', walletName: 'Fake Wallet', accounts, batch: true })

/** NearKit's server as the page sees it: the signed-in Telegram user's NearKit wallets (a mutable list). */
function fakeNearKit(list: NearKitWebWallet[]): NearKitWeb {
  const unused = () => Promise.reject(new Error('not used here'))
  return {
    available: true,
    session: () => ({ token: 'T'.repeat(43), expiresAt: Date.now() + 60_000, userName: 'Alice' }),
    login: unused,
    logout: async () => undefined,
    wallets: async () => ({ wallets: [...list], limit: 10, canCreate: list.length < 10 }),
    createWallet: unused,
    renameWallet: unused,
    prepareTrade: unused,
    tradeStatus: unused,
    executeTrade: unused,
    cancelTrade: unused,
    reviewSend: unused,
    executeSend: unused,
    sendStatus: unused,
    subscribe: () => () => undefined,
  }
}

const NK1 = 'a'.repeat(64)
const NK2 = 'b'.repeat(64)
const nearkitWallets = (): NearKitWebWallet[] => [
  { id: 'nk-1', accountId: NK1, name: 'Main', slot: 1, owner: 'alice.testnet', frozen: false, createdAt: 1 },
  { id: 'nk-2', accountId: NK2, name: 'Degen 1', slot: 2, owner: null, frozen: false, createdAt: 2 },
]

// ─── transfers on testnet ───────────────────────────────────────────────────

const USDT = 'usdt.fake.testnet'
const testnetChain = (): FakeChainOptions => ({
  accounts: { 'alice.testnet': { amount: NEAR(5) }, 'bob.testnet': { amount: NEAR(1) }, 'carol.testnet': { amount: NEAR(1) } },
  tokens: {
    [USDT]: {
      symbol: 'USDT',
      decimals: 6,
      balances: { 'alice.testnet': 100_000_000n, 'bob.testnet': 7_000_000n },
      registered: ['alice.testnet', 'bob.testnet'],
      boundsMin: MIN_STORAGE,
    },
  },
})

describe('real transfers (testnet, fake chain)', () => {
  it('plans a batch with exact amounts, registers only the unregistered recipient, and confirms on chain', async () => {
    const { services, run, wallet } = setup({ chain: testnetChain(), session: session(['alice.testnet']) })
    const plan = await services.transfers.prepare({
      kind: 'batch-send',
      tokenId: USDT,
      sourceWalletId: 'alice.testnet',
      lines: [
        { accountId: 'bob.testnet', amount: '1.5' },
        { accountId: 'carol.testnet', amount: '2.000001' },
      ],
    })
    expect(plan).toMatchObject({ mode: 'near', network: 'testnet', fee: null, signers: ['alice.testnet'] })
    expect(plan.lines.map((l) => [l.accountId, l.amount.raw, l.storageDeposit?.raw ?? null])).toEqual([
      ['bob.testnet', '1500000', null],
      ['carol.testnet', '2000001', MIN_STORAGE.toString()],
    ])
    expect(plan.totals.amount.display).toBe('3.500001')
    expect(plan.totals.storage.raw).toBe(MIN_STORAGE.toString())
    const tx = plan.transactions[0]
    expect(plan.transactions).toHaveLength(1)
    expect(tx?.actions.map((a) => (a.kind === 'call' ? `${a.method}:${String(a.args.receiver_id ?? a.args.account_id)}` : 'transfer'))).toEqual([
      'ft_transfer:bob.testnet',
      'storage_deposit:carol.testnet',
      'ft_transfer:carol.testnet',
    ])

    const progress = await run(plan)
    expect(progress.phase).toBe('success')
    expect(progress.txs[0]).toMatchObject({ phase: 'success', hash: 'HASH1', explorerUrl: 'https://testnet.nearblocks.io/txns/HASH1' })
    expect(wallet.signed).toHaveLength(1)
    const activity = await services.portfolio.listActivity()
    expect(activity[0]).toMatchObject({ origin: 'nearkit', status: 'success', txHashes: ['HASH1'], network: 'testnet' })
  })

  it('refuses a token that asks an absurd registration deposit', async () => {
    const chain = testnetChain()
    chain.tokens![USDT]!.boundsMin = NEAR(25)
    const { services } = setup({ chain, session: session(['alice.testnet']) })
    await expect(
      services.transfers.prepare({ kind: 'batch-send', tokenId: USDT, sourceWalletId: 'alice.testnet', lines: [{ accountId: 'carol.testnet', amount: '1' }] }),
    ).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
  })

  it('warns when a registration costs more than usual', async () => {
    const chain = testnetChain()
    chain.tokens![USDT]!.boundsMin = NEAR(0.05)
    const { services } = setup({ chain, session: session(['alice.testnet']) })
    const plan = await services.transfers.prepare({ kind: 'batch-send', tokenId: USDT, sourceWalletId: 'alice.testnet', lines: [{ accountId: 'carol.testnet', amount: '1' }] })
    expect(plan.warnings.join(' ')).toMatch(/more than usual/)
  })

  it('warns when a recipient only looks like a saved account (address poisoning)', async () => {
    const { services } = setup({ chain: testnetChain(), session: session(['alice.testnet']) })
    const saved = `abcdef${'0'.repeat(54)}1234`
    const poison = `abcdef${'f'.repeat(54)}1234`
    await services.wallets.getSession()
    await services.wallets.addAccount({ accountId: saved, label: 'Cold' })
    const plan = await services.transfers.prepare({ kind: 'batch-send', tokenId: 'near', sourceWalletId: 'alice.testnet', lines: [{ accountId: poison, amount: '0.1' }] })
    expect(plan.warnings.join(' ')).toMatch(/looks like your saved account Cold/)
  })

  it('says in the review when duplicate lines were skipped', async () => {
    const { services } = setup({ chain: testnetChain(), session: session(['alice.testnet']) })
    const plan = await services.transfers.prepare({
      kind: 'batch-send',
      tokenId: USDT,
      sourceWalletId: 'alice.testnet',
      lines: [{ accountId: 'bob.testnet', amount: '1' }],
      skippedLines: 2,
    })
    expect(plan.warnings.join(' ')).toMatch(/2 duplicate lines were skipped/)
  })

  it('refuses a recipient that does not exist, before anything is signed', async () => {
    const { services } = setup({ chain: testnetChain(), session: session(['alice.testnet']) })
    await expect(
      services.transfers.prepare({ kind: 'batch-send', tokenId: USDT, sourceWalletId: 'alice.testnet', lines: [{ accountId: 'ghost.testnet', amount: '1' }] }),
    ).rejects.toMatchObject({ code: 'INVALID_ACCOUNT' })
  })

  it('never rounds: more decimals than the token has is an error', async () => {
    const { services } = setup({ chain: testnetChain(), session: session(['alice.testnet']) })
    await expect(
      services.transfers.prepare({ kind: 'batch-send', tokenId: USDT, sourceWalletId: 'alice.testnet', lines: [{ accountId: 'bob.testnet', amount: '0.1234567' }] }),
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' })
  })

  it('refuses to send more than the chain says the source holds', async () => {
    const { services } = setup({ chain: testnetChain(), session: session(['alice.testnet']) })
    await expect(
      services.transfers.prepare({ kind: 'batch-send', tokenId: USDT, sourceWalletId: 'alice.testnet', lines: [{ accountId: 'bob.testnet', amount: '100.000001' }] }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' })
  })

  it('refuses an account from the other network', async () => {
    const { services } = setup({ chain: testnetChain(), session: session(['alice.testnet']) })
    await expect(
      services.transfers.prepare({ kind: 'batch-send', tokenId: USDT, sourceWalletId: 'alice.testnet', lines: [{ accountId: 'bob.near', amount: '1' }] }),
    ).rejects.toMatchObject({
      code: 'NETWORK_MISMATCH',
    })
  })

  it('keeps enough NEAR for gas: a NEAR send that leaves nothing for gas is refused, and says the gas reserve is refunded', async () => {
    const { services } = setup({ chain: testnetChain(), session: session(['alice.testnet']) })
    await expect(
      services.transfers.prepare({ kind: 'batch-send', tokenId: 'near', sourceWalletId: 'alice.testnet', lines: [{ accountId: 'bob.testnet', amount: '5' }] }),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_GAS',
      message: expect.stringMatching(/needs [\d.]+ NEAR available to sign \(5 to send \+ [\d.]+ gas reserve, refunded automatically except the actual network fee\)/),
    })
  })

  it('credits a not-yet-created implicit account with native NEAR and says so', async () => {
    const { services } = setup({ chain: testnetChain(), session: session(['alice.testnet']) })
    const implicit = 'a'.repeat(64)
    const plan = await services.transfers.prepare({ kind: 'batch-send', tokenId: 'near', sourceWalletId: 'alice.testnet', lines: [{ accountId: implicit, amount: '0.5' }] })
    expect(plan.lines[0]?.notes).toContain('New account: this transfer creates it')
    expect(plan.transactions[0]?.actions).toEqual([{ kind: 'transfer', deposit: NEAR(0.5).toString() }])
  })

  it('consolidates from two connected accounts as separate approvals, each signed by its own account', async () => {
    const { services, run, wallet } = setup({ chain: testnetChain(), session: session(['alice.testnet', 'bob.testnet']) })
    const plan = await services.transfers.prepare({
      kind: 'consolidate',
      tokenId: USDT,
      destinationAccountId: 'carol.testnet',
      sources: [
        { walletId: 'alice.testnet', amount: '1' },
        { walletId: 'bob.testnet', amount: '2' },
      ],
    })
    expect(plan.signers).toEqual(['alice.testnet', 'bob.testnet'])
    expect(plan.groups).toEqual([[0], [1]])
    // Registration for the destination rides with the first source only.
    expect(plan.transactions[1]?.actions.some((a) => a.kind === 'call' && a.method === 'storage_deposit')).toBe(false)
    const done = await run(plan)
    expect(done.phase).toBe('success')
    expect(wallet.signed.map((s) => s.signerId)).toEqual(['alice.testnet', 'bob.testnet'])
  })

  it('refuses a watch-only source before anything is planned or signed, but still sends to one', async () => {
    const { services, wallet } = setup({ chain: testnetChain(), session: session(['alice.testnet']) })
    await services.wallets.getSession()
    await services.wallets.addAccount({ accountId: 'bob.testnet', label: 'Bob' })
    await expect(
      services.transfers.prepare({
        kind: 'consolidate',
        tokenId: USDT,
        destinationAccountId: 'carol.testnet',
        sources: [
          { walletId: 'alice.testnet', amount: '1' },
          { walletId: 'bob.testnet', amount: '2' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'NOT_EXECUTABLE', message: expect.stringMatching(/Bob is watch-only/) })
    await expect(
      services.transfers.prepare({ kind: 'batch-send', tokenId: 'near', sourceWalletId: 'bob.testnet', lines: [{ accountId: 'carol.testnet', amount: '1' }] }),
    ).rejects.toMatchObject({
      code: 'NOT_EXECUTABLE',
    })
    // A watch wallet can receive: it's an address like any other.
    const plan = await services.transfers.prepare({ kind: 'batch-send', tokenId: 'near', sourceWalletId: 'alice.testnet', lines: [{ accountId: 'bob.testnet', amount: '1' }] })
    expect(plan.signers).toEqual(['alice.testnet'])
    expect(wallet.signed).toEqual([])
  })

  it('Split, Consolidate and Batch Send never carry a NearKit fee', async () => {
    const { services } = setup({ chain: testnetChain(), session: session(['alice.testnet']) })
    await services.wallets.getSession()
    await services.wallets.addAccount({ accountId: 'bob.testnet', label: 'Bob' })
    const plans = await Promise.all([
      services.transfers.prepare({ kind: 'batch-send', tokenId: USDT, sourceWalletId: 'alice.testnet', lines: [{ accountId: 'bob.testnet', amount: '1' }] }),
      services.transfers.prepare({
        kind: 'split',
        tokenId: USDT,
        sourceWalletId: 'alice.testnet',
        lines: [
          { accountId: 'bob.testnet', amount: '1' },
          { accountId: 'carol.testnet', amount: '1' },
        ],
      }),
      services.transfers.prepare({ kind: 'consolidate', tokenId: USDT, destinationAccountId: 'carol.testnet', sources: [{ walletId: 'alice.testnet', amount: '1' }] }),
    ])
    for (const plan of plans) {
      expect(plan.fee, plan.kind).toBeNull()
      const actions = plan.transactions.flatMap((t) => t.actions)
      // Only the transfers themselves and disclosed registrations: nothing else goes to anyone.
      expect(
        actions.every((a) => a.kind === 'call' && (a.method === 'ft_transfer' || a.method === 'storage_deposit')),
        plan.kind,
      ).toBe(true)
    }
  })

  it('restores the wallet session once for every first read on page load, not only the first', async () => {
    const { services } = setup({ chain: testnetChain(), session: session(['alice.testnet']) })
    const [s, wallets, holdings] = await Promise.all([services.wallets.getSession(), services.wallets.listWallets(), services.wallets.listHoldings()])
    expect(s?.accountId).toBe('alice.testnet')
    expect(wallets.map((w) => w.accountId)).toEqual(['alice.testnet'])
    expect(holdings.some((h) => h.tokenId === 'near')).toBe(true)
  })

  it('reads balances from the chain, not the indexer', async () => {
    const { services, chain } = setup({ chain: testnetChain(), session: session(['alice.testnet']) })
    const [alice] = await services.wallets.listSnapshots()
    expect(alice?.holdings.find((h) => h.tokenId === USDT)).toMatchObject({ raw: '100000000', verified: true, amount: 100 })
    expect(chain.rpcCalls('query').some((c) => (c.params as { method_name?: string }).method_name === 'ft_balance_of')).toBe(true)
  })
})

// ─── tokens found by exact contract (in no list yet) ────────────────────────

describe('tokens found by exact contract', () => {
  const SING = 'singularty.nearlytrade.near'
  const chain = (): FakeChainOptions => ({
    accounts: {
      'example.near': { amount: NEAR(10) },
      // Nearly-launched tokens run a shared global contract: no local code.
      [SING]: { amount: NEAR(1), global: '1uGuBEpx3dFRDrr2wNzm5Vcb5sF3jWY3AKQ3Gopd6we' },
      'plain.near': { amount: NEAR(1) },
      'app.near': { amount: NEAR(1), code: true },
    },
    tokens: { [SING]: { symbol: 'SINGULARTY', name: 'Singularity is NEAR', decimals: 18, boundsMin: MIN_STORAGE, totalSupply: 10n ** 27n } },
  })

  it('reads an unlisted token on a global contract from chain and shows its metadata, without saving it', async () => {
    const { services } = setup({ network: 'mainnet', chain: chain(), session: session(['example.near']) })
    expect((await services.tokens.listTokens()).some((t) => t.id === SING)).toBe(false)
    expect(await services.tokens.lookupToken(SING)).toMatchObject({
      id: SING,
      contract: SING,
      symbol: 'SINGULARTY',
      name: 'Singularity is NEAR',
      decimals: 18,
      source: 'discovered',
    })
    expect((await services.tokens.listTokens()).some((t) => t.id === SING)).toBe(false)
  })

  it('imports it on request, and from then on lists it as imported', async () => {
    const { services } = setup({ network: 'mainnet', chain: chain(), session: session(['example.near']) })
    expect(await services.tokens.importToken(SING)).toMatchObject({ id: SING, symbol: 'SINGULARTY', source: 'imported' })
    expect((await services.tokens.listTokens()).find((t) => t.id === SING)).toMatchObject({ source: 'imported' })
  })

  it('refuses what is not a token: a missing account, an account without a contract, a contract without NEP-141', async () => {
    const { services } = setup({ network: 'mainnet', chain: chain(), session: session(['example.near']) })
    await expect(services.tokens.lookupToken('ghost.nearlytrade.near')).rejects.toMatchObject({ code: 'INVALID_TOKEN', message: expect.stringMatching(/does not exist/) })
    await expect(services.tokens.lookupToken('plain.near')).rejects.toMatchObject({ code: 'INVALID_TOKEN', message: expect.stringMatching(/without a contract/) })
    await expect(services.tokens.lookupToken('app.near')).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
    await expect(services.tokens.lookupToken('usdt.tether-token.testnet')).rejects.toMatchObject({ code: 'NETWORK_MISMATCH' })
  })
})

// ─── swaps on mainnet through the aggregator ────────────────────────────────

const USDT_MAIN = 'usdt.tether-token.near'
const USDC_MAIN = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
const AGG = 'aggregatedex.near'
// The saved quote (appFeeRate=50) is bound to example.near and fees.example.near, and expires at its deadline.
const DEADLINE = 1790668755603
// An older saved quote for the same request at the former 2.00% app fee.
const OLD_FEE_DEADLINE = 1790600154604

const mainnetChain = (feeRecipientRegistered = true): FakeChainOptions => ({
  accounts: { 'example.near': { amount: NEAR(10) }, 'fees.example.near': { amount: NEAR(1) } },
  tokens: {
    [USDT_MAIN]: { symbol: 'USDt', decimals: 6, balances: { 'example.near': 10_000_000n }, registered: ['example.near', AGG], boundsMin: MIN_STORAGE },
    [USDC_MAIN]: { symbol: 'USDC', decimals: 6, registered: [AGG], boundsMin: MIN_STORAGE },
    'wrap.near': { symbol: 'wNEAR', decimals: 24, registered: [AGG, 'example.near'], boundsMin: MIN_STORAGE },
  },
  aggregator: {
    contract: AGG,
    whitelist: ['wrap.near', USDC_MAIN, USDT_MAIN],
    protocolPpm: 1000,
    registered: { 'example.near': [USDT_MAIN, USDC_MAIN, 'wrap.near'], ...(feeRecipientRegistered ? { 'fees.example.near': [USDT_MAIN] } : {}) },
  },
})

const MAINNET_ENV = { VITE_ENABLE_MAINNET_EXECUTION: 'true', VITE_NEARKIT_FEE_RECIPIENT: 'fees.example.near' }
const swapRequest = { tokenIn: USDT_MAIN, tokenOut: 'near', amountIn: '5.000013', slippagePct: 0.5, walletId: 'example.near' }

function withQuote(chain: FakeChain) {
  chain.route('https://smartx.rhea.finance/swapMultiDexPath', (url) =>
    url.searchParams.get('appFeeRate') === String(NEARKIT_FEE_BPS) &&
    url.searchParams.get('appFeeRecipient') === 'fees.example.near' &&
    url.searchParams.get('user') === 'example.near'
      ? smartxNearkitFee
      : { result_code: 1, result_message: 'unexpected request', result_data: null },
  )
}

const aggSuccess = (hash: string, signer: string): RpcTxResult => ({
  ...successOutcome(hash, signer, USDT_MAIN, btoa('"5000013"')),
  receipts_outcome: [
    {
      id: 'r1',
      outcome: {
        executor_id: AGG,
        logs: [
          'EVENT_JSON:{"data":[{"amount":"20000","receipt":"fees.example.near","token":"usdt.tether-token.near","user":"example.near"}],"event":"earn_app_fee"}',
          'EVENT_JSON:{"data":[{"amount":"1042766627316648153600859","receive_id":"example.near","token_id":"wrap.near","user_id":"example.near"}],"event":"withdraw_started"}',
          'EVENT_JSON:{"data":[{}],"event":"single_swap_success"}',
        ],
        receipt_ids: [],
        gas_burnt: 1,
        tokens_burnt: '0',
        status: { SuccessValue: '' },
      },
    },
    // The aggregator's native NEAR transfer to the user: what proves delivery.
    { id: 'r2', outcome: { executor_id: signer, logs: [], receipt_ids: [], gas_burnt: 1, tokens_burnt: '0', status: { SuccessValue: '' } } },
  ],
  receipts: [{ receipt_id: 'r2', predecessor_id: AGG, receiver_id: signer, receipt: { Action: { actions: [{ Transfer: { deposit: '1042766627316648153600859' } }] } } }],
})

// Mainnet's layout on 2026-09-30: wrap.near is on shard 13.
const MAINNET_LAYOUT = {
  V3: {
    boundary_accounts: ['650', 'aurora', 'aurora-0', 'earn.kaiching', 'game.hot.tg', 'game.hot.tg-0', 'kkuuue2akv_1630967379.near', 'tge-lockup.sweat', 'wallet.ka'],
    shard_ids: [10, 11, 1, 8, 9, 6, 7, 4, 12, 13],
  },
}
const PGAS = 10n ** 15n

describe('network busy warning (wrap.near’s shard)', () => {
  const prepare = async (backlog: Record<number, bigint> | null) => {
    const { services, chain } = setup({ network: 'mainnet', env: MAINNET_ENV, chain: mainnetChain(), session: session(['example.near']), now: () => DEADLINE - 120_000 })
    withQuote(chain)
    if (backlog) chain.congest(MAINNET_LAYOUT, backlog)
    return services.trading.prepareSwap(swapRequest)
  }

  it('warns before signing a swap with NEAR when wrap.near’s shard is backed up, and still lets it go', async () => {
    const plan = await prepare({ 13: 36n * PGAS })
    expect(plan.warnings).toContain(NETWORK_BUSY_WARNING)
    expect(plan.transactions.length).toBeGreaterThan(0)
  })

  it('says nothing when that shard is quiet, when another shard is busy, or when it can’t be read', async () => {
    expect((await prepare({ 13: 0n })).warnings).not.toContain(NETWORK_BUSY_WARNING)
    expect((await prepare({ 12: 300n * PGAS })).warnings).not.toContain(NETWORK_BUSY_WARNING)
    expect((await prepare(null)).warnings).not.toContain(NETWORK_BUSY_WARNING)
  })
})

describe('real swaps (mainnet aggregator, fake chain)', () => {
  it('asks Rhea for NearKit’s 0.50% app fee and discloses the exact split: NearKit 0.40%, Rhea 0.10%, plus Rhea’s own 0.10%', async () => {
    const { services, chain } = setup({ network: 'mainnet', env: MAINNET_ENV, chain: mainnetChain(), session: session(['example.near']), now: () => DEADLINE - 120_000 })
    withQuote(chain)
    const plan = await services.trading.prepareSwap(swapRequest)
    const quoteCall = chain.requests.find((r) => r.url.startsWith('https://smartx.rhea.finance/'))
    expect(new URL(quoteCall?.url ?? 'x:').searchParams.get('appFeeRate')).toBe('50')
    expect(plan.fee).toMatchObject({
      charged: true,
      bps: 50,
      recipient: 'fees.example.near',
      token: { id: USDT_MAIN },
      amount: { raw: '25000', display: '0.025' },
      received: { bps: 40, amount: { raw: '20000' } },
      routerShare: { bps: 10, amount: { raw: '5000' } },
      // Rhea's own protocol fee: disclosed on its own, not part of NearKit's.
      routerFee: { bps: 10, amount: { raw: '5000' } },
      estimated: false,
    })
    // The fee never travels as a transfer: one swap call, no ft_transfer or Transfer anywhere.
    const actions = plan.transactions.flatMap((t) => t.actions)
    expect(actions.some((a) => a.kind === 'transfer' || (a.kind === 'call' && a.method === 'ft_transfer'))).toBe(false)
    expect(actions.filter((a) => a.kind === 'call' && a.method === 'ft_transfer_call')).toHaveLength(1)
    const swapCall = actions.find((a) => a.kind === 'call' && a.method === 'ft_transfer_call')
    expect(swapCall).toMatchObject({ args: { receiver_id: AGG, amount: '5000013' }, gas: '300000000000000', deposit: '1' })
    // Everything is registered already, so the swap is the only transaction.
    expect(plan.transactions.map((t) => t.receiverId)).toEqual([USDT_MAIN])
    expect(plan.swap).toMatchObject({ router: 'aggregator', minOut: { raw: '1037552794180064912832854' }, tokenOut: { contract: null } })
    expect(plan.expiresAt).toBeLessThanOrEqual(DEADLINE - 60_000)
  })

  it('signs, confirms and reads the outcome from the aggregator’s events', async () => {
    const { services, chain, outcomes, run } = setup({
      network: 'mainnet',
      env: MAINNET_ENV,
      chain: mainnetChain(),
      session: session(['example.near']),
      now: () => DEADLINE - 120_000,
    })
    withQuote(chain)
    outcomes.set(USDT_MAIN, aggSuccess)
    const plan = await services.trading.prepareSwap(swapRequest)
    const progress = await run(plan)
    expect(progress.phase).toBe('success')
    expect(progress.txs.at(-1)?.note).toMatch(/Received 1\.042766 NEAR · NearKit fee 0\.02 USDt/)
  })

  it('registers NearKit’s fee account with Rhea when it is missing, as a disclosed storage cost', async () => {
    const { services, chain } = setup({ network: 'mainnet', env: MAINNET_ENV, chain: mainnetChain(false), session: session(['example.near']), now: () => DEADLINE - 120_000 })
    withQuote(chain)
    const plan = await services.trading.prepareSwap(swapRequest)
    const aggTx = plan.transactions.find((t) => t.receiverId === AGG)
    expect(aggTx?.actions).toEqual([
      { kind: 'call', method: 'tokens_storage_deposit', args: { user: 'fees.example.near', tokens: [USDT_MAIN] }, gas: '30000000000000', deposit: '5000000000000000000000' },
    ])
    expect(BigInt(plan.totals.storage.raw)).toBe(5_000_000_000_000_000_000_000n)
    expect(plan.warnings.join(' ')).toMatch(/registers NearKit’s fee account \(fees\.example\.near\)/)
  })

  it('blocks fee-bearing trades when the fee account is not configured, without asking Rhea', async () => {
    const { services, chain } = setup({
      network: 'mainnet',
      env: { VITE_ENABLE_MAINNET_EXECUTION: 'true' },
      chain: mainnetChain(),
      session: session(['example.near']),
      now: () => DEADLINE - 120_000,
    })
    withQuote(chain)
    await expect(services.trading.prepareSwap(swapRequest)).rejects.toMatchObject({ code: 'EXECUTION_DISABLED' })
    await expect(services.trading.quote(swapRequest)).rejects.toMatchObject({ code: 'EXECUTION_DISABLED' })
    expect(chain.requests.some((r) => r.url.startsWith('https://smartx.rhea.finance/'))).toBe(false)
    expect(services.capabilities.execution.trading.enabled).toBe(false)
  })

  it('blocks trades when the fee account does not exist on mainnet, before anything reaches the wallet', async () => {
    const chain = mainnetChain()
    delete chain.accounts!['fees.example.near']
    const { services, chain: fake, wallet } = setup({ network: 'mainnet', env: MAINNET_ENV, chain, session: session(['example.near']), now: () => DEADLINE - 120_000 })
    withQuote(fake)
    await expect(services.trading.prepareSwap(swapRequest)).rejects.toMatchObject({
      code: 'EXECUTION_DISABLED',
      message: expect.stringMatching(/fees\.example\.near does not exist/),
    })
    expect(wallet.signed).toHaveLength(0)
  })

  it('the mainnet switch: plans can be reviewed but nothing reaches the wallet', async () => {
    const { services, chain, run, wallet } = setup({
      network: 'mainnet',
      env: { VITE_NEARKIT_FEE_RECIPIENT: 'fees.example.near' },
      chain: mainnetChain(),
      session: session(['example.near']),
      now: () => DEADLINE - 120_000,
    })
    withQuote(chain)
    const plan = await services.trading.prepareSwap(swapRequest)
    await expect(run(plan)).rejects.toMatchObject({ code: 'EXECUTION_DISABLED' })
    expect(wallet.signed).toHaveLength(0)
    expect(services.capabilities.execution).toMatchObject({ enabled: false, simulated: false })
  })

  it('a multi sell of USDt quotes the NearKit fee in USDt, the token it is taken in, not as 0 NEAR', async () => {
    const { services, chain } = setup({ network: 'mainnet', env: MAINNET_ENV, chain: mainnetChain(), session: session(['example.near']), now: () => DEADLINE - 120_000 })
    withQuote(chain)
    await services.wallets.getSession()
    const q = await services.trading.quoteMulti({ side: 'sell', tokenId: USDT_MAIN, slippagePct: 0.5, legs: [{ walletId: 'example.near', amountIn: '5.000013' }] })
    expect(q.feeTokenId).toBe(USDT_MAIN)
    expect(q.nearkitFeeTotal).toBeCloseTo(0.025, 9)
    expect(q.legs[0]?.nearkitFee).toBeCloseTo(0.025, 9)
  })

  it('never executes a stale quote', async () => {
    let clock = DEADLINE - 120_000
    const { services, chain, run, wallet } = setup({ network: 'mainnet', env: MAINNET_ENV, chain: mainnetChain(), session: session(['example.near']), now: () => clock })
    withQuote(chain)
    const plan = await services.trading.prepareSwap(swapRequest)
    clock = (plan.expiresAt ?? 0) + 1
    await expect(run(plan)).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' })
    expect(wallet.signed).toHaveLength(0)
  })

  it('refuses a route signed for someone else', async () => {
    const { services, chain } = setup({
      network: 'mainnet',
      env: MAINNET_ENV,
      chain: { ...mainnetChain(), accounts: { 'mallory.near': { amount: NEAR(10) }, 'fees.example.near': { amount: NEAR(1) } } },
      session: session(['mallory.near']),
      now: () => DEADLINE - 120_000,
    })
    // A server that ignores the user parameter and returns the route signed for example.near.
    chain.route('https://smartx.rhea.finance/swapMultiDexPath', () => smartxNearkitFee)
    await expect(services.trading.prepareSwap({ ...swapRequest, walletId: 'mallory.near' })).rejects.toMatchObject({ code: 'QUOTE_REJECTED' })
  })

  it('refuses a route that still carries the old 2.00% fee, even when Rhea returns one', async () => {
    const { services, chain, wallet } = setup({
      network: 'mainnet',
      env: MAINNET_ENV,
      chain: mainnetChain(),
      session: session(['example.near']),
      now: () => OLD_FEE_DEADLINE - 120_000,
    })
    chain.route('https://smartx.rhea.finance/swapMultiDexPath', () => smartxOldFee)
    await expect(services.trading.prepareSwap(swapRequest)).rejects.toMatchObject({
      code: 'QUOTE_REJECTED',
      message: expect.stringMatching(/fee rate differs from the NearKit fee/),
    })
    expect(wallet.signed).toHaveLength(0)
  })
})

// ─── swaps on testnet through the classic router ────────────────────────────

describe('real swaps (testnet classic router, fake chain)', () => {
  const chainOpts = (): FakeChainOptions => ({
    accounts: { 'alice.testnet': { amount: NEAR(5) } },
    tokens: {
      'wrap.testnet': { symbol: 'wNEAR', decimals: 24, registered: ['ref-finance-101.testnet'], boundsMin: MIN_STORAGE },
      'usdt.itachicara.testnet': { symbol: 'USDT', decimals: 24, registered: ['ref-finance-101.testnet'], boundsMin: MIN_STORAGE },
    },
  })

  it('warns when the output token copies a listed token’s symbol', async () => {
    const opts = chainOpts()
    opts.tokens!['usdt-lookalike.testnet'] = { symbol: 'USDT', decimals: 24, registered: ['ref-finance-101.testnet'], boundsMin: MIN_STORAGE }
    const { services, chain } = setup({ chain: opts, session: session(['alice.testnet']) })
    chain.route('https://smartroutertest.refburrow.top/findPath', (url) => {
      const amountIn = url.searchParams.get('amountIn') ?? '0'
      const out = (BigInt(amountIn) * 4n).toString()
      const min = ((BigInt(amountIn) * 4n * 995n) / 1000n).toString()
      const pool = {
        pool_id: '9',
        token_in: url.searchParams.get('tokenIn'),
        token_out: url.searchParams.get('tokenOut'),
        amount_in: amountIn,
        amount_out: '0',
        min_amount_out: min,
      }
      return { result_code: 0, result_data: { routes: [{ pools: [pool], amount_in: amountIn, min_amount_out: min, amount_out: '0' }], amount_out: out } }
    })
    const plan = await services.trading.prepareSwap({ tokenIn: 'near', tokenOut: 'usdt-lookalike.testnet', amountIn: '1', slippagePct: 0.5, walletId: 'alice.testnet' })
    expect(plan.warnings.join(' ')).toMatch(/USDT here is usdt-lookalike\.testnet, not the listed USDT \(usdt\.itachicara\.testnet\)/)
  })

  it('wraps and swaps in one transaction, registers the output token, and charges no fee', async () => {
    const { services, chain } = setup({ chain: chainOpts(), session: session(['alice.testnet']) })
    chain.route('https://smartroutertest.refburrow.top/findPath', () => findPathSingle)
    const plan = await services.trading.prepareSwap({ tokenIn: 'near', tokenOut: 'usdt.itachicara.testnet', amountIn: '1', slippagePct: 0.5, walletId: 'alice.testnet' })
    expect(plan.fee).toMatchObject({ charged: false, recipient: null })
    expect(plan.transactions.map((t) => t.receiverId)).toEqual(['usdt.itachicara.testnet', 'wrap.testnet'])
    const swapTx = plan.transactions[1]
    expect(swapTx?.actions.map((a) => (a.kind === 'call' ? a.method : 'transfer'))).toEqual(['storage_deposit', 'near_deposit', 'ft_transfer_call'])
    const call = swapTx?.actions[2]
    expect(call).toMatchObject({ args: { receiver_id: 'ref-finance-101.testnet', amount: NEAR(1).toString() } })
    expect(JSON.parse(String(call?.kind === 'call' ? call.args.msg : '{}'))).toEqual({
      actions: [{ pool_id: 1352, token_in: 'wrap.testnet', token_out: 'usdt.itachicara.testnet', amount_in: NEAR(1).toString(), min_amount_out: '4018917753285859662296638' }],
    })
    expect(plan.warnings.join(' ')).toMatch(/wNEAR/)
  })
})

// ─── multi trade on testnet ─────────────────────────────────────────────────

// ─── swaps on mainnet through DCL directly (a token Rhea does not index) ────

describe('real swaps on mainnet through DCL directly (fake chain)', () => {
  const SING = 'singularty.nearlytrade.near'
  const DCL = 'dclv2.ref-labs.near'
  const POOL = 'singularty.nearlytrade.near|wrap.near|10000'
  const FEES = 'fees.example.near'
  /** 1 wNEAR (24 decimals) buys 18,000 SINGULARTY (18 decimals), less the pool's 1% fee; and back. */
  const rate = (tokenIn: string, amountIn: bigint) => ((tokenIn === 'wrap.near' ? (amountIn * 18_000n) / 10n ** 6n : (amountIn * 10n ** 6n) / 18_000n) * 99n) / 100n
  const dclChain = (opts: { feeRegistered?: boolean } = {}): FakeChainOptions => ({
    accounts: {
      'example.near': { amount: NEAR(10) },
      'bob.near': { amount: NEAR(10) },
      [FEES]: { amount: NEAR(1) },
      [DCL]: { amount: NEAR(1), code: true },
      [SING]: { amount: NEAR(1), global: '1uGuBEpx3dFRDrr2wNzm5Vcb5sF3jWY3AKQ3Gopd6we' },
    },
    tokens: {
      [SING]: {
        symbol: 'SINGULARTY',
        name: 'Singularity is NEAR',
        decimals: 18,
        boundsMin: MIN_STORAGE,
        registered: [DCL, 'example.near', FEES],
        balances: { 'example.near': 50_000n * 10n ** 18n },
      },
      'wrap.near': { symbol: 'wNEAR', decimals: 24, registered: [AGG, DCL, 'example.near', 'bob.near', ...(opts.feeRegistered === false ? [] : [FEES])], boundsMin: MIN_STORAGE },
      [USDC_MAIN]: { symbol: 'USDC', decimals: 6, registered: [AGG, DCL], boundsMin: MIN_STORAGE },
    },
    aggregator: { contract: AGG, whitelist: ['wrap.near', USDC_MAIN], protocolPpm: 1000, registered: { 'example.near': ['wrap.near'] } },
    dcl: { contract: DCL, pools: { [POOL]: { tokenX: SING, tokenY: 'wrap.near', fee: 10000, liquidity: 10n ** 23n, rate } } },
  })
  /** Rhea's quote server does not index the token: code 1008, as the real one answers. */
  const rheaRefuses = (chain: FakeChain) => chain.route('https://smartx.rhea.finance/swapMultiDexPath', () => ({ result_code: 1008, result_message: '', result_data: null }))
  const buyRequest = { tokenIn: 'near', tokenOut: SING, amountIn: '1', slippagePct: 1, walletId: 'example.near' }
  const SWAP_IN = NEAR(1) - NEAR(0.005)
  const OUT = rate('wrap.near', SWAP_IN)
  const method = (a: { kind: string; method?: string }) => (a.kind === 'call' ? a.method : a.kind)
  const argsOf = (a: unknown) => (a as { args: Record<string, unknown> }).args
  /** The buy as dclv2 records it: its swap event, then SINGULARTY's transfer to the wallet. */
  const dclBuy = (hash: string, signer: string): RpcTxResult => ({
    ...successOutcome(hash, signer, 'wrap.near', btoa(`"${SWAP_IN}"`)),
    receipts_outcome: [
      {
        id: 'r1',
        outcome: {
          executor_id: DCL,
          logs: [
            `EVENT_JSON:${JSON.stringify({ standard: 'dcl.ref', version: '1.0.0', event: 'swap', data: [{ swapper: signer, token_in: 'wrap.near', token_out: SING, amount_in: SWAP_IN.toString(), amount_out: OUT.toString(), pool_id: POOL, total_fee: '0', protocol_fee: '0', referral_fee: '0', referral_id: null }] })}`,
          ],
          receipt_ids: ['r2'],
          gas_burnt: 1,
          tokens_burnt: '0',
          status: { SuccessValue: 'IjAi' },
        },
      },
      {
        id: 'r2',
        outcome: {
          executor_id: SING,
          logs: [
            `EVENT_JSON:${JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer', data: [{ old_owner_id: DCL, new_owner_id: signer, amount: OUT.toString() }] })}`,
          ],
          receipt_ids: [],
          gas_burnt: 1,
          tokens_burnt: '0',
          status: { SuccessValue: '' },
        },
      },
    ],
  })

  it('routes a token Rhea does not index through its DCL pool, with no import: 0.50% to NearKit’s fee account first, the rest to the pool, in one transaction', async () => {
    const { services, chain } = setup({ network: 'mainnet', env: MAINNET_ENV, chain: dclChain(), session: session(['example.near']) })
    rheaRefuses(chain)
    expect((await services.tokens.listTokens()).some((t) => t.id === SING)).toBe(false)
    const plan = await services.trading.prepareSwap(buyRequest)
    expect(plan.swap).toMatchObject({ router: 'dcl', source: 'dcl', tokenOut: { contract: SING }, minOut: { raw: ((OUT * 99n) / 100n).toString() } })
    expect(plan.fee).toMatchObject({
      charged: true,
      bps: 50,
      recipient: FEES,
      amount: { raw: '5000000000000000000000', display: '0.005' },
      received: { bps: 50, amount: { raw: '5000000000000000000000' } },
      routerShare: null,
      routerFee: null,
      estimated: false,
    })
    expect(plan.fee?.note).toMatch(/same transaction/)
    expect(plan.transactions.map((t) => t.receiverId)).toEqual(['wrap.near'])
    const actions = plan.transactions[0]?.actions ?? []
    expect(actions.map(method)).toEqual(['near_deposit', 'ft_transfer', 'ft_transfer_call'])
    expect(actions[0]).toMatchObject({ deposit: NEAR(1).toString() })
    expect(actions[1]).toMatchObject({ args: { receiver_id: FEES, amount: '5000000000000000000000' }, deposit: '1' })
    expect(actions[2]).toMatchObject({ args: { receiver_id: DCL, amount: SWAP_IN.toString() }, gas: '300000000000000', deposit: '1' })
    expect(JSON.parse(String(argsOf(actions[2]).msg))).toEqual({ Swap: { pool_ids: [POOL], output_token: SING, min_output_amount: plan.swap?.minOut.raw } })
    expect(plan.warnings.join(' ')).toMatch(/fee is not refunded/)
    // The quote the ticket shows says where the route comes from.
    const quote = await services.trading.quote(buyRequest)
    expect(quote).toMatchObject({ router: 'dcl', source: 'dcl', path: ['NEAR', 'SINGULARTY'] })
  })

  it('signs, confirms from the exchange’s swap event and the token’s transfer to the wallet, and reports the fee', async () => {
    const { services, chain, outcomes, run } = setup({ network: 'mainnet', env: MAINNET_ENV, chain: dclChain(), session: session(['example.near']) })
    rheaRefuses(chain)
    outcomes.set('wrap.near', dclBuy)
    const plan = await services.trading.prepareSwap(buyRequest)
    const progress = await run(plan)
    expect(progress.phase).toBe('success')
    expect(progress.txs.at(-1)?.note).toBe('Received 17,730.9 SINGULARTY · NearKit fee 0.005 wNEAR')
  })

  it('registers NearKit’s fee account on the fee token when it is missing, as a disclosed one-time cost in the same transaction', async () => {
    const { services, chain } = setup({ network: 'mainnet', env: MAINNET_ENV, chain: dclChain({ feeRegistered: false }), session: session(['example.near']) })
    rheaRefuses(chain)
    const plan = await services.trading.prepareSwap(buyRequest)
    const actions = plan.transactions[0]?.actions ?? []
    expect(actions.map(method)).toEqual(['storage_deposit', 'near_deposit', 'ft_transfer', 'ft_transfer_call'])
    expect(actions[0]).toMatchObject({ args: { account_id: FEES, registration_only: true }, deposit: MIN_STORAGE.toString() })
    expect(plan.warnings.join(' ')).toMatch(/registers NearKit’s fee account/)
  })

  it('sells for NEAR: the fee is 0.50% of the tokens sold, the exchange unwraps the wNEAR, no router share', async () => {
    const { services, chain } = setup({ network: 'mainnet', env: MAINNET_ENV, chain: dclChain(), session: session(['example.near']) })
    rheaRefuses(chain)
    const plan = await services.trading.prepareSwap({ tokenIn: SING, tokenOut: 'near', amountIn: '10000', slippagePct: 1, walletId: 'example.near' })
    expect(plan.transactions.map((t) => t.receiverId)).toEqual([SING])
    const actions = plan.transactions[0]?.actions ?? []
    expect(actions.map(method)).toEqual(['ft_transfer', 'ft_transfer_call'])
    expect(actions[0]).toMatchObject({ args: { receiver_id: FEES, amount: (50n * 10n ** 18n).toString() } })
    expect(actions[1]).toMatchObject({ args: { receiver_id: DCL, amount: (9950n * 10n ** 18n).toString() } })
    const msg = JSON.parse(String(argsOf(actions[1]).msg)) as { Swap: Record<string, unknown> }
    expect(msg.Swap).toMatchObject({ pool_ids: [POOL], output_token: 'wrap.near' })
    expect(msg.Swap.skip_unwrap_near).toBeUndefined()
    expect(plan.fee).toMatchObject({ charged: true, token: { id: SING }, amount: { raw: (50n * 10n ** 18n).toString(), display: '50' }, routerShare: null })
    expect(plan.swap).toMatchObject({ router: 'dcl', source: 'dcl', tokenOut: { contract: null } })
  })

  it('a token that taxes its DCL pair: the quote is on what the pool receives, the amounts shown are after the tax, and the review says so', async () => {
    const opts = dclChain()
    ;(opts.tokens as Record<string, { tax?: unknown }>)[SING]!.tax = { buyBps: 100, sellBps: 100, pairs: [DCL] }
    const { services, chain } = setup({ network: 'mainnet', env: MAINNET_ENV, chain: opts, session: session(['example.near']) })
    rheaRefuses(chain)
    const buy = await services.trading.prepareSwap(buyRequest)
    const poolMin = (OUT * 99n) / 100n
    expect(buy.swap).toMatchObject({ expectedOut: { raw: (OUT - OUT / 100n).toString() }, minOut: { raw: (poolMin - poolMin / 100n).toString() } })
    const buyMsg = JSON.parse(String(argsOf(buy.transactions[0]?.actions.at(-1)).msg)) as { Swap: { min_output_amount: string } }
    expect(buyMsg.Swap.min_output_amount).toBe(poolMin.toString())
    expect(buy.warnings.join(' ')).toMatch(/SINGULARTY takes a 1% tax on tokens leaving its DCL pool/)
    const sell = await services.trading.prepareSwap({ tokenIn: SING, tokenOut: 'near', amountIn: '10000', slippagePct: 1, walletId: 'example.near' })
    const poolGets = 9950n * 10n ** 18n - (9950n * 10n ** 18n) / 100n
    const quote = rate(SING, poolGets)
    expect(sell.swap).toMatchObject({ expectedOut: { raw: quote.toString() }, minOut: { raw: ((quote * 99n) / 100n).toString() } })
    expect(sell.transactions[0]?.actions.at(-1)).toMatchObject({ args: { amount: (9950n * 10n ** 18n).toString() } })
    expect(sell.warnings.join(' ')).toMatch(/SINGULARTY takes a 1% tax on tokens entering its DCL pool/)
  })

  it('Multi Buy routes each wallet on DCL separately: each signs its own transaction with its own fee transfer', async () => {
    const { services, chain } = setup({ network: 'mainnet', env: MAINNET_ENV, chain: dclChain(), session: session(['example.near', 'bob.near']) })
    rheaRefuses(chain)
    const plan = await services.trading.prepareMulti({
      side: 'buy',
      tokenId: SING,
      slippagePct: 1,
      legs: [
        { walletId: 'example.near', amountIn: '1' },
        { walletId: 'bob.near', amountIn: '2' },
      ],
    })
    expect(plan.signers).toEqual(['example.near', 'bob.near'])
    const swaps = plan.transactions.filter((t) => t.actions.some((a) => a.kind === 'call' && a.method === 'ft_transfer_call'))
    expect(swaps.map((t) => [t.signerId, argsOf(t.actions.find((a) => a.kind === 'call' && a.method === 'ft_transfer')).amount, argsOf(t.actions.at(-1)).receiver_id])).toEqual([
      ['example.near', '5000000000000000000000', DCL],
      ['bob.near', '10000000000000000000000', DCL],
    ])
    expect(plan.fee?.charged).toBe(true)
    expect(plan.swap).toMatchObject({ source: 'dcl' })
  })

  it('with no pool and no Rhea route, says no executable route was found for the pair, never that the token is unsupported', async () => {
    const opts = dclChain()
    opts.dcl = { contract: DCL, pools: {} }
    const { services, chain } = setup({ network: 'mainnet', env: MAINNET_ENV, chain: opts, session: session(['example.near']) })
    rheaRefuses(chain)
    const err = await services.trading.prepareSwap(buyRequest).then(
      () => null,
      (e: unknown) => e as { code: string; message: string },
    )
    expect(err?.code).toBe('QUOTE_UNAVAILABLE')
    expect(err?.message).toMatch(/^No executable route found for NEAR → SINGULARTY right now\./)
    expect(err?.message).not.toMatch(/not supported|not listed|unsupported/i)
  })
})

describe('multi trade (testnet classic router, fake chain)', () => {
  const OUT = 'usdt.itachicara.testnet'
  const T0 = Date.UTC(2026, 8, 29, 4, 0, 0)
  const chainOpts = (bobNear = 5): FakeChainOptions => ({
    accounts: { 'alice.testnet': { amount: NEAR(5) }, 'bob.testnet': { amount: NEAR(bobNear) } },
    tokens: {
      'wrap.testnet': { symbol: 'wNEAR', decimals: 24, registered: ['ref-finance-101.testnet'], boundsMin: MIN_STORAGE },
      [OUT]: { symbol: 'USDT', decimals: 24, registered: ['ref-finance-101.testnet', 'alice.testnet', 'bob.testnet'], boundsMin: MIN_STORAGE },
    },
  })
  // A pool paying 4 USDT per NEAR for whatever amount is asked.
  const withRouter = (chain: FakeChain) =>
    chain.route('https://smartroutertest.refburrow.top/findPath', (url) => {
      const amountIn = url.searchParams.get('amountIn') ?? '0'
      const out = (BigInt(amountIn) * 4n).toString()
      const min = ((BigInt(amountIn) * 4n * 995n) / 1000n).toString()
      const pool = {
        pool_id: '1352',
        token_in: url.searchParams.get('tokenIn'),
        token_out: url.searchParams.get('tokenOut'),
        amount_in: amountIn,
        amount_out: '0',
        min_amount_out: min,
      }
      return { result_code: 0, result_data: { routes: [{ pools: [pool], amount_in: amountIn, min_amount_out: min, amount_out: '0' }], amount_out: out } }
    })
  const request = {
    side: 'buy' as const,
    tokenId: OUT,
    slippagePct: 0.5,
    legs: [
      { walletId: 'alice.testnet', amountIn: '1' },
      { walletId: 'bob.testnet', amountIn: '2' },
    ],
  }
  // The router used the whole amount it was sent: ft_transfer_call returns it.
  const used: Record<string, bigint> = { 'alice.testnet': NEAR(1), 'bob.testnet': NEAR(2) }
  const swapped = (hash: string, signer: string) => successOutcome(hash, signer, 'wrap.testnet', btoa(`"${used[signer] ?? 0n}"`))
  const failed = (hash: string, signer: string, receiver: string): RpcTxResult => ({
    ...successOutcome(hash, signer, receiver),
    status: { Failure: { ActionError: { index: 2, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E68: slippage error' } } } } },
  })

  it('plans one route per wallet, each signed by that wallet in its own approval, with no fee on testnet', async () => {
    const { services, chain } = setup({ chain: chainOpts(), session: session(['alice.testnet', 'bob.testnet']), now: () => T0 })
    withRouter(chain)
    const plan = await services.trading.prepareMulti(request)
    expect(plan.kind).toBe('multi-trade')
    expect(plan.signers).toEqual(['alice.testnet', 'bob.testnet'])
    expect(plan.fee).toMatchObject({ charged: false })
    // Each approval holds one signer's transactions only.
    for (const group of plan.groups) expect(new Set(group.map((i) => plan.transactions[i]?.signerId)).size).toBe(1)
    const swaps = plan.transactions.filter((t) => t.actions.some((a) => a.kind === 'call' && a.method === 'ft_transfer_call'))
    expect(swaps.map((t) => [t.signerId, t.actions.find((a) => a.kind === 'call' && a.method === 'near_deposit')?.deposit])).toEqual([
      ['alice.testnet', NEAR(1).toString()],
      ['bob.testnet', NEAR(2).toString()],
    ])
    expect(plan.lines.map((l) => [l.accountId, l.amount.display])).toEqual([
      ['alice.testnet', '1'],
      ['bob.testnet', '2'],
    ])
    expect(plan.warnings.join(' ')).toMatch(/no all-or-nothing/)
  })

  it('quotes every wallet, marks the one that cannot afford its share, and leaves it out of the totals', async () => {
    const { services, chain } = setup({ chain: chainOpts(0.5), session: session(['alice.testnet', 'bob.testnet']), now: () => T0 })
    withRouter(chain)
    const q = await services.trading.quoteMulti(request)
    const [alice, bob] = q.legs
    expect(alice?.shortfall).toBe(0)
    expect(bob?.shortfall).toBeGreaterThan(1.4)
    expect(q.totalIn).toBe(1)
    expect(q.totalOut).toBeCloseTo(4, 6)
  })

  it('refuses to prepare when a wallet cannot afford its share, naming it, before anything is signed', async () => {
    const { services, chain, wallet } = setup({ chain: chainOpts(0.5), session: session(['alice.testnet', 'bob.testnet']), now: () => T0 })
    withRouter(chain)
    await expect(services.trading.prepareMulti(request)).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE', message: expect.stringMatching(/^bob has 0\.5 NEAR available/) })
    expect(wallet.signed).toEqual([])
  })

  it('leaves out a wallet allocated nothing, as the quote does', async () => {
    const { services, chain } = setup({ chain: chainOpts(), session: session(['alice.testnet', 'bob.testnet']), now: () => T0 })
    withRouter(chain)
    const plan = await services.trading.prepareMulti({ ...request, legs: [request.legs[0] as (typeof request.legs)[number], { walletId: 'bob.testnet', amountIn: '0' }] })
    expect(plan.signers).toEqual(['alice.testnet'])
  })

  it('refuses NEAR as the token and an allocation with no amounts', async () => {
    const { services } = setup({ chain: chainOpts(), session: session(['alice.testnet', 'bob.testnet']), now: () => T0 })
    await expect(services.trading.prepareMulti({ ...request, tokenId: 'near' })).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
    await expect(services.trading.prepareMulti({ ...request, legs: [{ walletId: 'alice.testnet', amountIn: '' }] })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' })
    await expect(services.trading.quoteMulti({ ...request, legs: [{ walletId: 'alice.testnet', amountIn: '0' }] })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' })
  })

  it('executes wallet by wallet: when the first wallet’s swap fails, it stops before the next wallet signs', async () => {
    const { services, chain, outcomes, run, wallet } = setup({ chain: chainOpts(), session: session(['alice.testnet', 'bob.testnet']), now: () => T0 })
    withRouter(chain)
    outcomes.set('wrap.testnet', (hash, signer) => (signer === 'alice.testnet' ? failed(hash, signer, 'wrap.testnet') : swapped(hash, signer)))
    const plan = await services.trading.prepareMulti(request)
    const progress = await run(plan)
    expect(progress.phase).toBe('paused')
    expect(progress.pause).toMatchObject({ reason: 'failure' })
    expect(wallet.signed.map((s) => s.signerId)).toEqual(['alice.testnet'])
    const bobTxs = plan.transactions.filter((t) => t.signerId === 'bob.testnet').map((t) => progress.txs[t.index]?.phase)
    expect(bobTxs.every((p) => p === 'queued')).toBe(true)
  })

  it('when the quote expires between wallets, the rest is not sent and it asks for a fresh quote', async () => {
    let t = T0
    const { services, chain, outcomes, run, wallet } = setup({ chain: chainOpts(), session: session(['alice.testnet', 'bob.testnet']), now: () => t })
    withRouter(chain)
    outcomes.set('wrap.testnet', (hash, signer) => {
      if (signer === 'alice.testnet') t += 10 * 60_000
      return swapped(hash, signer)
    })
    const plan = await services.trading.prepareMulti(request)
    const progress = await run(plan)
    expect(progress.phase).toBe('paused')
    expect(progress.pause).toMatchObject({ reason: 'requote' })
    expect(wallet.signed.map((s) => s.signerId)).toEqual(['alice.testnet'])
  })

  it('refuses a watch-only wallet before anything is quoted, planned or signed', async () => {
    const { services, chain, wallet } = setup({ chain: chainOpts(), session: session(['alice.testnet']), now: () => T0 })
    withRouter(chain)
    await services.wallets.getSession()
    await services.wallets.addAccount({ accountId: 'bob.testnet', label: 'Bob' })
    await expect(services.trading.quoteMulti(request)).rejects.toMatchObject({ code: 'NOT_EXECUTABLE', message: expect.stringMatching(/Bob is watch-only/) })
    await expect(services.trading.prepareMulti(request)).rejects.toMatchObject({ code: 'NOT_EXECUTABLE' })
    // Multi sell too.
    await expect(services.trading.prepareMulti({ ...request, side: 'sell' })).rejects.toMatchObject({ code: 'NOT_EXECUTABLE' })
    expect(wallet.signed).toEqual([])
  })

  it('an account connected before but not in this session is watch-only now: it can’t join', async () => {
    const { services, chain, wallet } = setup({ chain: chainOpts(), session: session(['alice.testnet', 'bob.testnet']), now: () => T0 })
    withRouter(chain)
    await services.wallets.getSession()
    wallet.setSession(session(['alice.testnet']))
    await services.wallets.connect('fake')
    expect((await services.wallets.listWallets()).map((w) => [w.accountId, w.source])).toEqual([
      ['alice.testnet', 'external'],
      ['bob.testnet', 'watch'],
    ])
    await expect(services.trading.prepareMulti(request)).rejects.toMatchObject({ code: 'NOT_EXECUTABLE' })
    expect(wallet.signed).toEqual([])
  })
})

// ─── scanner ────────────────────────────────────────────────────────────────

describe('real scanner (fake chain)', () => {
  const scanChain = (): FakeChainOptions => ({ ...testnetChain(), accounts: { ...testnetChain().accounts, [USDT]: { amount: NEAR(1), code: true } } })
  const nb = 'https://api-testnet.nearblocks.io/v1'

  it('labels every figure with how it is known and gives no verdict', async () => {
    const { services, chain } = setup({ chain: scanChain(), session: null })
    chain.route(`${nb}/fts/${USDT}/holders/count`, () => ({ holders: [{ count: '2' }] }))
    chain.route(`${nb}/fts/${USDT}/holders?`, () => ({ holders: [{ account: 'alice.testnet', amount: '100000000' }] }))
    const report = await services.tokens.scan(USDT)
    if (report?.kind !== 'chain') throw new Error('expected a chain scan')
    const fact = (id: string) => report.facts.find((f) => f.id === id)
    expect(fact('supply')).toMatchObject({ kind: 'verified', value: '107 USDT' })
    expect(fact('holders')).toMatchObject({ kind: 'derived', value: '2' })
    expect(fact('top10')).toMatchObject({ kind: 'derived', value: '93.46%' })
    expect(fact('mint')).toMatchObject({ kind: 'unknown', value: null })
    expect(JSON.stringify(report)).not.toMatch(/\b(SAFE|SCAM)\b/)
  })

  it('leaves the burn address out of the concentration figure and says how much it holds', async () => {
    const { services, chain } = setup({ chain: scanChain(), session: null })
    const burn = '0'.repeat(64)
    chain.route(`${nb}/fts/${USDT}/holders?`, () => ({
      holders: [
        { account: burn, amount: '50000000' },
        { account: 'alice.testnet', amount: '40000000' },
      ],
    }))
    const report = await services.tokens.scan(USDT)
    if (report?.kind !== 'chain') throw new Error('expected a chain scan')
    const top10 = report.facts.find((f) => f.id === 'top10')
    expect(top10?.value).toBe('37.38%')
    expect(top10?.note).toMatch(/burn address holds 46\.73%/)
    expect(report.topHolders?.[0]).toMatchObject({ accountId: burn, burn: true })
  })

  it('marks holder figures unknown when the indexer does not add up against the on-chain supply', async () => {
    const { services, chain } = setup({ chain: scanChain(), session: null })
    chain.route(`${nb}/fts/${USDT}/holders?`, () => ({ holders: [{ account: 'alice.testnet', amount: '500000000' }] }))
    const report = await services.tokens.scan(USDT)
    if (report?.kind !== 'chain') throw new Error('expected a chain scan')
    expect(report.facts.find((f) => f.id === 'top10')).toMatchObject({ kind: 'unknown', value: null })
    expect(report.topHolders).toBeNull()
    expect(report.observations.some((o) => o.id === 'concentrated')).toBe(false)
  })
})

// ─── wallet classes: executable vs watch-only ───────────────────────────────

describe('wallet classes (real, fake chain)', () => {
  it('lists the connected accounts as executable and the rest of the account book as watch-only', async () => {
    const { services } = setup({ chain: testnetChain(), session: session(['alice.testnet']) })
    await services.wallets.getSession()
    await services.wallets.addAccount({ accountId: 'bob.testnet', label: 'Bob' })
    const list = await services.wallets.listWallets()
    expect(list.map((w) => [w.accountId, w.source, w.access])).toEqual([
      ['alice.testnet', 'external', 'signer'],
      ['bob.testnet', 'watch', 'watch'],
    ])
  })

  it('refuses to swap from a watch-only wallet before anything is quoted or signed', async () => {
    const { services, wallet } = setup({ chain: testnetChain(), session: session(['alice.testnet']) })
    await services.wallets.getSession()
    await services.wallets.addAccount({ accountId: 'bob.testnet', label: 'Bob' })
    await expect(services.trading.prepareSwap({ tokenIn: 'near', tokenOut: USDT, amountIn: '1', slippagePct: 0.5, walletId: 'bob.testnet' })).rejects.toMatchObject({
      code: 'NOT_EXECUTABLE',
    })
    expect(wallet.signed).toEqual([])
  })

  it('keeps watch-only wallets out of presets: saving one is refused, editing can’t add one', async () => {
    const { services } = setup({ chain: testnetChain(), session: session(['alice.testnet', 'carol.testnet']) })
    await services.wallets.getSession()
    await services.wallets.addAccount({ accountId: 'bob.testnet', label: 'Bob' })
    await expect(services.wallets.createPreset({ name: 'sniper', walletIds: ['alice.testnet', 'bob.testnet'] })).rejects.toMatchObject({
      code: 'NOT_EXECUTABLE',
      message: expect.stringMatching(/Bob is watch-only/),
    })
    const preset = await services.wallets.createPreset({ name: 'sniper', walletIds: ['alice.testnet', 'carol.testnet'] })
    expect(preset.walletIds).toEqual(['alice.testnet', 'carol.testnet'])
    await expect(services.wallets.updatePreset(preset.id, { name: 'sniper', walletIds: ['alice.testnet', 'bob.testnet'] })).rejects.toMatchObject({ code: 'NOT_EXECUTABLE' })
  })

  it('lists the signed-in Telegram user’s NearKit wallets as NearKit wallets, then the connected and watched accounts', async () => {
    const { services } = setup({ chain: testnetChain(), session: session(['alice.testnet']), nearkit: fakeNearKit(nearkitWallets()) })
    await services.wallets.getSession()
    await services.wallets.addAccount({ accountId: 'bob.testnet', label: 'Bob' })
    const list = await services.wallets.listWallets()
    expect(list.map((w) => [w.label, w.source, w.nearkitId ?? null, w.owner ?? null])).toEqual([
      ['Main', 'nearkit', 'nk-1', 'alice.testnet'],
      ['Degen 1', 'nearkit', 'nk-2', null],
      ['Main', 'external', null, null],
      ['Bob', 'watch', null, null],
    ])
  })

  it('lists NearKit wallets with no wallet connected in the browser', async () => {
    const { services } = setup({ chain: testnetChain(), session: null, nearkit: fakeNearKit(nearkitWallets()) })
    expect((await services.wallets.listWallets()).map((w) => [w.accountId, w.source])).toEqual([
      [NK1, 'nearkit'],
      [NK2, 'nearkit'],
    ])
  })

  it('an account watched before that turns out to be the user’s NearKit wallet is listed once, as a NearKit wallet', async () => {
    const list: NearKitWebWallet[] = []
    const { services } = setup({ chain: testnetChain(), session: session(['alice.testnet']), nearkit: fakeNearKit(list) })
    await services.wallets.getSession()
    await services.wallets.addAccount({ accountId: NK2, label: 'Old watch' })
    list.push(...nearkitWallets())
    const again = await services.wallets.listWallets()
    expect(again.filter((w) => w.accountId === NK2).map((w) => [w.label, w.source])).toEqual([['Degen 1', 'nearkit']])
  })

  it('a NearKit wallet never signs in the browser: a swap, a Multi Buy plan or a Consolidate from it is refused before anything is signed', async () => {
    const { services, wallet } = setup({ chain: testnetChain(), session: session(['alice.testnet']), nearkit: fakeNearKit(nearkitWallets()) })
    await services.wallets.getSession()
    const nearkitOnly = expect.objectContaining({
      code: 'NOT_EXECUTABLE',
      message: expect.stringMatching(/NearKit wallet: NearKit's server executes its trades and sends, not a browser wallet/),
    })
    await expect(services.trading.prepareSwap({ tokenIn: 'near', tokenOut: USDT, amountIn: '1', slippagePct: 0.5, walletId: NK1 })).rejects.toEqual(nearkitOnly)
    await expect(
      services.trading.prepareMulti({
        side: 'buy',
        tokenId: USDT,
        slippagePct: 0.5,
        legs: [
          { walletId: 'alice.testnet', amountIn: '0.1' },
          { walletId: NK1, amountIn: '0.1' },
        ],
      }),
    ).rejects.toEqual(nearkitOnly)
    await expect(
      services.transfers.prepare({ kind: 'consolidate', tokenId: USDT, destinationAccountId: 'carol.testnet', sources: [{ walletId: NK2, amount: '1' }] }),
    ).rejects.toEqual(nearkitOnly)
    expect(wallet.signed).toEqual([])
  })
})

// ─── the portfolio is made of executable wallets only ────────────────────────

describe('the portfolio counts executable wallets only: watch-only wallets are observed, never aggregated', () => {
  const BIG = 'big.testnet'
  /** Alice 10 NEAR and Bob 5 NEAR connected; Carol 100 NEAR and Dave 1,000 NEAR watched: far more than both together. */
  const chain = (): FakeChainOptions => ({
    accounts: { 'alice.testnet': { amount: NEAR(10) }, 'bob.testnet': { amount: NEAR(5) }, 'carol.testnet': { amount: NEAR(100) }, 'dave.testnet': { amount: NEAR(1000) } },
    tokens: {
      [USDT]: {
        symbol: 'USDT',
        decimals: 6,
        balances: { 'alice.testnet': 100_000_000n, 'carol.testnet': 10_000_000_000n },
        registered: ['alice.testnet', 'carol.testnet'],
        boundsMin: MIN_STORAGE,
      },
      [BIG]: { symbol: 'BIG', decimals: 18, balances: { 'carol.testnet': 5_000n * 10n ** 18n }, registered: ['carol.testnet'], boundsMin: MIN_STORAGE },
    },
  })
  /** No on-chain history for anyone: positions answer without PnL, at once. */
  const noHistory = (c: FakeChain) => {
    c.route('https://tx.test.fastnear.com/v0/account', () => ({ account_txs: [], txs_count: 0 }))
    c.route('https://tx.test.fastnear.com/v0/transactions', () => ({ transactions: [] }))
  }
  /** Rhea's classic router: 4 USDT per NEAR for whatever is asked. */
  const withRouter = (c: FakeChain) =>
    c.route('https://smartroutertest.refburrow.top/findPath', (url) => {
      const amountIn = url.searchParams.get('amountIn') ?? '0'
      const out = ((BigInt(amountIn) * 4n) / 10n ** 18n).toString()
      const min = ((BigInt(amountIn) * 4n * 995n) / 1000n / 10n ** 18n).toString()
      const pool = {
        pool_id: '1352',
        token_in: url.searchParams.get('tokenIn'),
        token_out: url.searchParams.get('tokenOut'),
        amount_in: amountIn,
        amount_out: '0',
        min_amount_out: min,
      }
      return { result_code: 0, result_data: { routes: [{ pools: [pool], amount_in: amountIn, min_amount_out: min, amount_out: '0' }], amount_out: out } }
    })
  async function portfolio(accounts = ['alice.testnet', 'bob.testnet']) {
    const t = setup({ chain: chain(), session: session(accounts) })
    noHistory(t.chain)
    await t.services.wallets.getSession()
    await t.services.wallets.addAccount({ accountId: 'carol.testnet', label: 'Carol' })
    await t.services.wallets.addAccount({ accountId: 'dave.testnet', label: 'Dave' })
    return t
  }
  const nearOf = (list: { accountId: string; nearBalance: number }[], id: string) => list.find((x) => x.accountId === id)?.nearBalance ?? 0

  it('Available NEAR and the counts: the two connected wallets, not the watched ones holding 100 and 1,000 NEAR', async () => {
    const { services } = await portfolio()
    const all = await services.wallets.listSnapshots()
    expect(all.map((w) => [w.accountId, w.source])).toEqual([
      ['alice.testnet', 'external'],
      ['bob.testnet', 'external'],
      ['carol.testnet', 'watch'],
      ['dave.testnet', 'watch'],
    ])
    const summary = await services.portfolio.getSummary()
    const executable = nearOf(all, 'alice.testnet') + nearOf(all, 'bob.testnet')
    expect(executable).toBeGreaterThan(14.9)
    expect(summary.availableNear).toBeCloseTo(executable, 6)
    expect(summary.availableNear).toBeLessThan(nearOf(all, 'carol.testnet'))
    expect(summary).toMatchObject({ walletCount: 4, executableWalletCount: 2, mainNear: nearOf(all, 'alice.testnet') })
  })

  it('positions: the connected wallets’ tokens only; a token held by a watched wallet alone is absent, and no share names a watched wallet', async () => {
    const { services } = await portfolio()
    const positions = await services.portfolio.listPositions()
    // NEAR itself is a position too (the "Base" row): the connected wallets' NEAR, not the watched 1,100.
    expect(positions.map((p) => p.token.id)).toEqual([USDT, 'near'])
    expect(positions[0]).toMatchObject({ balance: 100, wallets: [{ walletId: 'alice.testnet', amount: 100 }] })
    const near = positions[1] as NonNullable<(typeof positions)[1]>
    expect(near.balance).toBeGreaterThan(14.9)
    expect(near.balance).toBeLessThan(16)
    expect(near.wallets.map((w) => w.walletId)).toEqual(['alice.testnet', 'bob.testnet'])
    expect((await services.portfolio.getSummary()).activePositions).toBe(2)
    expect((await services.wallets.listPortfolioSnapshots()).map((w) => w.accountId)).toEqual(['alice.testnet', 'bob.testnet'])
  })

  it('the watched wallets stay visible with their own balances in the wallet views', async () => {
    const { services } = await portfolio()
    const all = await services.wallets.listSnapshots()
    expect(nearOf(all, 'carol.testnet')).toBeGreaterThan(99.9)
    expect(nearOf(all, 'dave.testnet')).toBeGreaterThan(999.9)
    expect(all.find((w) => w.accountId === 'carol.testnet')?.holdings.map((h) => h.tokenId)).toEqual(expect.arrayContaining([USDT, BIG]))
    expect((await services.wallets.listHoldings()).some((h) => h.walletId === 'carol.testnet' && h.tokenId === BIG)).toBe(true)
  })

  it('an account out of the session is watched and out of the portfolio; in the session, it counts', async () => {
    const only = setup({ chain: chain(), session: session(['alice.testnet']) })
    noHistory(only.chain)
    await only.services.wallets.getSession()
    await only.services.wallets.addAccount({ accountId: 'bob.testnet', label: 'Bob' })
    const watched = await only.services.portfolio.getSummary()
    expect(watched).toMatchObject({ walletCount: 2, executableWalletCount: 1 })
    expect(watched.availableNear).toBeLessThan(10.1)
    const both = setup({ chain: chain(), session: session(['alice.testnet', 'bob.testnet']) })
    noHistory(both.chain)
    await both.services.wallets.getSession()
    const counted = await both.services.portfolio.getSummary()
    expect(counted).toMatchObject({ walletCount: 2, executableWalletCount: 2 })
    expect(counted.availableNear).toBeGreaterThan(14.9)
  })

  it('a trade ticket spends from an executable wallet’s own balance: 50 NEAR from Alice is refused although a watched wallet holds 100', async () => {
    const { services, chain: c } = await portfolio()
    withRouter(c)
    expect(tradeWalletPool(await services.wallets.listWallets()).options.map((w) => w.id)).toEqual(['alice.testnet', 'bob.testnet'])
    await expect(services.trading.prepareSwap({ tokenIn: 'near', tokenOut: USDT, amountIn: '50', slippagePct: 1, walletId: 'alice.testnet' })).rejects.toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
      message: expect.stringMatching(/NEAR available and this swaps 50 NEAR/),
    })
  })

  it('Multi Buy totals come from its legs alone, and a watched wallet can’t be a Multi Sell leg', async () => {
    const { services, chain: c } = await portfolio()
    withRouter(c)
    const q = await services.trading.quoteMulti({
      side: 'buy',
      tokenId: USDT,
      slippagePct: 0.5,
      legs: [
        { walletId: 'alice.testnet', amountIn: '1' },
        { walletId: 'bob.testnet', amountIn: '2' },
      ],
    })
    expect(q.totalIn).toBe(3)
    expect(q.legs.map((l) => l.walletId)).toEqual(['alice.testnet', 'bob.testnet'])
    await expect(services.trading.prepareMulti({ side: 'sell', tokenId: USDT, slippagePct: 0.5, legs: [{ walletId: 'carol.testnet', amountIn: '1' }] })).rejects.toMatchObject({
      code: 'NOT_EXECUTABLE',
      message: expect.stringMatching(/Carol is watch-only/),
    })
  })

  it('nothing changes for a portfolio with no watched wallets', async () => {
    const t = setup({ chain: chain(), session: session(['alice.testnet', 'bob.testnet']) })
    noHistory(t.chain)
    await t.services.wallets.getSession()
    const s = await t.services.portfolio.getSummary()
    expect(s).toMatchObject({ walletCount: 2, executableWalletCount: 2 })
    expect(s.availableNear).toBeGreaterThan(14.9)
    expect((await t.services.portfolio.listPositions()).map((p) => p.token.id)).toEqual([USDT, 'near'])
  })
})
