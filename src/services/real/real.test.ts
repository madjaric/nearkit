import { describe, expect, it } from 'vitest'
import { parseEnv } from '@/config/env'
import { NETWORKS, type NetworkId } from '@/config/networks'
import type { RpcTxResult } from '@/services/near/rpc'
import type { ConnectorTransaction, WalletSession } from '@/services/near/wallet'
import findPathSingle from '@/services/rhea/fixtures/findpath-testnet-wrap-usdt.json'
import smartxOldFee from '@/services/rhea/fixtures/smartx-usdt-to-near-fee200.json'
import smartxNearkitFee from '@/services/rhea/fixtures/smartx-usdt-to-near-fee10.json'
import type { OperationProgress } from '@/types/operations'
import { createNearServices } from './index'
import { memoryStorage } from './stores'
import { createFakeChain, fakeWallet, successOutcome, type FakeChain, type FakeChainOptions } from './testing/fakeChain'

/**
 * The real services end to end against a fake chain: planning reads the chain,
 * the executor signs through a fake wallet and confirms through the fake RPC.
 */

const NEAR = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 18n
const MIN_STORAGE = 1_250_000_000_000_000_000_000n

function setup(opts: { network?: NetworkId; env?: Record<string, string>; chain: FakeChainOptions; session: WalletSession | null; now?: () => number }) {
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
  const services = createNearServices({ env, network: NETWORKS[network], fetch: chain.fetch, kv: memoryStorage(), wallet: async () => wallet.adapter, now: opts.now })
  const run = (plan: Parameters<typeof services.execution.run>[0], prior: OperationProgress | null = null) => services.execution.run(plan, prior, () => undefined)
  return { chain, services, wallet, outcomes, run }
}

const session = (accounts: string[]): WalletSession => ({ walletId: 'fake', walletName: 'Fake Wallet', accounts, batch: true })

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

  it('keeps enough NEAR for gas: a NEAR send that leaves nothing for gas is refused', async () => {
    const { services } = setup({ chain: testnetChain(), session: session(['alice.testnet']) })
    await expect(
      services.transfers.prepare({ kind: 'batch-send', tokenId: 'near', sourceWalletId: 'alice.testnet', lines: [{ accountId: 'bob.testnet', amount: '5' }] }),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_GAS',
    })
  })

  it('credits a not-yet-created implicit account with native NEAR and says so', async () => {
    const { services } = setup({ chain: testnetChain(), session: session(['alice.testnet']) })
    const implicit = 'a'.repeat(64)
    const plan = await services.transfers.prepare({ kind: 'batch-send', tokenId: 'near', sourceWalletId: 'alice.testnet', lines: [{ accountId: implicit, amount: '0.5' }] })
    expect(plan.lines[0]?.notes).toContain('New account: this transfer creates it')
    expect(plan.transactions[0]?.actions).toEqual([{ kind: 'transfer', deposit: NEAR(0.5).toString() }])
  })

  it('consolidates from two accounts as separate approvals and pauses for the one not connected', async () => {
    const { services, run, wallet } = setup({ chain: testnetChain(), session: session(['alice.testnet']) })
    await services.wallets.getSession()
    await services.wallets.addAccount({ accountId: 'bob.testnet', label: 'Bob' })
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
    expect(plan.warnings.join(' ')).toMatch(/bob\.testnet/)
    // Registration for the destination rides with the first source only.
    expect(plan.transactions[1]?.actions.some((a) => a.kind === 'call' && a.method === 'storage_deposit')).toBe(false)

    const first = await run(plan)
    expect(first.phase).toBe('paused')
    expect(first.pause).toMatchObject({ reason: 'switch-account', signerId: 'bob.testnet' })
    expect(wallet.signed.map((s) => s.signerId)).toEqual(['alice.testnet'])

    wallet.setSession(session(['bob.testnet']))
    const done = await run(plan, first)
    expect(done.phase).toBe('success')
    expect(wallet.signed.map((s) => s.signerId)).toEqual(['alice.testnet', 'bob.testnet'])
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

// ─── swaps on mainnet through the aggregator ────────────────────────────────

const USDT_MAIN = 'usdt.tether-token.near'
const USDC_MAIN = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
const AGG = 'aggregatedex.near'
// The saved quote (appFeeRate=10) is bound to example.near and fees.example.near, and expires at its deadline.
const DEADLINE = 1790625221763
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
    url.searchParams.get('appFeeRate') === '10' && url.searchParams.get('appFeeRecipient') === 'fees.example.near' && url.searchParams.get('user') === 'example.near'
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
          'EVENT_JSON:{"data":[{"amount":"4000","receipt":"fees.example.near","token":"usdt.tether-token.near","user":"example.near"}],"event":"earn_app_fee"}',
          'EVENT_JSON:{"data":[{"amount":"1056767498589802841019550","receive_id":"example.near","token_id":"wrap.near","user_id":"example.near"}],"event":"withdraw_started"}',
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
  receipts: [{ receipt_id: 'r2', predecessor_id: AGG, receiver_id: signer, receipt: { Action: { actions: [{ Transfer: { deposit: '1056767498589802841019550' } }] } } }],
})

describe('real swaps (mainnet aggregator, fake chain)', () => {
  it('asks Rhea for the 0.10% app fee and discloses the exact split: NearKit 0.08%, Rhea 0.02%, plus Rhea’s own 0.10%', async () => {
    const { services, chain } = setup({ network: 'mainnet', env: MAINNET_ENV, chain: mainnetChain(), session: session(['example.near']), now: () => DEADLINE - 120_000 })
    withQuote(chain)
    const plan = await services.trading.prepareSwap(swapRequest)
    const quoteCall = chain.requests.find((r) => r.url.startsWith('https://smartx.rhea.finance/'))
    expect(new URL(quoteCall?.url ?? 'x:').searchParams.get('appFeeRate')).toBe('10')
    expect(plan.fee).toMatchObject({
      charged: true,
      bps: 10,
      recipient: 'fees.example.near',
      token: { id: USDT_MAIN },
      amount: { raw: '5000', display: '0.005' },
      received: { bps: 8, amount: { raw: '4000' } },
      routerShare: { bps: 2, amount: { raw: '1000' } },
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
    expect(plan.swap).toMatchObject({ router: 'aggregator', minOut: { raw: '1051483661096853826814450' }, tokenOut: { contract: null } })
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
    expect(progress.txs.at(-1)?.note).toMatch(/Received 1\.056767 NEAR · NearKit fee 0\.004 USDt/)
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
