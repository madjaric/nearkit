import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { KIT_POOL_FEE_NOTE, KIT_TAX_NOTE } from '@/config/kit'
import type { KitsBurnView } from '@/services/kitsBurns'
import type { KitsRewardsView } from '@/services/kitsRewards'
import { BurnTracker } from './BurnTracker'
import type { BurnTrackerState } from './buyback'
import { HolderRewards } from './HolderRewards'
import type { RewardsState } from './rewards'
import { KitTokenomics } from './Tokenomics'

/** The $KITS page's sections, as a visitor reads them: rendered to HTML, read as text. */

// Inline spans (a figure set in mono inside a sentence) join their text; every other tag is a break.
const read = (html: string) =>
  html
    .replace(/<\/?span[^>]*>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, '’')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()

/** The text of one labelled group of the panel (`data-group`), up to the next group. */
const group = (html: string, name: string) => {
  const at = html.indexOf(`data-group="${name}"`)
  if (at < 0) throw new Error(`no group ${name}`)
  const next = html.indexOf('data-group="', at + 1)
  // From the group's own opening tag to the next group's, whole tags only.
  return read(html.slice(html.lastIndexOf('<', at), next < 0 ? undefined : html.lastIndexOf('<', next)))
}

const KITS = 'kits.nearlytrade.near'

describe('$KITS tokenomics on the $KITS page', () => {
  const html = renderToStaticMarkup(createElement(KitTokenomics))
  const text = read(html)

  it('prints its launch configuration in one compact band: a 2% buy and sell tax split 50/50, a 1% pool fee with 70% to NEARKITS', () => {
    expect(text).toMatch(/\$KITS tokenomics Launch configuration on Nearly/)
    for (const figure of [/2% Buy 2% Sell/, /50% Buyback & Burn/, /Holders 50%/, /1% Pool fee/, /70% NEARKITS share/, /Creator 0%/]) expect(text).toMatch(figure)
    expect(text).toContain(KIT_TAX_NOTE)
    expect(text).toContain(KIT_POOL_FEE_NOTE)
  })

  it('keeps the trading tax and the pool fee apart: the 70% and the pool fee only in their own group, the tax and its split only in theirs', () => {
    const tax = group(html, 'trading-tax')
    const split = group(html, 'tax-distribution')
    const pool = group(html, 'pool-fee')
    expect(tax).toMatch(/Trading tax/)
    expect(tax).toContain(KIT_TAX_NOTE)
    expect(split).toMatch(/50% Buyback & Burn.*Holders 50%/)
    expect(pool).toMatch(/separate from the tax 1% Pool fee 70% NEARKITS share/)
    expect(pool).toContain(KIT_POOL_FEE_NOTE)
    for (const part of [tax, split]) expect(part).not.toMatch(/70%|pool fee/i)
    expect(pool).not.toMatch(/Buyback|Holders|tax revenue/i)
  })

  it('claims no return, rate, burn amount or market figure', () => {
    expect(text).not.toMatch(/APR|APY|yield|guarantee|\$\d/i)
  })
})

describe('the Buyback & Burn section', () => {
  const VIEW: KitsBurnView = {
    network: 'mainnet',
    token: KITS,
    launchpad: 'nearlytrade.near',
    launchId: '2699',
    decimals: 18,
    launchSupply: '1000000000000000000000000000',
    supply: '996766484385607587716865419',
    burnedTotal: '3233515614392412283134581',
    burnedByTax: '3233515614392412283134581',
    burns: [
      { tx: '8SzmYJDy4fnKkrZmuYPYkBtzPBZYrFt9frofsWVDjcg6', at: 1791418038627, amount: '78155059288019410500855', kind: 'tax' },
      { tx: 'DNSYUXwwwynxkmjJHKqdKxEfcGyjQEgrLRhtp8qjrmji', at: 1791414898867, amount: '197224380625149214516409', kind: 'tax' },
    ],
    burnCount: 6,
    historyComplete: true,
    readAt: 1791421447361,
    historyReadAt: 1791421446913,
  }
  const html = (tracker: BurnTrackerState, priceUsd: number | null = null) => renderToStaticMarkup(createElement(BurnTracker, { tracker, priceUsd }))

  it('live: the KITS burned and their share of the launch supply, the burn transactions, the last burn and the supply now; each burn linked to its transaction', () => {
    const live = html({ state: 'live', view: VIEW, refreshFailed: false })
    const text = read(live)
    expect(text).toMatch(/Buyback & Burn kits\.nearlytrade\.near Updated .* ago Live/)
    expect(text).toMatch(/Total burned 3,233,515\.61 KITS 0\.32% of the 1,000,000,000 KITS launch supply/)
    expect(text).toMatch(/Burn transactions 6 each verified on chain/)
    expect(text).toMatch(/Last burn .* ago 78,155\.05 KITS/)
    expect(text).toMatch(/Supply now 996,766,484 KITS after burns/)
    expect(text).toMatch(/Recent burns/)
    expect(text).toContain('Tax · Buyback & Burn')
    expect(text).toContain('Confirmed')
    expect(live).toContain('href="https://nearblocks.io/txns/8SzmYJDy4fnKkrZmuYPYkBtzPBZYrFt9frofsWVDjcg6"')
    expect(text).toContain('Nearly’s launchpad (nearlytrade.near, launch 2699)')
    expect(text).not.toMatch(/today’s price/)
    expect(read(html({ state: 'live', view: VIEW, refreshFailed: false }, 0.00000886))).toContain('≈ $28.65 at today’s price')
  })

  it('draws KITS burned over time from the verified burns only: one marker per burn, linked to its transaction, oldest first', () => {
    const live = html({ state: 'live', view: VIEW, refreshFailed: false })
    expect(read(live)).toMatch(/KITS burned over time 2 verified burns/)
    expect(live).toMatch(/KITS burned over time: 2 verified burns from .* to .*, 275,379\.43 KITS in all\./)
    const markers = [...live.matchAll(/aria-label="Burn of ([\d,.]+) KITS on [^"]*, ([\d,.]+) KITS burned in all/g)].map((m) => [m[1], m[2]])
    expect(markers).toEqual([
      ['197,224.38', '197,224.38'],
      ['78,155.05', '275,379.43'],
    ])
  })

  it('says when a refresh failed, when the list isn’t the whole history and when some KITS were burned outside the tax', () => {
    const text = read(html({ state: 'live', view: { ...VIEW, historyComplete: false, burnedByTax: '3000000000000000000000000' }, refreshFailed: true }))
    expect(text).toMatch(/The last refresh didn’t come back: these figures are from .* ago\./)
    expect(text).toContain('The chart and list hold the burns verified so far; the total is the chain’s own.')
    expect(text).toContain('233,515.61 KITS of the total were burned outside the tax.')
  })

  it('without a reading keeps its shape, draws no chart, shows no figure, and says why', () => {
    const cases: [BurnTrackerState, RegExp][] = [
      [{ state: 'unavailable' }, /Awaiting data.*can’t read \$KITS’ burns from NEAR right now/],
      [{ state: 'no-source', reason: 'demo' }, /This preview reads nothing from NEAR\. On nearkits\.com/],
      [{ state: 'no-source', reason: 'no-server' }, /isn’t connected to NEARKITS’ server/],
      [{ state: 'not-on-network' }, /Mainnet only.*trades on NEAR mainnet: its burns are tracked there/],
    ]
    for (const [tracker, why] of cases) {
      const markup = html(tracker)
      const text = read(markup)
      expect(text).toMatch(why)
      expect(text).toMatch(/Total burned — KITS/)
      expect(markup).not.toContain('Burn of ')
      expect(text.replace(/kits\.nearlytrade\.near/g, '')).not.toMatch(/\d/)
    }
  })
})

