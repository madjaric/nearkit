import { describe, expect, it } from 'vitest'
import { parseEnv } from '@/config/env'
import { NETWORKS } from '@/config/networks'
import { NEARKIT_FEE_BPS } from '@/lib/fees'
import { accountState } from '@/services/near/account'
import { NearKitError } from '@/services/near/errors'
import { discoverFtHoldings } from '@/services/near/discovery'
import { fetchNearUsd, fetchTokenPrices } from '@/services/near/prices'
import { createRpcClient } from '@/services/near/rpc'
import { createDclPoolReader, dclPoolId } from '@/services/dcl/pools'
import { bestDclRoute } from '@/services/dcl/quote'
import { readTransferTax } from '@/services/dcl/tax'
import { storageBoundsMin } from '@/services/near/storage'
import { createTokenReader } from '@/services/near/tokens'
import { createFindPathClient } from '@/services/rhea/classic'
import { checkSmartxRoute, createSmartxClient, decodeSmartxMsg, verifySmartxSignature } from '@/services/rhea/smartx'
import { createNearContext } from '@/services/real/context'
import { createMarket } from '@/services/real/market'
import { memoryStorage } from '@/services/real/stores'
import { createTokenService } from '@/services/real/tokenService'

/**
 * Live, read-only checks that every external dependency still behaves the way
 * NearKit was built against (PHASE2_IMPLEMENTATION.md §4). Testnet first.
 * Run: npm run smoke:live. Nothing here signs or sends a transaction.
 */

const ONE = 10n ** 24n

describe('testnet (live)', () => {
  const net = NETWORKS.testnet
  const rpc = createRpcClient({ urls: net.rpcUrls })
  const reader = createTokenReader(rpc, { network: 'testnet', persist: false })

  it('RPC answers view_account on the wrap contract', async () => {
    const state = await accountState(rpc, net.wrapContract)
    expect(state.exists).toBe(true)
    expect(state.hasContract).toBe(true)
  })

  it('every configured token returns valid NEP-141 metadata and NEP-145 bounds', async () => {
    for (const contract of net.knownTokens) {
      const meta = await reader.metadata(contract)
      expect(meta.decimals).toBeGreaterThanOrEqual(0)
      expect(await storageBoundsMin(rpc, contract)).not.toBeUndefined()
    }
  })

  it('Rhea’s classic router quotes NEAR → default token with a verifiable route', async () => {
    const route = await createFindPathClient({ baseUrl: net.rhea.classic.findPathUrl }).quote({
      tokenIn: net.wrapContract,
      tokenOut: net.defaultTradeToken,
      amountIn: ONE,
      slippage: 0.005,
    })
    expect(route.amountOut).toBeGreaterThan(0n)
    expect(route.minAmountOut).toBeLessThanOrEqual(route.amountOut)
    expect(route.routeTokens[0]).toBe(net.wrapContract)
  })

  it('FastNEAR discovery answers for a known holder', async () => {
    const held = await discoverFtHoldings(fetch, net, net.rhea.classic.exchange)
    expect(Array.isArray(held)).toBe(true)
  })
})

