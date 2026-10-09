import { describe, expect, it } from 'vitest'
import { bridgeHeadline, nearBridgeSteps } from '@/lib/bridge/progress'
import type { BridgeOrderView, BridgeQuoteView } from '@/lib/bridge/types'
import { bridgeActivity, orderHref } from './activity'
import { orderSummary } from './format'

/**
 * How a Bridge (to NEAR, no purchase) reads on its page and in Activity: its own steps, each done
 * only on what was seen; the NEAR it received from the unwrap's or the delivery's own record, never a
 * stale estimate once something arrived; its own title and page. Bridge & Buy reads as it always did.
 */

const ONE = 10n ** 24n
const QUOTE = {
  chain: 'sol',
  amountIn: '60000000',
  amountInUsd: 6.6,
  nearOut: ((1430n * ONE) / 1000n).toString(),
  nearMinOut: ((1415n * ONE) / 1000n).toString(),
  nearOutUsd: 6.5,
  fee: { nearkitsBps: 25, intentsBps: 25, nearkitsRaw: '150000', intentsRaw: '150000' },
  timeEstimateSec: 20,
  refundFee: null,
  kits: null,
  kitsUnavailable: null,
  quotedAt: 1,
} satisfies BridgeQuoteView

const order = (status: BridgeOrderView['status'], over: Partial<BridgeOrderView> = {}): BridgeOrderView => ({
  id: 'order-1234',
  product: 'bridge',
  status,
  chain: 'sol',
  sourceAddress: 'So1',
  depositAddress: 'Dep',
  depositDeadline: 2,
  signBy: 1,
  quote: QUOTE,
  destination: { kind: 'nearkits', accountId: 'a'.repeat(64), walletId: 'w1', name: 'Main' },
  depositTx: null,
  delivered: null,
  kits: null,
  unwrapped: null,
  refund: null,
  message: null,
  createdAt: 10,
  updatedAt: 10,
  ...over,
})

const wnear = { amount: ((1421n * ONE) / 1000n).toString(), asset: 'wnear' as const, txs: [{ hash: 'Dlv', url: 'u' }] }
const states = (o: BridgeOrderView) => nearBridgeSteps(o).map((s) => `${s.key}:${s.state}`)

describe('a Bridge’s steps: transfer, NEAR Intents, received on NEAR, unwrap if required, complete', () => {
  it('walks them as each is seen, to a NEARKITS wallet', () => {
    expect(states(order('awaiting-deposit'))).toEqual(['source:todo', 'bridge:todo', 'near:todo', 'unwrap:todo', 'complete:todo'])
    expect(states(order('bridging'))).toEqual(['source:done', 'bridge:active', 'near:todo', 'unwrap:todo', 'complete:todo'])
    expect(states(order('unwrapping', { delivered: wnear }))).toEqual(['source:done', 'bridge:done', 'near:done', 'unwrap:active', 'complete:todo'])
    expect(states(order('complete', { delivered: wnear, unwrapped: { amount: wnear.amount, txs: [] } }))).toEqual([
      'source:done',
      'bridge:done',
      'near:done',
      'unwrap:done',
      'complete:done',
    ])
  })

  it('names what arrived and who unwraps it; marks where it stopped', () => {
    const steps = (o: BridgeOrderView) => Object.fromEntries(nearBridgeSteps(o).map((s) => [s.key, s.label]))
    expect(steps(order('bridging')).near).toBe('Assets received on NEAR')
    expect(steps(order('unwrapping', { delivered: wnear })).near).toBe('wNEAR received on NEAR')
    expect(steps(order('complete', { delivered: { ...wnear, asset: 'near' } })).unwrap).toMatch(/not needed, native NEAR arrived/)
    expect(steps(order('delivered', { delivered: wnear, destination: { kind: 'connected', accountId: 'bob.near', walletId: null, name: null } })).unwrap).toMatch(
      /your wallet signs/,
    )
    expect(steps(order('complete', { delivered: wnear, destination: { kind: 'external', accountId: 'carol.near', walletId: null, name: null } })).unwrap).toMatch(
      /arrives as wNEAR/,
    )
    expect(states(order('unwrap-needed', { delivered: wnear }))).toEqual(['source:done', 'bridge:done', 'near:done', 'unwrap:error', 'complete:todo'])
    expect(states(order('refunded'))).toContain('bridge:error')
  })

  it('says complete only when it is; an external address’s result is said as wNEAR', () => {
    for (const s of ['awaiting-deposit', 'deposit-seen', 'bridging', 'delivered', 'unwrapping', 'unwrap-needed', 'refunded', 'failed', 'expired'] as const)
      expect(bridgeHeadline(order(s))).not.toMatch(/^Completed$/)
    expect(bridgeHeadline(order('complete', { delivered: wnear }))).toBe('Completed')
    expect(bridgeHeadline(order('complete', { delivered: wnear, destination: { kind: 'external', accountId: 'carol.near', walletId: null, name: null } }))).toBe(
      'Delivered as wNEAR',
    )
    expect(bridgeHeadline(order('unwrap-needed'))).toBe('Bridged, not unwrapped')
    expect(bridgeHeadline(order('delivered', { destination: { kind: 'connected', accountId: 'bob.near', walletId: null, name: null } }))).toBe('wNEAR arrived: unwrap to NEAR')
    // Bridge & Buy's words are its own still.
    expect(bridgeHeadline({ ...order('complete'), product: 'buy-kits' })).toBe('$KITS purchase complete')
  })
})

describe('a Bridge in Activity: “0.06 SOL → 1.42 NEAR · Solana → NEAR · Completed”, from what was verified', () => {
  it('names the verified NEAR (the unwrap’s own record), its product and its own page', () => {
    const done = order('complete', { delivered: wnear, unwrapped: { amount: wnear.amount, txs: [{ hash: 'Unw', url: 'u' }] }, depositTx: { hash: 'Src', url: 'u' } })
    const a = bridgeActivity(done)
    expect(a.title).toBe('Bridge')
    expect(a.detail).toBe('0.06 SOL → 1.421 NEAR · Solana → NEAR · Completed')
    expect(a.status).toBe('success')
    expect(a.href).toBe('/bridge-near?order=order-1234')
    expect(a.txHashes).toEqual(['Src', 'Dlv', 'Unw'])
  })

  it('an estimate only while nothing arrived; the delivery as it came once it did; partial when not unwrapped', () => {
    expect(orderSummary(order('bridging'))).toBe('0.06 SOL → ≈ 1.43 NEAR')
    expect(orderSummary(order('unwrap-needed', { delivered: wnear }))).toBe('0.06 SOL → 1.421 wNEAR')
    expect(bridgeActivity(order('unwrap-needed', { delivered: wnear })).status).toBe('partial')
    expect(orderSummary(order('refunded'))).toBe('0.06 SOL → NEAR')
    expect(bridgeActivity(order('refunded')).status).toBe('failed')
  })

  it('Bridge & Buy keeps its title and its page', () => {
    const bb = { ...order('complete'), product: 'buy-kits' as const }
    expect(bridgeActivity(bb).title).toBe('Bridge & Buy')
    expect(orderHref(bb)).toBe('/bridge?order=order-1234')
  })
})
