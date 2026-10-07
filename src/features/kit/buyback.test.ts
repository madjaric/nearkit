import { describe, expect, it } from 'vitest'
import { buybackReadouts, buybackTracker, type BuybackFacts } from './buyback'

/**
 * $KITS' Buyback & Burn tracker follows one contract, kits.nearlytrade.near, and shows what the
 * chain recorded once a source reads it. Before that it prints no figure at all (never a zero
 * that looks measured), and nothing here can make one up.
 */

const KITS = 'kits.nearlytrade.near'
const NOTHING_READ: BuybackFacts = { boughtBackYocto: null, boughtBackUsd: null, burnedRaw: null, burnedUsd: null, lastBuybackAt: null, lastBuybackTx: null }
const NEAR = 10n ** 24n

describe('the Buyback & Burn tracker', () => {
  it('follows nothing on a network without $KITS (testnet), whatever it is handed', () => {
    expect(buybackTracker(null, null)).toEqual({ state: 'not-on-network' })
    expect(buybackTracker(null, { ...NOTHING_READ, burnedRaw: '5' })).toEqual({ state: 'not-on-network' })
  })

  it('follows $KITS’ own contract: waiting for an on-chain source, then tracking what that source read', () => {
    expect(buybackTracker(KITS, null)).toEqual({ state: 'awaiting-data', contract: KITS })
    expect(buybackTracker(KITS, NOTHING_READ)).toEqual({ state: 'tracking', contract: KITS, facts: NOTHING_READ })
  })

  it('prints no figure it has not read: every slot is "—", with no digit anywhere, never a zero', () => {
    for (const tracker of [buybackTracker(null, null), buybackTracker(KITS, null), buybackTracker(KITS, NOTHING_READ)]) {
      const slots = buybackReadouts(tracker, 18)
      expect(slots.map((s) => s.legend)).toEqual(['Total bought back', 'Total burned', '$KITS burned', 'Last buyback'])
      expect(slots.map((s) => s.value)).toEqual(['—', '—', '—', '—'])
      for (const s of slots) expect(`${s.value} ${s.sub}`, s.legend).not.toMatch(/\d/)
    }
  })

  it('prints what the chain recorded, each in its own unit', () => {
    const facts: BuybackFacts = {
      boughtBackYocto: ((1234n * NEAR) / 10n).toString(),
      boughtBackUsd: 512.3,
      burnedRaw: (2_500_000n * 10n ** 18n).toString(),
      burnedUsd: 498.1,
      lastBuybackAt: Date.UTC(2026, 10, 2, 12, 0),
      lastBuybackTx: '7Hb1qXk3ZmPq9WvT2sYd4nLr8cJf6aGe5uBo1iKx3Np',
    }
    const [bought, burned, kits, last] = buybackReadouts(buybackTracker(KITS, facts), 18)
    expect(bought).toMatchObject({ value: '123.4 NEAR', sub: '≈ $512.30' })
    expect(burned).toMatchObject({ value: '$498.10', sub: 'USD value of the $KITS burned' })
    expect(kits).toMatchObject({ value: '2,500,000 KITS' })
    expect(last?.value).toMatch(/Nov 2/)
    expect(last?.sub).toBe('Tx 7Hb1qX…3Np')
  })

  it('a burned amount stays unknown without $KITS’ decimals, and a missing USD value is said, not zeroed', () => {
    const facts: BuybackFacts = { ...NOTHING_READ, boughtBackYocto: NEAR.toString(), burnedRaw: '1000' }
    const [bought, burned, kits] = buybackReadouts(buybackTracker(KITS, facts), null)
    expect(bought).toMatchObject({ value: '1 NEAR', sub: 'USD value unknown' })
    expect(burned?.value).toBe('—')
    expect(kits?.value).toBe('—')
  })
})