describe('holder rewards, live', () => {
  const VIEW: KitsRewardsView = {
    network: 'mainnet',
    token: KITS,
    launchpad: 'nearlytrade.near',
    launchId: '2699',
    asset: 'near',
    decimals: 24,
    holdersBps: 5000,
    paid: '232526623184551179508975',
    waiting: '90769292844558304509419',
    allocated: '323295916029109484018394',
    payouts: [
      { tx: 'CUsuBcPL6iMGJK313cnZfwmMJA48UACXTZAvauu4mWFV', at: 1791471949026, amount: '214275357901757820022881', payments: 8 },
      { tx: '7eW3uDUYo3sZeFnqspYD6RvM6wXTNG8NbjHJUwZ24xXM', at: 1791437662764, amount: '18251265282793359486094', payments: 2 },
    ],
    payoutCount: 2,
    paymentCount: 10,
    historyComplete: true,
    readAt: 1791500000000,
    historyReadAt: 1791500000000,
  }
  const html = (state: RewardsState, nearUsd: number | null = null) => renderToStaticMarkup(createElement(HolderRewards, { state, nearUsd }))

  it('live: what was paid to holders, what is allocated and what waits, kept apart; the rounds and the latest one; each round linked to its transaction', () => {
    const live = html({ state: 'live', view: VIEW, refreshFailed: false })
    const text = read(live)
    expect(text).toMatch(/Holder rewards Paid in NEAR Updated .* Live/)
    expect(text).toMatch(/Paid to holders 0\.2325 NEAR all time, verified on chain/)
    expect(text).toMatch(/Allocated 0\.3232 NEAR in all: paid \+ waiting/)
    expect(text).toMatch(/Waiting 0\.0907 NEAR allocated, not paid yet/)
    expect(text).toMatch(/Payout rounds 2 10 holder payments/)
    expect(text).toMatch(/Latest payout .* ago 0\.2142 NEAR to 8 holders/)
    expect(live).toContain('href="https://nearblocks.io/txns/CUsuBcPL6iMGJK313cnZfwmMJA48UACXTZAvauu4mWFV"')
    expect(text).toContain('“paid” counts only rounds verified on chain, “waiting” is what it holds for holders and hasn’t paid')
    expect(read(html({ state: 'live', view: VIEW, refreshFailed: false }, 5.4))).toContain('≈ $1.26 at today’s NEAR price')
  })

  it('says when the payout history is still being read, and when a refresh failed', () => {
    const text = read(html({ state: 'live', view: { ...VIEW, historyComplete: false }, refreshFailed: true }))
    expect(text).toContain('Reading the payout history: 2 rounds verified so far. The paid total is the launchpad’s own.')
    expect(text).toMatch(/The last refresh didn’t come back/)
  })

  it('without a reading keeps its shape, shows no figure and says why: nothing is called earned, claimable or promised', () => {
    const cases: [RewardsState, RegExp][] = [
      [{ state: 'unavailable' }, /Awaiting data.*can’t read \$KITS holder rewards from NEAR right now/],
      [{ state: 'no-source', reason: 'demo' }, /This preview reads nothing from NEAR\. On nearkits\.com/],
      [{ state: 'not-on-network' }, /Mainnet only.*paid and tracked there/],
    ]
    for (const [state, why] of cases) {
      const text = read(html(state))
      expect(text).toMatch(why)
      expect(text).toMatch(/Paid to holders — NEAR/)
      expect(text.replace(/kits\.nearlytrade\.near/g, '')).not.toMatch(/\d/)
      expect(text).not.toMatch(/APR|APY|yield|claim now|earned:/i)
    }
  })
})
