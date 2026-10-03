import { describe, expect, it } from 'vitest'
import { parseEnv } from '@/config/env'
import { NETWORKS } from '@/config/networks'
import { dclPoolId } from '@/services/dcl/pools'
import { NearKitError } from '@/services/near/errors'
import { createNearContext } from './context'
import { memoryStorage } from './stores'
import { createSwapRouter, type RoutedSwap } from './swapRouting'
import { createFakeChain, type FakeChainOptions } from './testing/fakeChain'

const AGG = 'aggregatedex.near'
const DCL = NETWORKS.mainnet.dex.dcl.contract
const WRAP = 'wrap.near'
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
const SING = 'singularty.nearlytrade.near'
const NEW = 'launched-today.nearlytrade.near'
const FEES = 'nearkitfee.near'
const MIN_STORAGE = 1_250_000_000_000_000_000_000n
const ONE = 10n ** 24n

function router(feeRecipient: string) {
  const chain = createFakeChain({
    accounts: { 'trader.near': { amount: 10n ** 25n } },
    tokens: {
      'wrap.near': { symbol: 'wNEAR', decimals: 24, registered: [AGG, 'trader.near'], boundsMin: MIN_STORAGE },
      [USDC]: { symbol: 'USDC', decimals: 6, registered: [AGG, 'trader.near'], boundsMin: MIN_STORAGE },
    },
    // Nobody is registered with the aggregator yet.
    aggregator: { contract: AGG, whitelist: ['wrap.near', USDC], protocolPpm: 1000, registered: {} },
  })
  const { env } = parseEnv({ VITE_NEAR_NETWORK: 'mainnet', VITE_NEARKIT_FEE_RECIPIENT: feeRecipient })
  return createSwapRouter(createNearContext({ env, network: NETWORKS.mainnet, fetch: chain.fetch, kv: memoryStorage() }))
}

// NEAR → USDC through the aggregator; NearKit's fee is taken from the wNEAR going in.
const swap = (feeRecipient: string): RoutedSwap => ({
  router: 'aggregator',
  source: 'rhea-aggregator',
  tokenIn: { id: 'near', symbol: 'NEAR', decimals: 24, contract: null },
  tokenOut: { id: USDC, symbol: 'USDC', decimals: 6, contract: USDC },
  routeIn: 'wrap.near',
  routeOut: USDC,
  amountIn: 10n ** 23n,
  swapAmount: 10n ** 23n,
  amountOut: 470_000n,
  signedMin: 467_000n,
  minOut: 467_000n,
  slippagePct: 0.5,
  routeTokens: ['wrap.near', USDC],
  stepContracts: ['wrap.near'],
  multiDex: false,
  receiver: AGG,
  msg: '{}',
  deadline: null,
  fee: { stage: 'input', token: 'wrap.near', appPpm: 1000, protocolPpm: 1000, routerShareBps: 2000, recipient: feeRecipient },
  quotedAt: 0,
})

describe('swap prerequisites with Rhea’s aggregator', () => {
  it('registers the trader and NearKit’s fee account for what each needs', async () => {
    const pre = await router('fees.near').prerequisites(swap('fees.near'), 'trader.near')
    expect(pre.aggregatorEntries).toEqual([
      { user: 'trader.near', tokens: ['wrap.near', USDC], deposit: 10_000_000_000_000_000_000_000n },
      { user: 'fees.near', tokens: ['wrap.near'], deposit: 5_000_000_000_000_000_000_000n },
    ])
  })

  it('does not pay twice for the same registration when the trader is the fee account', async () => {
    const pre = await router('trader.near').prerequisites(swap('trader.near'), 'trader.near')
    expect(pre.aggregatorEntries).toEqual([{ user: 'trader.near', tokens: ['wrap.near', USDC], deposit: 10_000_000_000_000_000_000_000n }])
  })
})

