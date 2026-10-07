import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { KIT_POOL_FEE_NOTE, KIT_TAX_NOTE } from '@/config/kit'
import { buybackTracker } from './buyback'
import { BuybackPanel, HolderRewardsPanel, KitTokenomics } from './Tokenomics'

/** The $KIT page's tokenomics, as a visitor reads them: the panels rendered to HTML, read as text. */

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

describe('$KIT tokenomics on the $KIT page', () => {
  const html = renderToStaticMarkup(createElement(KitTokenomics))
  const text = read(html)

  it('names the token and prints its launch configuration: a 2% buy and sell tax split 50/50, a 1% pool fee with 70% to NEARKITS', () => {
    expect(text).toMatch(/\$KIT NEAR KITS/)
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

describe('the Buyback & Burn tracker before launch', () => {
  const text = read(renderToStaticMarkup(createElement(BuybackPanel, { tracker: buybackTracker('coming-soon', null), kitDecimals: null })))

  it('is an empty state: its four readouts print "—", it says tracking begins after launch, and it shows the confirmed 50% allocation', () => {
    expect(text).toMatch(/Buyback & Burn/)
    expect(text).toMatch(/Awaiting launch/)
    expect(text).toContain('Tracking begins after launch.')
    expect(text).toMatch(/Total bought back —.*Total burned —.*\$KIT burned —.*Last buyback —/)
    expect(text).toMatch(/50% → Buyback & Burn/)
  })

  it('makes up no activity: the only figures are the 50% allocation', () => {
    expect(text.replace(/50%/g, '')).not.toMatch(/\d/)
    expect(text).not.toMatch(/Tracking(?! begins)/)
  })

  it('says when $KIT is live but nothing reads its buybacks yet, and still prints no figure', () => {
    const live = read(renderToStaticMarkup(createElement(BuybackPanel, { tracker: buybackTracker('live', null), kitDecimals: 18 })))
    expect(live).toMatch(/Awaiting data/)
    expect(live).not.toContain('Tracking begins after launch.')
    expect(live.replace(/50%/g, '')).not.toMatch(/\d/)
  })
})

describe('holder rewards', () => {
  const text = read(renderToStaticMarkup(createElement(HolderRewardsPanel)))

  it('show the confirmed 50% of the tax for holders, marked Coming soon, with nothing earned, claimable or promised', () => {
    expect(text).toMatch(/Holder rewards/i)
    expect(text).toMatch(/Coming soon/i)
    expect(text).toMatch(/50%.*of the tax/)
    expect(text).toContain('Holder reward tracking will be available after launch.')
    expect(text.replace(/50%/g, '')).not.toMatch(/\d/)
    expect(text).not.toMatch(/APR|APY|yield|claim now|earned:/i)
  })
})
