import { describe, expect, it, vi } from 'vitest'
import type { OperationPlan, TokenRef } from '@/types/operations'
import { conflictOf, createInFlight } from './inFlight'

const NEAR: TokenRef = { id: 'near', symbol: 'NEAR', decimals: 24, contract: null }
const NEARLY: TokenRef = { id: 'nearly.near', symbol: 'NEARLY', decimals: 18, contract: 'nearly.near' }
const USDC: TokenRef = { id: 'usdc.near', symbol: 'USDC', decimals: 6, contract: 'usdc.near' }
const amount = { raw: '1', display: '1' }

function swapPlan(id: string, signer: string, tokenIn: TokenRef, tokenOut: TokenRef, kind: OperationPlan['kind'] = 'swap'): OperationPlan {
  return {
    id,
    kind,
    mode: 'near',
    network: 'mainnet',
    title: `${tokenIn.symbol} → ${tokenOut.symbol}`,
    token: tokenIn,
    signers: [signer],
    lines: [],
    transactions: [],
    groups: [],
    totals: { amount, storage: amount, upfrontNear: amount },
    fee: null,
    swap: {
      router: 'aggregator',
      tokenIn,
      tokenOut,
      amountIn: amount,
      expectedOut: amount,
      minOut: amount,
      slippagePct: 1,
      priceImpactPct: null,
      route: [],
      quotedAt: 0,
    },
    warnings: [],
    expiresAt: null,
    createdAt: 0,
  }
}

describe('in-flight runs', () => {
  it('lists a run while it goes, and forgets it when released', () => {
    const runs = createInFlight()
    const seen = vi.fn()
    runs.subscribe(seen)
    const release = runs.add(swapPlan('a', 'bottest.near', NEAR, NEARLY))
    expect(runs.get().map((r) => r.planId)).toEqual(['a'])
    // A stable snapshot between changes (React's external store needs it).
    expect(runs.get()).toBe(runs.get())
    release()
    expect(runs.get()).toEqual([])
    expect(seen).toHaveBeenCalledTimes(2)
  })

  it('the same trade from the same wallet conflicts while the first is still going', () => {
    const runs = createInFlight()
    runs.add(swapPlan('first', 'bottest.near', NEAR, NEARLY))
    expect(conflictOf(runs.get(), swapPlan('again', 'bottest.near', NEAR, NEARLY))?.planId).toBe('first')
    // Another pair, another wallet or the same plan resumed: no conflict.
    expect(conflictOf(runs.get(), swapPlan('other-pair', 'bottest.near', NEAR, USDC))).toBeNull()
    expect(conflictOf(runs.get(), swapPlan('other-wallet', 'alice.near', NEAR, NEARLY))).toBeNull()
    expect(conflictOf(runs.get(), swapPlan('first', 'bottest.near', NEAR, NEARLY))).toBeNull()
  })

  it('a Multi Trade leg counts for its wallet too', () => {
    const runs = createInFlight()
    runs.add({ ...swapPlan('multi', 'a.near', NEAR, NEARLY, 'multi-trade'), signers: ['a.near', 'bottest.near'] })
    expect(conflictOf(runs.get(), swapPlan('again', 'bottest.near', NEAR, NEARLY))?.planId).toBe('multi')
  })

  it('operations that are not trades never conflict', () => {
    const runs = createInFlight()
    runs.add({ ...swapPlan('send', 'bottest.near', NEAR, NEARLY, 'batch-send'), swap: null })
    expect(conflictOf(runs.get(), { ...swapPlan('send2', 'bottest.near', NEAR, NEARLY, 'batch-send'), swap: null })).toBeNull()
  })
})