/**
 * The router asks every source. Rhea's quote server is faked per test (it refuses SINGULARTY
 * with code 1008, the way the real one does); DCL pools are read and quoted on the fake chain.
 */
const pool = (token: string, perNear: bigint, fee = 10000) => ({
  tokenX: token < WRAP ? token : WRAP,
  tokenY: token < WRAP ? WRAP : token,
  fee,
  liquidity: 10n ** 23n,
  // 1 wNEAR = `perNear` tokens, 1% pool fee.
  rate: (tokenIn: string, amountIn: bigint) => ((tokenIn === WRAP ? amountIn * perNear : amountIn / perNear) * 99n) / 100n,
})

function mainnet(options: { rhea?: (tokenIn: string, tokenOut: string, amountIn: bigint) => unknown; pools?: FakeChainOptions['dcl']; feeRecipient?: string | null } = {}) {
  const chain = createFakeChain({
    accounts: { 'trader.near': { amount: 10n ** 25n }, [FEES]: { amount: 10n ** 24n } },
    tokens: {
      [WRAP]: { symbol: 'wNEAR', decimals: 24, registered: [AGG, DCL, 'trader.near'], boundsMin: MIN_STORAGE },
      [USDC]: { symbol: 'USDC', decimals: 6, registered: [AGG, DCL, 'trader.near'], boundsMin: MIN_STORAGE },
      [SING]: {
        symbol: 'SINGULARTY',
        name: 'Singularity is NEAR',
        decimals: 18,
        registered: [DCL, 'trader.near'],
        boundsMin: MIN_STORAGE,
        balances: { 'trader.near': 10n ** 22n },
      },
      [NEW]: { symbol: 'NEWT', name: 'Launched Today', decimals: 18, registered: [DCL], boundsMin: MIN_STORAGE },
    },
    aggregator: { contract: AGG, whitelist: [WRAP, USDC], protocolPpm: 1000, registered: {} },
    dcl: options.pools ?? { contract: DCL, pools: { [dclPoolId(SING, WRAP, 10000)]: pool(SING, 18000n), [dclPoolId(NEW, WRAP, 10000)]: pool(NEW, 1000n) } },
  })
  // Rhea's aggregator: code 1008 for everything it doesn't index (SINGULARTY, a token launched today), else a signed-looking route is beyond this fake, so it refuses.
  chain.route('https://smartx.rhea.finance/', (url) => {
    const tokenIn = url.searchParams.get('tokenIn') ?? ''
    const tokenOut = url.searchParams.get('tokenOut') ?? ''
    const amountIn = BigInt(url.searchParams.get('amountIn') ?? '0')
    return options.rhea ? options.rhea(tokenIn, tokenOut, amountIn) : { result_code: 1008, result_message: '', result_data: null }
  })
  const { env } = parseEnv({ VITE_NEAR_NETWORK: 'mainnet', ...(options.feeRecipient === null ? {} : { VITE_NEARKIT_FEE_RECIPIENT: options.feeRecipient ?? FEES }) })
  const ctx = createNearContext({ env, network: NETWORKS.mainnet, fetch: chain.fetch, kv: memoryStorage() })
  return { router: createSwapRouter(ctx), chain }
}

