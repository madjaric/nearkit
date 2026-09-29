import { describe, expect, it } from 'vitest'
import type { Holding } from '@/types/domain'
import { balancesMoved, createRefreshStatus, refreshTargets, refreshUntilMoved, snapshotOf, REFRESH_DELAYS_MS } from './postTradeRefresh'

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
