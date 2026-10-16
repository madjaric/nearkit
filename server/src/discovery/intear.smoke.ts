import { describe, expect, it } from 'vitest'
import { NETWORKS } from '@/config/networks'
import { openTestDatabase } from '../db/testing'
import { silentLogger } from '../log'
import { createDiscoveryIndexer } from './indexer'
import { createIntear } from './intear'
import { createDiscoveryService } from './service'
import { DiscoveryStore } from './store'

/**
 * Launch Radar and Top Wallets against the live Intear API (read-only; `npm run smoke:live`): the
 * indexer reads the real launch list and a few real pages of swaps from a recent start into a scratch
 * database, and the read side answers from it. Checks invariants, not exact figures (they move).
 */

const NET = NETWORKS.mainnet

describe('discovery against the live Intear API', () => {
  it('indexes real launches and swaps; the answers hold their invariants', async () => {
    const store = new DiscoveryStore(await openTestDatabase('sqlite'))
    const intear = createIntear({ baseUrl: 'https://api.intea.rs', fetch, spacingMs: 400 })
    const indexer = createDiscoveryIndexer({
      store,
      intear,
      network: NET,
      // Contracts are not looked up here (no RPC in this smoke): every parent counts as having one.
      hasContract: async () => true,
      lease: { hold: async () => true, release: async () => undefined },
      log: silentLogger,
      startAt: Date.now() - 2 * 3_600_000,
    })
    let swaps = 0
    for (let i = 0; i < 6; i++) swaps += await indexer.step()
    expect(swaps).toBeGreaterThan(0)

    const service = createDiscoveryService({ store, intear, indexer, network: NET, log: silentLogger })
    const radar = await service.launches('7d')
    expect(radar.launches.length).toBeGreaterThan(10)
    for (const l of radar.launches) {
      expect(l.createdAt).not.toBeNull()
      expect(l.createdAt as number).toBeGreaterThanOrEqual(Date.now() - 7 * 86_400_000 - 3_600_000)
      if (l.liquidityUsd !== null) expect(l.liquidityUsd).toBeGreaterThanOrEqual(0)
    }
    expect(radar.sources.some((s) => s.name === 'Nearly')).toBe(true)

    const wallets = await service.wallets({ window: '7d', metric: 'activity', category: 'all', limit: 20 })
    expect(wallets.rows.length).toBeGreaterThan(0)
    for (const w of wallets.rows) {
      expect(w.buyUsd + w.sellUsd).toBeGreaterThan(0)
      expect(w.unmatchedUsd).toBeLessThanOrEqual(w.sellUsd + 1e-6)
      if (w.coverage !== null) expect(w.coverage).toBeGreaterThanOrEqual(0)
    }

    const busiest = wallets.rows[0]?.trader as string
    const detail = await service.wallet(busiest)
    expect(detail?.trader).toBe(busiest)
    expect(detail?.trades.length).toBeGreaterThan(0)
    const withMarket = radar.launches.find((l) => (l.liquidityUsd ?? 0) > 1_000)
    if (withMarket) {
      const d = await service.launch(withMarket.token)
      expect(d?.launch.token).toBe(withMarket.token)
      expect(d?.holders?.total ?? 0).toBeGreaterThan(0)
    }
  }, 180_000)
})
