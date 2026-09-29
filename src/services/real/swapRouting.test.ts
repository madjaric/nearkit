import { describe, expect, it } from 'vitest'
import { parseEnv } from '@/config/env'
import { NETWORKS } from '@/config/networks'
import { createNearContext } from './context'
import { memoryStorage } from './stores'
import { createSwapRouter, type RoutedSwap } from './swapRouting'
import { createFakeChain } from './testing/fakeChain'

const AGG = 'aggregatedex.near'
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
const MIN_STORAGE = 1_250_000_000_000_000_000_000n

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

// NEAR → USDC through the aggregator; the 0.10% fee is taken from the wNEAR going in.
const swap = (feeRecipient: string): RoutedSwap => ({
  router: 'aggregator',
  tokenIn: { id: 'near', symbol: 'NEAR', decimals: 24, contract: null },
  tokenOut: { id: USDC, symbol: 'USDC', decimals: 6, contract: USDC },
  routeIn: 'wrap.near',
  routeOut: USDC,
  amountIn: 10n ** 23n,
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
