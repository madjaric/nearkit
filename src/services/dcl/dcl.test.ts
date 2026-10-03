import { describe, expect, it } from 'vitest'
import { NETWORKS } from '@/config/networks'
import { createRpcClient } from '@/services/near/rpc'
import { createFakeChain } from '@/services/real/testing/fakeChain'
import { createDclPoolReader, DCL_FEE_TIERS, dclPoolId, dclPoolTokens, parseDclPool } from './pools'
import { bestDclRoute, dclQuote, dclTokenPaths } from './quote'
import { dclPathTokens, dclSwapMsg, directFee } from './swap'
import { NO_TAX, readTransferTax } from './tax'

/**
 * DCL v2 read from the contract itself: deterministic pool ids per fee tier, on-chain quotes
 * along a path of pools, the swap message of real direct swaps, and NearKit's fee on a direct
 * route. Pool ids and the `get_pool` / `quote` answers follow what `dclv2.ref-labs.near`
 * returned live on 2026-10-03.
 */

const DCL = 'dclv2.ref-labs.near'
const WRAP = 'wrap.near'
const SING = 'singularty.nearlytrade.near'
const USDC = NETWORKS.mainnet.stableTokens[0]?.contract as string
const NEW = 'newtoken.nearlytrade.near'
const ONE = 10n ** 24n

const livePool = {
  pool_id: 'singularty.nearlytrade.near|wrap.near|10000',
  token_x: SING,
  token_y: WRAP,
  fee: 10000,
  point_delta: 200,
  current_point: 40114,
  liquidity: '50498695734733140569374',
  state: 'Running',
}

describe('pool ids', () => {
  it('order the tokens lexicographically and name the fee tier', () => {
    expect(dclPoolId(WRAP, SING, 10000)).toBe('singularty.nearlytrade.near|wrap.near|10000')
    expect(dclPoolId(SING, WRAP, 10000)).toBe('singularty.nearlytrade.near|wrap.near|10000')
    expect(dclPoolId(USDC, WRAP, 400)).toBe(`${USDC}|wrap.near|400`)
    expect(DCL_FEE_TIERS).toEqual([100, 400, 2000, 10000])
  })
  it('read back their tokens, and reject what is not a pool id', () => {
    expect(dclPoolTokens('singularty.nearlytrade.near|wrap.near|10000')).toEqual({ tokenX: SING, tokenY: WRAP, fee: 10000 })
    expect(dclPoolTokens('wrap.near|singularty.nearlytrade.near|10000')).toBeNull()
    expect(dclPoolTokens('a|b|7')).toBeNull()
    expect(dclPoolTokens('a|b')).toBeNull()
  })
  it('parse the contract’s pool, and nothing else', () => {
    expect(parseDclPool(livePool)).toEqual({ id: livePool.pool_id, tokenX: SING, tokenY: WRAP, fee: 10000, liquidity: 50498695734733140569374n, running: true })
    expect(parseDclPool(null)).toBeNull()
    expect(parseDclPool({ ...livePool, pool_id: 'other|wrap.near|10000' })).toBeNull()
    expect(parseDclPool({ ...livePool, liquidity: 'lots' })).toBeNull()
    expect(parseDclPool({ ...livePool, state: 'Paused' })?.running).toBe(false)
  })
})

function chain(
  pools: Record<string, { tokenX: string; tokenY: string; fee: number; liquidity: bigint; rate: (tokenIn: string, amountIn: bigint) => bigint; state?: 'Running' | 'Paused' }>,
) {
  return createFakeChain({ accounts: {}, tokens: {}, dcl: { contract: DCL, pools } })
}

/** A constant-rate pool: 1 wNEAR = `perNear` of the other token, 1% fee. */
const pool = (token: string, perNear: bigint, liquidity = 10n ** 22n, fee = 10000) => ({
  tokenX: token < WRAP ? token : WRAP,
  tokenY: token < WRAP ? WRAP : token,
  fee,
  liquidity,
  rate: (tokenIn: string, amountIn: bigint) => ((tokenIn === WRAP ? amountIn * perNear : amountIn / perNear) * 99n) / 100n,
})