describe('mainnet (live, read-only)', () => {
  const net = NETWORKS.mainnet
  const rpc = createRpcClient({ urls: net.rpcUrls })
  const agg = net.rhea.aggregator
  if (!agg) throw new Error('mainnet has an aggregator')

  it('the aggregator still whitelists wNEAR for fees and charges 1000 ppm itself', async () => {
    const whitelist = await rpc.viewFunction<string[]>(agg.contract, 'query_white_list_fee_tokens', { from_index: 0, count: 100 }, 'final')
    expect(whitelist).toContain(net.wrapContract)
    expect(await rpc.viewFunction<string>(agg.contract, 'query_protocol_fee_rate', {}, 'final')).toBe('1000')
  })

  it('a smartx quote decodes, verifies against the configured signer key and passes the route checks', async () => {
    const quote = await createSmartxClient({ baseUrl: agg.quoteUrl, spacingMs: 0 }).quote({
      tokenIn: net.wrapContract,
      tokenOut: 'usdt.tether-token.near',
      amountIn: ONE,
      slippage: 0.005,
      user: null,
      skipUnwrapNativeToken: true,
      appFeeRate: null,
      appFeeRecipient: null,
    })
    expect(await verifySmartxSignature(quote.msg, quote.signature, agg.signerKey)).toBe(true)
    const route = checkSmartxRoute(
      quote,
      decodeSmartxMsg(quote.msg),
      {
        user: '',
        tokenIn: net.wrapContract,
        tokenOut: 'usdt.tether-token.near',
        amountIn: ONE,
        slippage: 0.005,
        skipUnwrapNear: true,
        appFeePpm: null,
        appFeeRecipient: null,
        dexReceivers: agg.dexReceivers,
        referrals: agg.referrals,
      },
      Date.now(),
    )
    expect(route.routeTokens.at(-1)).toBe('usdt.tether-token.near')
  })

  it('a quote at NEARKITS’ fee (NEARKIT_FEE_BPS) comes back signed with that app_fee_rate and passes the route checks', async () => {
    // Pacing: Rhea answers burst requests with stale amounts.
    await new Promise((r) => setTimeout(r, 3_000))
    const request = { tokenIn: net.wrapContract, tokenOut: 'usdt.tether-token.near', amountIn: ONE, slippage: 0.005 }
    const quote = await createSmartxClient({ baseUrl: agg.quoteUrl, spacingMs: 0 }).quote({
      ...request,
      user: 'example.near',
      skipUnwrapNativeToken: true,
      appFeeRate: NEARKIT_FEE_BPS,
      appFeeRecipient: 'fees.example.near',
    })
    expect(await verifySmartxSignature(quote.msg, quote.signature, agg.signerKey)).toBe(true)
    const route = checkSmartxRoute(
      quote,
      decodeSmartxMsg(quote.msg),
      {
        ...request,
        user: 'example.near',
        skipUnwrapNear: true,
        appFeePpm: NEARKIT_FEE_BPS * 100,
        appFeeRecipient: 'fees.example.near',
        dexReceivers: agg.dexReceivers,
        referrals: agg.referrals,
      },
      Date.now(),
    )
    expect(route.appFeePpm).toBe(NEARKIT_FEE_BPS * 100)
  })

  it('a token in no list is found by its exact contract, and Rhea alone decides whether it trades', async () => {
    // A nearlytrade launch (NEP-591 global contract) that no NearKit list carries: new tokens such as $KITS start this way.
    const contract = 'singularty.nearlytrade.near'
    expect(net.knownTokens).not.toContain(contract)
    const env = parseEnv({ VITE_NEARKIT_SERVICES: 'near', VITE_NEAR_NETWORK: 'mainnet', VITE_ENABLE_MAINNET_EXECUTION: 'false' }).env
    const ctx = createNearContext({ env, network: net, kv: memoryStorage(), wallet: () => Promise.reject(new Error('smoke tests have no wallet')) })
    ctx.session.restored = true
    const token = await createTokenService(ctx, createMarket(ctx)).lookupToken(contract)
    expect(token).toMatchObject({ id: contract, contract, symbol: 'SINGULARTY', name: 'Singularity is NEAR', decimals: 18 })
    // A route, or Rhea's plain "no route": both are answers. Anything else would be NearKit's error.
    const answer = await createSmartxClient({ baseUrl: agg.quoteUrl, spacingMs: 0 })
      .quote({
        tokenIn: net.wrapContract,
        tokenOut: contract,
        amountIn: ONE / 10n,
        slippage: 0.01,
        user: null,
        skipUnwrapNativeToken: true,
        appFeeRate: NEARKIT_FEE_BPS,
        appFeeRecipient: 'fees.example.near',
      })
      .then(
        (q) => `route ${q.amountOut}`,
        (e: unknown) => (e instanceof NearKitError ? e.code : String(e)),
      )
    expect(answer === 'QUOTE_UNAVAILABLE' || answer.startsWith('route ')).toBe(true)
  })

  it('DCL quotes NEAR ↔ SINGULARTY on the pair’s pool, read from the contract itself, both ways (read-only)', async () => {
    const sing = 'singularty.nearlytrade.near'
    const dcl = net.dex.dcl.contract
    const reader = createDclPoolReader(rpc, dcl)
    expect((await reader.pools(sing, net.wrapContract)).map((p) => p.id)).toContain(dclPoolId(sing, net.wrapContract, 10000))
    const buy = await bestDclRoute(rpc, dcl, reader, net, net.wrapContract, sing, ONE)
    expect(buy?.amountOut ?? 0n).toBeGreaterThan(0n)
    expect([buy?.tokens[0], buy?.tokens.at(-1)]).toEqual([net.wrapContract, sing])
    const sell = await bestDclRoute(rpc, dcl, reader, net, sing, net.wrapContract, 100_000n * 10n ** 18n)
    expect(sell?.amountOut ?? 0n).toBeGreaterThan(0n)
    expect([sell?.tokens[0], sell?.tokens.at(-1)]).toEqual([sing, net.wrapContract])
    // The token taxes transfers to and from its pool (get_tax, 1% each way on 2026-10-03); NearKit quotes after it. wNEAR has no such tax.
    const tax = await readTransferTax(rpc, sing, dcl)
    expect(tax.buyBps).toBeGreaterThan(0)
    expect(tax.sellBps).toBeGreaterThan(0)
    expect(Math.max(tax.buyBps, tax.sellBps)).toBeLessThanOrEqual(1000)
    expect(await readTransferTax(rpc, net.wrapContract, dcl)).toEqual({ buyBps: 0, sellBps: 0 })
  })

  it('prices: Rhea lists wNEAR and Coinbase or CoinGecko quote NEAR/USD', async () => {
    const prices = await fetchTokenPrices(fetch, net.rhea.indexerUrl ?? '')
    expect(prices.get(net.wrapContract)).toBeGreaterThan(0)
    expect((await fetchNearUsd(fetch, net.nearUsd))?.priceUsd).toBeGreaterThan(0)
  })
})
