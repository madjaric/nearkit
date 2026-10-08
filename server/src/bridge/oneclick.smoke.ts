import { describe, expect, it } from 'vitest'
import { BRIDGE_CHAINS, BRIDGE_NEAR_ASSET } from '@/config/bridge'
import { KITS_CONTRACT } from '@/config/kit'
import { bridgeAppFeeRequestBps, feeSplitOf } from '@/lib/bridge/fee'
import { BRIDGE_FEE_BPS, PRODUCTION_FEE_RECIPIENT } from '@/lib/fees'
import { createLogger } from '../log'
import { createOneClick, OneClickError, type OneClickQuoteRequest } from './oneclick'

/**
 * Live, read only: NEAR Intents' 1Click as Bridge & Buy relies on it. Dry quotes only (no deposit
 * address is made; nothing can be sent anywhere). Run: npx vitest run --config vitest.smoke.config.ts
 * server/src/bridge/oneclick.smoke.ts
 */

const oneclick = createOneClick({ fetch, log: createLogger({ level: 'warn', secrets: [] }) })
/** Random keys nobody holds: a dry quote's refund address only has to have the chain's shape. */
const REFUND = { solana: 'FDHEVP16btz5HCjFjMkQWzwGDqYpMpgDk6i7taVdK442', evm: '0xdb0f8971f948f7e14f7bfb12c1b870388a4cf12a' }

const dry = (originAsset: string, amount: string, refundTo: string, destinationAsset = BRIDGE_NEAR_ASSET): OneClickQuoteRequest => ({
  dry: true,
  swapType: 'EXACT_INPUT',
  slippageTolerance: 100,
  originAsset,
  depositType: 'ORIGIN_CHAIN',
  destinationAsset,
  amount,
  refundTo,
  refundType: 'ORIGIN_CHAIN',
  recipient: PRODUCTION_FEE_RECIPIENT,
  recipientType: 'DESTINATION_CHAIN',
  deadline: new Date(Date.now() + 20 * 60_000).toISOString(),
  referral: 'nearkits',
  quoteWaitingTimeMs: 3000,
  appFees: [{ recipient: PRODUCTION_FEE_RECIPIENT, fee: bridgeAppFeeRequestBps() }],
})

describe('NEAR Intents 1Click, live (dry quotes only)', () => {
  it('lists SOL, ETH and BNB with NEARKITS’ asset ids and decimals, and wNEAR on NEAR', async () => {
    const tokens = await oneclick.tokens()
    for (const c of BRIDGE_CHAINS) expect(tokens.some((t) => t.assetId === c.assetId && t.blockchain === c.id && t.decimals === c.decimals)).toBe(true)
    expect(tokens.some((t) => t.assetId === BRIDGE_NEAR_ASSET && t.decimals === 24)).toBe(true)
    // $KITS isn't one of its tokens: Bridge & Buy is two stages.
    expect(tokens.some((t) => t.assetId.includes(KITS_CONTRACT))).toBe(false)
  }, 30_000)

  it('prices 1 SOL to wNEAR, paying NEARKITS exactly its 0.25% of the input', async () => {
    const q = await oneclick.quote(dry('nep141:sol.omft.near', '1000000000', REFUND.solana))
    expect(q.amountOut).toBeGreaterThan(0n)
    expect(feeSplitOf(q.appFees, PRODUCTION_FEE_RECIPIENT)?.nearkitsBps).toBe(BRIDGE_FEE_BPS)
  }, 30_000)

  it('prices 0.1 ETH to wNEAR', async () => {
    const q = await oneclick.quote(dry('nep141:eth.omft.near', '100000000000000000', REFUND.evm))
    expect(feeSplitOf(q.appFees, PRODUCTION_FEE_RECIPIENT)?.nearkitsBps).toBe(BRIDGE_FEE_BPS)
  }, 30_000)

  it('quotes BNB to wNEAR or names its minimum', async () => {
    try {
      const q = await oneclick.quote(dry('nep245:v2_1.omni.hot.tg:56_11111111111111111111', '2000000000000000000', REFUND.evm))
      expect(feeSplitOf(q.appFees, PRODUCTION_FEE_RECIPIENT)?.nearkitsBps).toBe(BRIDGE_FEE_BPS)
    } catch (e) {
      expect(e).toBeInstanceOf(OneClickError)
      expect((e as OneClickError).kind).toBe('below-minimum')
    }
  }, 30_000)

  it('refuses $KITS as a destination (not one of its tokens)', async () => {
    await expect(oneclick.quote(dry('nep141:sol.omft.near', '1000000000', REFUND.solana, `nep141:${KITS_CONTRACT}`))).rejects.toMatchObject({ kind: 'no-route' })
  }, 30_000)
})