describe('pool discovery', () => {
  it('finds the pools of a pair by reading each tier, deepest first, and ignores paused or empty ones', async () => {
    const fake = chain({
      [dclPoolId(SING, WRAP, 10000)]: pool(SING, 18000n, 5n * 10n ** 22n),
      [dclPoolId(SING, WRAP, 2000)]: pool(SING, 18000n, 9n * 10n ** 22n, 2000),
      [dclPoolId(SING, WRAP, 400)]: { ...pool(SING, 18000n, 10n ** 23n, 400), state: 'Paused' as const },
      [dclPoolId(SING, WRAP, 100)]: pool(SING, 18000n, 0n, 100),
    })
    const rpc = createRpcClient({ urls: ['https://rpc.test'], fetch: fake.fetch })
    const reader = createDclPoolReader(rpc, DCL)
    const found = await reader.pools(WRAP, SING)
    expect(found.map((p) => [p.fee, p.liquidity])).toEqual([
      [2000, 9n * 10n ** 22n],
      [10000, 5n * 10n ** 22n],
    ])
    expect(fake.rpcCalls('query')).toHaveLength(4)
  })

  it('remembers tiers that have no pool for a minute, and re-reads an existing pool every time', async () => {
    let now = 1_000_000
    const fake = chain({ [dclPoolId(NEW, WRAP, 10000)]: pool(NEW, 100n) })
    const rpc = createRpcClient({ urls: ['https://rpc.test'], fetch: fake.fetch })
    const reader = createDclPoolReader(rpc, DCL, () => now)
    expect((await reader.pools(NEW, WRAP)).map((p) => p.id)).toEqual([dclPoolId(NEW, WRAP, 10000)])
    expect((await reader.pools(NEW, WRAP)).map((p) => p.id)).toEqual([dclPoolId(NEW, WRAP, 10000)])
    // Four reads, then only the one pool that exists.
    expect(fake.rpcCalls('query')).toHaveLength(5)
    // A pool created in the meantime shows up once the minute is over.
    fake.dclPools?.set(dclPoolId(NEW, WRAP, 2000), pool(NEW, 100n, 10n ** 23n, 2000))
    expect((await reader.pools(NEW, WRAP)).map((p) => p.fee)).toEqual([10000])
    now += 61_000
    expect((await reader.pools(NEW, WRAP)).map((p) => p.fee)).toEqual([2000, 10000])
  })
})

describe('quotes', () => {
  it('asks the contract along a path of pools and reads the amount', async () => {
    const fake = chain({ [dclPoolId(SING, WRAP, 10000)]: pool(SING, 18000n) })
    const rpc = createRpcClient({ urls: ['https://rpc.test'], fetch: fake.fetch })
    expect(await dclQuote(rpc, DCL, { pools: [dclPoolId(SING, WRAP, 10000)], tokenIn: WRAP, tokenOut: SING, amountIn: ONE })).toBe(17820n * ONE)
    expect(await dclQuote(rpc, DCL, { pools: [dclPoolId(SING, WRAP, 10000)], tokenIn: SING, tokenOut: WRAP, amountIn: 18000n * ONE })).toBe((99n * ONE) / 100n)
  })
  it('a pool that isn’t there, or a path that doesn’t connect, quotes nothing (never an error the user sees)', async () => {
    const fake = chain({ [dclPoolId(SING, WRAP, 10000)]: pool(SING, 18000n) })
    const rpc = createRpcClient({ urls: ['https://rpc.test'], fetch: fake.fetch })
    expect(await dclQuote(rpc, DCL, { pools: [dclPoolId(SING, WRAP, 400)], tokenIn: WRAP, tokenOut: SING, amountIn: ONE })).toBe(0n)
    expect(await dclQuote(rpc, DCL, { pools: [dclPoolId(SING, WRAP, 10000)], tokenIn: WRAP, tokenOut: USDC, amountIn: ONE })).toBe(0n)
  })
  it('tries the pair itself and two-hop paths through wNEAR and the network’s stablecoins', () => {
    expect(dclTokenPaths(NETWORKS.mainnet, WRAP, SING)).toEqual([
      [WRAP, SING],
      [WRAP, USDC, SING],
      [WRAP, 'usdt.tether-token.near', SING],
    ])
    expect(dclTokenPaths(NETWORKS.mainnet, SING, USDC)).toEqual([
      [SING, USDC],
      [SING, WRAP, USDC],
      [SING, 'usdt.tether-token.near', USDC],
    ])
  })
  it('picks the path with the highest output: a direct pool, or two hops through a stablecoin when that pays more', async () => {
    const stable = (a: string, b: string, perA: bigint, fee: number) => ({
      tokenX: a < b ? a : b,
      tokenY: a < b ? b : a,
      fee,
      liquidity: 10n ** 24n,
      rate: (tokenIn: string, amountIn: bigint) => (tokenIn === a ? amountIn * perA : amountIn / perA),
    })
    const fake = chain({
      // Thin direct pool: 1 wNEAR → 10,000 NEW; through USDC: 1 wNEAR → 5 USDC → 12,500 NEW.
      [dclPoolId(NEW, WRAP, 10000)]: pool(NEW, 10100n),
      [dclPoolId(USDC, WRAP, 400)]: stable(WRAP, USDC, 5n, 400),
      [dclPoolId(NEW, USDC, 10000)]: stable(USDC, NEW, 2500n, 10000),
    })
    const rpc = createRpcClient({ urls: ['https://rpc.test'], fetch: fake.fetch })
    const reader = createDclPoolReader(rpc, DCL)
    const best = await bestDclRoute(rpc, DCL, reader, NETWORKS.mainnet, WRAP, NEW, ONE)
    expect(best).toEqual({ pools: [dclPoolId(USDC, WRAP, 400), dclPoolId(NEW, USDC, 10000)], tokens: [WRAP, USDC, NEW], amountIn: ONE, amountOut: 12500n * ONE })
    // Nothing fills a pair with no pools.
    expect(await bestDclRoute(rpc, DCL, reader, NETWORKS.mainnet, WRAP, 'nobody.near', ONE)).toBeNull()
  })
})