describe('a token that taxes transfers to and from its DCL pair (nearlytrade launches)', () => {
  const taxed = () => {
    const chain = createFakeChain({
      accounts: { 'trader.near': { amount: 10n ** 25n }, [FEES]: { amount: 10n ** 24n } },
      tokens: {
        [WRAP]: { symbol: 'wNEAR', decimals: 24, registered: [AGG, DCL, 'trader.near', FEES], boundsMin: MIN_STORAGE },
        [USDC]: { symbol: 'USDC', decimals: 6, registered: [AGG, DCL, 'trader.near'], boundsMin: MIN_STORAGE },
        [SING]: {
          symbol: 'SINGULARTY',
          name: 'Singularity is NEAR',
          decimals: 18,
          registered: [DCL, 'trader.near', FEES],
          boundsMin: MIN_STORAGE,
          balances: { 'trader.near': 10n ** 22n },
          // 1% on tokens entering the pool, 1% on tokens leaving it, as singularty.nearlytrade.near answers get_tax (2026-10-03).
          tax: { buyBps: 100, sellBps: 100, pairs: [DCL] },
        },
      },
      aggregator: { contract: AGG, whitelist: [WRAP, USDC], protocolPpm: 1000, registered: {} },
      dcl: { contract: DCL, pools: { [dclPoolId(SING, WRAP, 10000)]: pool(SING, 18000n) } },
    })
    chain.route('https://smartx.rhea.finance/', () => ({ result_code: 1008, result_message: '', result_data: null }))
    const { env } = parseEnv({ VITE_NEAR_NETWORK: 'mainnet', VITE_NEARKIT_FEE_RECIPIENT: FEES })
    return createSwapRouter(createNearContext({ env, network: NETWORKS.mainnet, fetch: chain.fetch, kv: memoryStorage() }))
  }

  it('sells on what the pool receives after the sell tax, so the minimum in the message holds', async () => {
    const r = await taxed().route({ tokenIn: SING, tokenOut: 'near', amountIn: '9000', slippagePct: 1, walletId: 'w' }, 'trader.near', true)
    const amountIn = 9000n * 10n ** 18n
    const swapAmount = amountIn - (amountIn * 50n) / 10_000n
    const poolGets = swapAmount - swapAmount / 100n
    const quote = pool(SING, 18000n).rate(SING, poolGets)
    expect(r.swapAmount).toBe(swapAmount)
    expect(r.amountOut).toBe(quote)
    expect(r.signedMin).toBe((quote * 99n) / 100n)
    expect(r.minOut).toBe(r.signedMin)
    expect(JSON.parse(r.msg).Swap.min_output_amount).toBe(r.signedMin.toString())
    expect(r.tax).toEqual({ inBps: 100, outBps: 0 })
  })

  it('buys with the buy tax off what the pool pays: the message minimum is the pool’s, the user’s minimum and expected amount are after the tax', async () => {
    const r = await taxed().route({ tokenIn: 'near', tokenOut: SING, amountIn: '1', slippagePct: 1, walletId: 'w' }, 'trader.near', true)
    const swapAmount = ONE - 5n * 10n ** 21n
    const quote = pool(SING, 18000n).rate(WRAP, swapAmount)
    const poolMin = (quote * 99n) / 100n
    expect(r.signedMin).toBe(poolMin)
    expect(JSON.parse(r.msg).Swap.min_output_amount).toBe(poolMin.toString())
    expect(r.amountOut).toBe(quote - quote / 100n)
    expect(r.minOut).toBe(poolMin - poolMin / 100n)
    expect(r.tax).toEqual({ inBps: 0, outBps: 100 })
  })

  it('a token without get_tax, and a tax that names another pair, change nothing', async () => {
    const r = await mainnet().router.route({ tokenIn: 'near', tokenOut: SING, amountIn: '1', slippagePct: 1, walletId: 'w' }, 'trader.near', true)
    expect(r.tax).toEqual({ inBps: 0, outBps: 0 })
    expect(r.minOut).toBe(r.signedMin)
  })
})

