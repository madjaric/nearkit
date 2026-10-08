import { describe, expect, it } from 'vitest'
import type { Holding } from '@/types/domain'
import { balancesMoved, createRefreshStatus, refreshTargets, refreshUntilMoved, sendTargets, snapshotOf, wrapTargets, REFRESH_DELAYS_MS } from './postTradeRefresh'

const USDT = 'usdt.tether-token.near'
const plan = {
  signers: ['alice.near'],
  lines: [],
  token: { id: 'near', symbol: 'NEAR', decimals: 24, contract: null },
  swap: {
    tokenIn: { id: 'near', symbol: 'NEAR', decimals: 24, contract: null },
    tokenOut: { id: USDT, symbol: 'USDT', decimals: 6, contract: USDT },
  },
} as unknown as Parameters<typeof refreshTargets>[0]
const holding = (walletId: string, tokenId: string, raw: string): Holding => ({ walletId, tokenId, amount: Number(raw), raw })

describe('balances after a trade', () => {
  it('targets the signers and the traded tokens', () => {
    expect(refreshTargets(plan)).toEqual({ accounts: ['alice.near'], tokens: ['near', USDT] })
  })

  it('sees a trade in the balances: a new token appearing, one moving, one going to zero', () => {
    const t = refreshTargets(plan)
    const before = snapshotOf([holding('alice.near', 'near', '5'), holding('bob.near', USDT, '1')], t)
    expect(balancesMoved(before, snapshotOf([holding('alice.near', 'near', '5')], t))).toBe(false)
    expect(balancesMoved(before, snapshotOf([holding('alice.near', 'near', '5'), holding('alice.near', USDT, '4')], t))).toBe(true)
    expect(balancesMoved(before, snapshotOf([holding('alice.near', 'near', '4')], t))).toBe(true)
    expect(balancesMoved(before, snapshotOf([], t))).toBe(true)
    // Other accounts and other tokens don't count.
    expect(balancesMoved(before, snapshotOf([holding('alice.near', 'near', '5'), holding('bob.near', USDT, '9'), holding('alice.near', 'x.near', '1')], t))).toBe(false)
  })

  it('asks again on a bounded schedule and stops as soon as the balances show the trade', async () => {
    const waits: number[] = []
    let reads = 0
    const outcome = await refreshUntilMoved({
      before: new Map([['alice.near|near', '5']]),
      refresh: async () => undefined,
      // The readers lag: the third try sees the new balance.
      read: () => new Map([['alice.near|near', ++reads >= 3 ? '4' : '5']]),
      sleep: async (ms) => void waits.push(ms),
    })
    expect(outcome).toBe('updated')
    expect(reads).toBe(3)
    expect(waits).toEqual([1_500, 2_500])
  })

  it('gives up after the last try, never looping; a failed refresh is just another try', async () => {
    let tries = 0
    const outcome = await refreshUntilMoved({
      before: new Map([['alice.near|near', '5']]),
      refresh: async () => {
        tries++
        if (tries === 2) throw new Error('RPC down')
      },
      read: () => new Map([['alice.near|near', '5']]),
      sleep: async () => undefined,
    })
    expect(outcome).toBe('unchanged')
    expect(tries).toBe(REFRESH_DELAYS_MS.length)
  })

  it('a newer trade’s refresh takes over from an older one', async () => {
    const status = createRefreshStatus(() => 1)
    let release: () => void = () => {}
    const first = status.track(async (cancelled) => {
      await new Promise<void>((r) => (release = r))
      return cancelled() ? 'cancelled' : 'updated'
    })
    const second = status.track(async () => 'updated')
    expect(await second).toBe('updated')
    release()
    expect(await first).toBe('cancelled')
    expect(status.get()).toEqual({ state: 'updated', at: 1 })
  })

  it('reports updating, then updated, or stale when the balances never moved', async () => {
    const status = createRefreshStatus(() => 7)
    const seen: string[] = []
    status.subscribe(() => seen.push(status.get().state))
    await status.track(async () => 'unchanged')
    expect(seen).toEqual(['updating', 'stale'])
  })
})

describe('balances after an unwrap from a NEARKITS wallet (wNEAR back to NEAR)', () => {
  const WRAP = 'wrap.near'
  it('targets the one wallet, for wNEAR and NEAR', () => {
    expect(wrapTargets('a.near', WRAP)).toEqual({ accounts: ['a.near'], tokens: [WRAP, 'near'] })
  })

  it('sees the unwrap once wNEAR drops and NEAR rises', () => {
    const t = wrapTargets('a.near', WRAP)
    const before = snapshotOf([holding('a.near', WRAP, '2000000000000000000000000'), holding('a.near', 'near', '1000000000000000000000000')], t)
    expect(balancesMoved(before, snapshotOf([holding('a.near', WRAP, '2000000000000000000000000'), holding('a.near', 'near', '1000000000000000000000000')], t))).toBe(false)
    expect(balancesMoved(before, snapshotOf([holding('a.near', WRAP, '500000000000000000000000'), holding('a.near', 'near', '2499000000000000000000000')], t))).toBe(true)
  })
})

describe('balances after a run across several wallets (Consolidate, Split, Batch Send)', () => {
  it('targets every source and every destination of the lines, for the token moved', () => {
    expect(
      sendTargets('near', [
        { from: 'a.near', to: 'dest.near' },
        { from: 'b.near', to: 'dest.near' },
      ]),
    ).toEqual({ accounts: ['a.near', 'b.near', 'dest.near'], tokens: ['near'] })
    expect(sendTargets(USDT, [{ from: 'a.near', to: 'x.near' }])).toEqual({ accounts: ['a.near', 'x.near'], tokens: [USDT, 'near'] })
  })

  it('waits until every source shows the change, not only the first one', async () => {
    let reads = 0
    const before = new Map([
      ['a.near|near', '5'],
      ['b.near|near', '5'],
    ])
    const outcome = await refreshUntilMoved({
      before,
      expected: ['a.near|near', 'b.near|near'],
      refresh: async () => undefined,
      // a.near's balance shows the send at once; b.near's only at the third read.
      read: () => {
        reads++
        return new Map([
          ['a.near|near', '1'],
          ['b.near|near', reads >= 3 ? '1' : '5'],
        ])
      },
      sleep: async () => undefined,
    })
    expect(outcome).toBe('updated')
    expect(reads).toBe(3)
  })

  it('counts a destination that held nothing before once the token appears there', async () => {
    const outcome = await refreshUntilMoved({
      before: new Map([['a.near|' + USDT, '9']]),
      expected: ['a.near|' + USDT, 'dest.near|' + USDT],
      refresh: async () => undefined,
      read: () => new Map([['dest.near|' + USDT, '9']]),
      sleep: async () => undefined,
    })
    expect(outcome).toBe('updated')
  })

  it('refreshes once more after the balances moved, for the gas refund that lands a moment later', async () => {
    const refreshes: string[] = []
    let calls = 0
    const outcome = await refreshUntilMoved({
      before: new Map([['a.near|near', '5']]),
      refresh: async () => void refreshes.push(`try ${++calls}`),
      read: () => new Map([['a.near|near', '4']]),
      sleep: async () => undefined,
      followUp: async () => void refreshes.push('follow-up'),
    })
    expect(outcome).toBe('updated')
    expect(refreshes).toEqual(['try 1', 'follow-up'])
  })
})