describe('transfer tax', () => {
  const DEX = 'dclv2.ref-labs.near'
  const chain = () =>
    createFakeChain({
      tokens: {
        'taxed.nearlytrade.near': { symbol: 'TAXED', decimals: 18, boundsMin: null, tax: { buyBps: 100, sellBps: 250, pairs: [DEX] } },
        'elsewhere.nearlytrade.near': { symbol: 'ELSE', decimals: 18, boundsMin: null, tax: { buyBps: 100, sellBps: 100, pairs: ['v2.ref-finance.near'] } },
        'plain.near': { symbol: 'PLAIN', decimals: 18, boundsMin: null },
      },
    })

  it('reads buy and sell basis points when the DCL contract is one of the token’s pairs', async () => {
    const rpc = createRpcClient({ urls: ['https://rpc.test'], fetch: chain().fetch })
    expect(await readTransferTax(rpc, 'taxed.nearlytrade.near', DEX)).toEqual({ buyBps: 100, sellBps: 250 })
  })

  it('reports no tax for a token without get_tax, or whose tax names other pairs', async () => {
    const rpc = createRpcClient({ urls: ['https://rpc.test'], fetch: chain().fetch })
    expect(await readTransferTax(rpc, 'plain.near', DEX)).toEqual(NO_TAX)
    expect(await readTransferTax(rpc, 'elsewhere.nearlytrade.near', DEX)).toEqual(NO_TAX)
  })
})

describe('the swap message and the fee', () => {
  it('is the Swap message of real direct swaps, keeping wNEAR only when asked', () => {
    expect(dclSwapMsg({ pools: ['singularty.nearlytrade.near|wrap.near|10000'], outputToken: SING, minOut: 123n, skipUnwrapNear: false })).toBe(
      '{"Swap":{"pool_ids":["singularty.nearlytrade.near|wrap.near|10000"],"output_token":"singularty.nearlytrade.near","min_output_amount":"123"}}',
    )
    expect(JSON.parse(dclSwapMsg({ pools: ['a|b|400'], outputToken: 'b', minOut: 1n, skipUnwrapNear: true }))).toEqual({
      Swap: { pool_ids: ['a|b|400'], output_token: 'b', min_output_amount: '1', skip_unwrap_near: true },
    })
  })
  it('walks the tokens of a pool path from the input, and refuses a path that doesn’t connect', () => {
    expect(dclPathTokens([dclPoolId(USDC, WRAP, 400), dclPoolId(NEW, USDC, 10000)], WRAP)).toEqual([WRAP, USDC, NEW])
    expect(dclPathTokens([dclPoolId(NEW, USDC, 10000)], WRAP)).toBeNull()
    expect(dclPathTokens(['not a pool'], WRAP)).toBeNull()
  })
  it('is 0.50% of the input, floored, exactly once', () => {
    expect(directFee(ONE)).toBe(5n * 10n ** 21n)
    expect(directFee(1_999n)).toBe(9n)
    expect(directFee(0n)).toBe(0n)
  })
})
