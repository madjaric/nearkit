import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { KIT_POOL_FEE_NOTE, KIT_TAX_NOTE } from '@/config/kit'
import type { KitsBurnView } from '@/services/kitsBurns'
import { BurnTracker } from './BurnTracker'
import type { BurnTrackerState } from './buyback'
import { HolderRewardsPanel, KitTokenomics } from './Tokenomics'

/** The $KITS page's tokenomics, as a visitor reads them: the panels rendered to HTML, read as text. */

// Inline spans (a figure set in mono inside a sentence) join their text; every other tag is a break.
const read = (html: string) =>
  html
    .replace(/<\/?span[^>]*>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, '’')
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

  it('names the token, Near Kits at kits.nearlytrade.near, and prints its launch configuration: a 2% buy and sell tax split 50/50, a 1% pool fee with 70% to NEARKITS', () => {
    expect(text).toMatch(/\$KITS tokenomics \$KITS Near Kits kits\.nearlytrade\.near/)
    for (const figure of [/Buy tax 2%/, /Sell tax 2%/, /Buyback & Burn 50%/, /Holders 50%/, /Pool fee 1%/, /NEARKITS share 70%/]) expect(text).toMatch(figure)
    expect(text).toContain(KIT_TAX_NOTE)
    expect(text).toContain(KIT_POOL_FEE_NOTE)
  })

  it('keeps the trading tax and the pool fee apart: the 70% and the pool fee only in their own group, the tax and its split only in theirs', () => {
    const tax = group(html, 'trading-tax')
    const split = group(html, 'tax-distribution')
    const pool = group(html, 'pool-fee')
    expect(tax).toMatch(/Trading tax/)
    expect(tax).toContain(KIT_TAX_NOTE)
    expect(split).toMatch(/Buyback & Burn 50%.*Holders 50%/)
    expect(pool).toMatch(/Pool fee 1%.*NEARKITS share 70%/)
    expect(pool).toContain(KIT_POOL_FEE_NOTE)
    for (const part of [tax, split]) expect(part).not.toMatch(/70%|pool fee/i)
    expect(pool).not.toMatch(/Buyback|Holders|tax revenue/i)
  })

  it('claims no return, rate, burn amount or market figure', () => {
    expect(text).not.toMatch(/APR|APY|yield|guarantee|\$\d/i)
  })
})

describe('the Buyback & Burn tracker', () => {
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
    burns: [{ tx: '8SzmYJDy4fnKkrZmuYPYkBtzPBZYrFt9frofsWVDjcg6', at: 1791418038627, amount: '78155059288019410500855', kind: 'tax' }],
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

  it('says when a refresh failed, when the list isn’t the whole history and when some KITS were burned outside the tax', () => {
    const text = read(html({ state: 'live', view: { ...VIEW, historyComplete: false, burnedByTax: '3000000000000000000000000' }, refreshFailed: true }))
    expect(text).toMatch(/The last refresh didn’t come back: these figures are from .* ago\./)
    expect(text).toContain('The list holds the burns verified so far; the total is the chain’s own.')
    expect(text).toContain('233,515.61 KITS of the total were burned outside the tax.')
  })

  it('without a reading keeps its shape, shows no figure, and says why', () => {
    const cases: [BurnTrackerState, RegExp][] = [
      [{ state: 'unavailable' }, /Awaiting data.*can’t read \$KITS’ burns from NEAR right now/],
      [{ state: 'no-source', reason: 'demo' }, /This preview reads nothing from NEAR\. On nearkits\.com/],
      [{ state: 'no-source', reason: 'no-server' }, /isn’t connected to NEARKITS’ server/],
      [{ state: 'not-on-network' }, /Mainnet only.*trades on NEAR mainnet: its burns are tracked there/],
    ]
    for (const [tracker, why] of cases) {
      const text = read(html(tracker))
      expect(text).toMatch(why)
      expect(text).toMatch(/Total burned — KITS/)
      expect(text.replace(/kits\.nearlytrade\.near/g, '')).not.toMatch(/\d/)
    }
  })
})

describe('holder rewards', () => {
  const text = read(renderToStaticMarkup(createElement(HolderRewardsPanel)))

  it('show the confirmed 50% of the tax for holders, marked Coming soon, with nothing earned, claimable or promised', () => {
    expect(text).toMatch(/Holder rewards/i)
    expect(text).toMatch(/Coming soon/i)
    expect(text).toMatch(/50%.*of the tax/)
    expect(text).toContain('Holder reward tracking is coming soon.')
    expect(text.replace(/50%/g, '')).not.toMatch(/\d/)
    expect(text).not.toMatch(/APR|APY|yield|claim now|earned:/i)
  })
})
