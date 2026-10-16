import { describe, expect, it } from 'vitest'
import { openTestDatabase } from '../db/testing'
import { silentLogger } from '../log'
import type { TokenAction } from './accounting'
import { ALERTS_PER_WINDOW, createDiscoveryAlerts } from './alerts'
import { DiscoveryStore } from './store'

/** Followed wallets' alerts: once per wallet and transaction, to followers with alerts on, capped per user. */

const NET = { id: 'mainnet', explorerUrl: 'https://nearblocks.io' }
const act = (o: Partial<TokenAction>): TokenAction => ({ trader: 'whale.near', token: 'x.nearlytrade.near', side: 'buy', qty: 1, usd: 1234.5, ts: 1, tx: 'TX1', id: 1, ...o })

async function setup() {
  let now = 1_000_000
  const store = new DiscoveryStore(await openTestDatabase('sqlite'), () => now)
  const sent: { userId: number; html: string }[] = []
  const alerts = createDiscoveryAlerts({
    store,
    network: NET,
    webUrl: 'https://nearkits.com',
    notify: async (userId, html) => void sent.push({ userId, html }),
    log: silentLogger,
    now: () => now,
  })
  return { store, sent, alerts, tick: (ms: number) => void (now += ms) }
}

describe('followed-wallet alerts', () => {
  it('one message per wallet and transaction, to followers with alerts on, with the transaction and the wallet', async () => {
    const { store, sent, alerts } = await setup()
    await store.follow(1, 'mainnet', 'whale.near', true)
    await store.follow(2, 'mainnet', 'whale.near', false)
    await alerts([act({ side: 'sell', token: 'a.near', usd: 10 }), act({ side: 'buy', token: 'x.nearlytrade.near' }), act({ trader: 'nobody.near', tx: 'TX9' })])
    expect(sent.map((s) => s.userId)).toEqual([1])
    expect(sent[0]?.html).toContain('<b>whale.near</b> sold <b>a.near</b> for $10.00 and bought <b>x.nearlytrade.near</b> for $1,235')
    expect(sent[0]?.html).toContain('href="https://nearblocks.io/txns/TX1"')
    expect(sent[0]?.html).toContain('href="https://nearkits.com/top-wallets/whale.near"')
  })

  it(`at most ${ALERTS_PER_WINDOW} per user in ten minutes`, async () => {
    const { store, sent, alerts, tick } = await setup()
    await store.follow(1, 'mainnet', 'whale.near', true)
    await alerts(Array.from({ length: ALERTS_PER_WINDOW + 5 }, (_, i) => act({ tx: `T${i}` })))
    expect(sent).toHaveLength(ALERTS_PER_WINDOW)
    tick(11 * 60_000)
    await alerts([act({ tx: 'later' })])
    expect(sent).toHaveLength(ALERTS_PER_WINDOW + 1)
  })
})