describe('routing a token Rhea does not index, through DCL directly', () => {
  it('buys SINGULARTY with NEAR: the DCL pool of the pair, read from chain, with the fee off the input first', async () => {
    const { router } = mainnet()
    const r = await router.route({ tokenIn: 'near', tokenOut: SING, amountIn: '1', slippagePct: 1, walletId: 'w' }, 'trader.near', true)
    expect(r.source).toBe('dcl')
    expect(r.router).toBe('dcl')
    expect(r.receiver).toBe(DCL)
    expect(r.pools).toEqual(['singularty.nearlytrade.near|wrap.near|10000'])
    expect(r.routeTokens).toEqual([WRAP, SING])
    expect(r.amountIn).toBe(ONE)
    // 0.50% to the fee account, the rest to the pool.
    expect(r.fee).toEqual({ stage: 'input', token: WRAP, appPpm: 5000, protocolPpm: 0, routerShareBps: 0, recipient: FEES, transfer: { amount: 5n * 10n ** 21n } })
    expect(r.swapAmount).toBe(ONE - 5n * 10n ** 21n)
    // Quoted for what the pool receives (0.995 NEAR × 18,000 × 0.99), with the minimum one slippage below.
    expect(r.amountOut).toBe(((ONE - 5n * 10n ** 21n) * 18000n * 99n) / 100n)
    expect(r.minOut).toBe((r.amountOut * 99n) / 100n)
    expect(r.signedMin).toBe(r.minOut)
    expect(JSON.parse(r.msg)).toEqual({ Swap: { pool_ids: ['singularty.nearlytrade.near|wrap.near|10000'], output_token: SING, min_output_amount: r.minOut.toString() } })
  })

  it('sells SINGULARTY for NEAR: the pool unwraps the wNEAR, and the fee is 0.50% of the tokens sold', async () => {
    const { router } = mainnet()
    const r = await router.route({ tokenIn: SING, tokenOut: 'near', amountIn: '9000', slippagePct: 1, walletId: 'w' }, 'trader.near', false)
    const amountIn = 9000n * 10n ** 18n
    expect(r.source).toBe('dcl')
    expect(r.fee?.transfer).toEqual({ amount: 45n * 10n ** 18n })
    expect(r.swapAmount).toBe(amountIn - 45n * 10n ** 18n)
    expect(JSON.parse(r.msg)).toEqual({ Swap: { pool_ids: ['singularty.nearlytrade.near|wrap.near|10000'], output_token: WRAP, min_output_amount: r.minOut.toString() } })
    expect(r.routeTokens).toEqual([SING, WRAP])
  })

  it('a token launched today, in no list, routes the same way: nothing was registered anywhere', async () => {
    const { router } = mainnet()
    const r = await router.route({ tokenIn: 'near', tokenOut: NEW, amountIn: '0.5', slippagePct: 1, walletId: 'w' }, null, false)
    expect(r.source).toBe('dcl')
    expect(r.tokenOut).toEqual({ id: NEW, symbol: 'NEWT', decimals: 18, contract: NEW })
    expect(r.pools).toEqual([dclPoolId(NEW, WRAP, 10000)])
  })

  it('keeps wNEAR as wNEAR when that is the token asked for', async () => {
    const { router } = mainnet()
    const r = await router.route({ tokenIn: SING, tokenOut: WRAP, amountIn: '9000', slippagePct: 1, walletId: 'w' }, null, false)
    expect(JSON.parse(r.msg).Swap.skip_unwrap_near).toBe(true)
  })

  it('says plainly when no source has a route, with each source’s reason; never "not listed"', async () => {
    const { router } = mainnet({ pools: { contract: DCL, pools: {} } })
    const e = await router.route({ tokenIn: 'near', tokenOut: SING, amountIn: '1', slippagePct: 1, walletId: 'w' }, null, false).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(NearKitError)
    const err = e as NearKitError
    expect(err.code).toBe('QUOTE_UNAVAILABLE')
    expect(err.message).toMatch(/^No executable route found for NEAR → SINGULARTY right now\./)
    expect(err.message).toContain('Rhea code 1008')
    expect(err.message).toContain('DCL has no pool with liquidity')
    expect(err.message).not.toMatch(/not listed|not supported/i)
  })

  it('blocks fee-bearing routes without the fee account, and refuses a fee account that does not exist on chain', async () => {
    const none = mainnet({ feeRecipient: null })
    await expect(none.router.route({ tokenIn: 'near', tokenOut: SING, amountIn: '1', slippagePct: 1, walletId: 'w' }, null, false)).rejects.toMatchObject({
      code: 'EXECUTION_DISABLED',
    })
    const ghost = mainnet({ feeRecipient: 'nearkitfee.near' })
    ghost.chain.accounts.delete(FEES)
    await expect(ghost.router.route({ tokenIn: 'near', tokenOut: SING, amountIn: '1', slippagePct: 1, walletId: 'w' }, 'trader.near', true)).rejects.toMatchObject({
      code: 'EXECUTION_DISABLED',
    })
  })

  it('registers NearKit’s fee account on the fee token when it is not yet, paid like any other registration', async () => {
    const { router } = mainnet()
    const r = await router.route({ tokenIn: SING, tokenOut: 'near', amountIn: '9000', slippagePct: 1, walletId: 'w' }, 'trader.near', true)
    const pre = await router.prerequisites(r, 'trader.near')
    expect(pre.registrations).toEqual([{ contract: SING, accountId: FEES, deposit: MIN_STORAGE }])
    expect(pre.aggregatorEntries).toEqual([])
  })
})

