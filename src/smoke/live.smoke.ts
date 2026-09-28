import { describe, expect, it } from 'vitest'
import { NETWORKS } from '@/config/networks'
import { NEARKIT_FEE_BPS } from '@/lib/fees'
import { accountState } from '@/services/near/account'
import { discoverFtHoldings } from '@/services/near/discovery'
import { fetchNearUsd, fetchTokenPrices } from '@/services/near/prices'
import { createRpcClient } from '@/services/near/rpc'
import { storageBoundsMin } from '@/services/near/storage'
import { createTokenReader } from '@/services/near/tokens'
import { createFindPathClient } from '@/services/rhea/classic'
import { checkSmartxRoute, createSmartxClient, decodeSmartxMsg, verifySmartxSignature } from '@/services/rhea/smartx'

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

  it('a quote at NearKit’s 0.10% fee comes back signed with app_fee_rate 1000 ppm and passes the route checks', async () => {
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
    expect(route.appFeePpm).toBe(1000)
  })

  it('prices: Rhea lists wNEAR and Coinbase or CoinGecko quote NEAR/USD', async () => {
    const prices = await fetchTokenPrices(fetch, net.rhea.indexerUrl ?? '')
    expect(prices.get(net.wrapContract)).toBeGreaterThan(0)
    expect((await fetchNearUsd(fetch, net.nearUsd))?.priceUsd).toBeGreaterThan(0)
  })
})
