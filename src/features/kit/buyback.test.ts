import { describe, expect, it } from 'vitest'
import { buybackReadouts, buybackTracker, type BuybackFacts } from './buyback'

/**
 * $KIT's Buyback & Burn tracker: what the chain recorded, once a source reads it. Before that it
 * prints no figure at all (never a zero that looks measured), and nothing here can make one up.
 */

const NOTHING_READ: BuybackFacts = { boughtBackYocto: null, boughtBackUsd: null, burnedRaw: null, burnedUsd: null, lastBuybackAt: null, lastBuybackTx: null }
const NEAR = 10n ** 24n

describe('the Buyback & Burn tracker', () => {
  it('tracks nothing before launch, whatever it is handed', () => {
    expect(buybackTracker('coming-soon', null)).toEqual({ state: 'awaiting-launch' })
    expect(buybackTracker('coming-soon', { ...NOTHING_READ, burnedRaw: '5' })).toEqual({ state: 'awaiting-launch' })
  })

  it('once $KIT is live it waits for an on-chain source, and tracks what that source read', () => {
    expect(buybackTracker('live', null)).toEqual({ state: 'awaiting-data' })
    expect(buybackTracker('live', NOTHING_READ)).toEqual({ state: 'tracking', facts: NOTHING_READ })
  })

  it('prints no figure it has not read: every slot is "—", with no digit anywhere, never a zero', () => {
    for (const tracker of [buybackTracker('coming-soon', null), buybackTracker('live', null), buybackTracker('live', NOTHING_READ)]) {
      const slots = buybackReadouts(tracker, 18)
      expect(slots.map((s) => s.legend)).toEqual(['Total bought back', 'Total burned', '$KIT burned', 'Last buyback'])
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
    const [bought, burned, kit, last] = buybackReadouts(buybackTracker('live', facts), 18)
    expect(bought).toMatchObject({ value: '123.4 NEAR', sub: '≈ $512.30' })
    expect(burned).toMatchObject({ value: '$498.10' })
    expect(kit).toMatchObject({ value: '2,500,000 KIT' })
    expect(last?.value).toMatch(/Nov 2/)
    expect(last?.sub).toBe('Tx 7Hb1qX…3Np')
  })

  it('a burned amount stays unknown without $KIT’s decimals, and a missing USD value is said, not zeroed', () => {
    const facts: BuybackFacts = { ...NOTHING_READ, boughtBackYocto: NEAR.toString(), burnedRaw: '1000' }
    const [bought, burned, kit] = buybackReadouts(buybackTracker('live', facts), null)
    expect(bought).toMatchObject({ value: '1 NEAR', sub: 'USD value unknown' })
    expect(burned?.value).toBe('—')
    expect(kit?.value).toBe('—')
  })
})