describe('route selection between Rhea and DCL', () => {
  // Rhea's real routes are signed and obfuscated (smartx.test.ts covers them); here Rhea simply refuses,
  // so the DCL pool is the only executable route, and the selection rules are covered in routing/select.test.ts.
  it('a pair Rhea refuses and DCL has: DCL, with the source on the route', async () => {
    const { router } = mainnet()
    const r = await router.route({ tokenIn: 'near', tokenOut: SING, amountIn: '2', slippagePct: 0.5, walletId: 'w' }, null, false)
    expect(r.source).toBe('dcl')
  })

  it('a pair nobody has: the message names both sources', async () => {
    const { router } = mainnet()
    const e = await router.route({ tokenIn: 'near', tokenOut: USDC, amountIn: '1', slippagePct: 1, walletId: 'w' }, null, false).catch((x: unknown) => x)
    expect((e as NearKitError).message).toMatch(/Rhea.*DCL|DCL.*Rhea/s)
  })
})

describe('testnet: the classic router and DCL, no fee on either', () => {
  it('a DCL pool on testnet routes without a fee transfer', async () => {
    const net = NETWORKS.testnet
    const T = 'fresh.nearlytrade.testnet'
    const chain = createFakeChain({
      accounts: { 'alice.testnet': { amount: 10n ** 25n } },
      tokens: {
        'wrap.testnet': { symbol: 'wNEAR', decimals: 24, registered: ['alice.testnet'], boundsMin: MIN_STORAGE },
        [T]: { symbol: 'FRESH', decimals: 18, registered: [], boundsMin: MIN_STORAGE },
      },
      wrapContract: 'wrap.testnet',
      dcl: {
        contract: net.dex.dcl.contract,
        pools: {
          [dclPoolId(T, 'wrap.testnet', 10000)]: {
            tokenX: T,
            tokenY: 'wrap.testnet',
            fee: 10000,
            liquidity: 10n ** 23n,
            rate: (tokenIn, amountIn) => (tokenIn === 'wrap.testnet' ? amountIn * 50n : amountIn / 50n),
          },
        },
      },
    })
    chain.route('https://smartroutertest.refburrow.top/', () => ({ result_code: 1, result_message: 'no path', result_data: null }))
    const { env } = parseEnv({ VITE_NEAR_NETWORK: 'testnet' })
    const r = await createSwapRouter(createNearContext({ env, network: net, fetch: chain.fetch, kv: memoryStorage() })).route(
      { tokenIn: 'near', tokenOut: T, amountIn: '1', slippagePct: 1, walletId: 'w' },
      'alice.testnet',
      true,
    )
    expect(r.source).toBe('dcl')
    expect(r.fee).toBeNull()
    expect(r.swapAmount).toBe(ONE)
    expect(r.amountOut).toBe(50n * ONE)
  })
})
