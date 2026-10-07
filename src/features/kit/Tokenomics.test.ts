import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { KIT_POOL_FEE_NOTE, KIT_TAX_NOTE } from '@/config/kit'
import { buybackTracker } from './buyback'
import { BuybackPanel, HolderRewardsPanel, KitTokenomics } from './Tokenomics'

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
  const text = read(renderToStaticMarkup(createElement(BuybackPanel, { tracker: buybackTracker(KITS, null), kitDecimals: 18 })))

  it('follows kits.nearlytrade.near, and until a source reads its buybacks and burns it is an empty state: four "—", awaiting data, and the confirmed 50%', () => {
    expect(text).toMatch(/Buyback & Burn kits\.nearlytrade\.near/)
    expect(text).toMatch(/Awaiting data/)
    expect(text).toContain('Not tracked yet: NEARKITS doesn’t read the buybacks and burns of kits.nearlytrade.near from the chain yet, so no figure is shown.')
    expect(text).toMatch(/Total bought back —.*Total burned —.*\$KITS burned —.*Last buyback —/)
    expect(text).toMatch(/50% → Buyback & Burn/)
  })

  it('makes up no activity: the only figures are the 50% allocation', () => {
    expect(text.replace(/50%/g, '')).not.toMatch(/\d/)
    expect(text).not.toMatch(/Tracking|after launch/)
  })

  it('on a network without $KITS (testnet) it says so, and still prints no figure', () => {
    const off = read(renderToStaticMarkup(createElement(BuybackPanel, { tracker: buybackTracker(null, null), kitDecimals: null })))
    expect(off).toMatch(/Mainnet only/)
    expect(off).toContain('$KITS trades on NEAR mainnet: this build doesn’t follow its buybacks and burns.')
    expect(off.replace(/50%/g, '')).not.toMatch(/\d/)
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
