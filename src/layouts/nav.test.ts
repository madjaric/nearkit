import { ArrowDownToLine, Route } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { ALL_NAV, isNavAction, NAV_ALL_TOOLS, NAV_GROUPS, NAV_HOME } from './nav'
import { directoryGroups, entryKey, filterDirectory } from './toolDirectory'

const labels = (group: string) => (NAV_GROUPS.find((g) => g.label === group)?.items ?? []).map((i) => i.label)

describe('the sidebar’s groups', () => {
  it('Main, Trade, Tools, Automation, Portfolio, Intelligence and Other, in that order', () => {
    expect(NAV_HOME.label).toBe('Dashboard')
    expect(NAV_GROUPS.map((g) => g.label)).toEqual(['Main', 'Trade', 'Tools', 'Automation', 'Portfolio', 'Intelligence', 'Other'])
    // MAIN: the Dashboard and $KITS (drawn by the sidebar itself), then the two bridges.
    expect(labels('Main')).toEqual(['Bridge', 'Bridge & Buy'])
    expect(labels('Trade')).toEqual(['Swap', 'Quick Trade', 'Multi Trade', 'Limit Orders'])
    expect(labels('Tools')).toEqual(['Split', 'Consolidate', 'Batch Send', 'Wallets & Presets'])
    expect(labels('Automation')).toEqual(['Volume Bot', 'DCA', 'Copy Trade', 'Sniper'])
    expect(labels('Portfolio')).toEqual(['Positions', 'PnL'])
    expect(labels('Intelligence')).toEqual(['Scanner'])
    // Recover needs NEARKITS' server: the demo build (the tests') has none.
    expect(labels('Other')).toEqual(['Settings', 'Documentation', 'Telegram'])
  })

  it('the bridges in MAIN are the same entries as before: one each, same address, icon, description and SOON rule', () => {
    const main = NAV_GROUPS.find((g) => g.label === 'Main')?.items ?? []
    const bridge = main.find((i) => i.label === 'Bridge')
    const buy = main.find((i) => i.label === 'Bridge & Buy')
    expect(bridge && !isNavAction(bridge) && bridge.to).toBe('/bridge-near')
    expect(buy && !isNavAction(buy) && buy.to).toBe('/bridge')
    expect(bridge?.icon).toBe(ArrowDownToLine)
    expect(buy?.icon).toBe(Route)
    expect(bridge?.description).toBe('Move assets from other chains into NEAR.')
    expect(buy?.description).toBe('Bridge your assets and automatically buy $KITS.')
    const all = NAV_GROUPS.flatMap((g) => g.items).map((i) => i.label)
    expect(all.filter((l) => l === 'Bridge' || l === 'Bridge & Buy')).toEqual(['Bridge', 'Bridge & Buy'])
  })

  it('every page is listed once, each with one plain line of what it does', () => {
    const pages = ALL_NAV.map((i) => i.to)
    expect(new Set(pages).size).toBe(pages.length)
    expect(pages).toEqual(expect.arrayContaining(['/', '/swap', '/multi-trade', '/limit-orders', '/volume-bot/console', '/bridge-near', '/bridge', '/tools']))
    for (const entry of [...ALL_NAV, ...NAV_GROUPS.flatMap((g) => g.items)]) {
      expect(entry.description.length, entry.label).toBeGreaterThan(10)
      expect(entry.description.length, entry.label).toBeLessThanOrEqual(110)
    }
    expect(NAV_ALL_TOOLS.to).toBe('/tools')
  })
})

describe('the All Tools directory', () => {
  const groups = directoryGroups(NAV_GROUPS)
  const found = (query: string, group: string | null = null) => filterDirectory(groups, query, group).flatMap((g) => g.items.map((i) => i.label))

  it('lists every tool in the sidebar’s groups, in the same order; the bridges under Main; still 20 tools', () => {
    expect(groups.map((g) => g.slug)).toEqual(['main', 'trade', 'tools', 'automation', 'portfolio', 'intelligence', 'other'])
    expect(found('')).toEqual(NAV_GROUPS.flatMap((g) => g.items.map((i) => i.label)))
    expect(found('', 'main')).toEqual(['Bridge', 'Bridge & Buy'])
    expect(found('', 'other')).toEqual(['Settings', 'Documentation', 'Telegram'])
    // The demo build (the tests') has no Recover: 20 tools, as before the bridges moved.
    expect(found('')).toHaveLength(20)
  })

  it('finds a tool by its name, by what it does, by a keyword, and a whole group by its name', () => {
    expect(found('sniper')).toEqual(['Sniper'])
    expect(found('stop loss')).toEqual(['Limit Orders'])
    expect(found('recurring')).toEqual(['DCA'])
    expect(found('Automation')).toEqual(['Volume Bot', 'DCA', 'Copy Trade', 'Sniper'])
    expect(found('bridge')).toEqual(['Bridge', 'Bridge & Buy'])
    // A Telegram-style command reads as its word.
    expect(found('/dca')).toEqual(['DCA'])
    expect(found('zzz nothing')).toEqual([])
  })

  it('a picked group shows only that group; a search narrows it further', () => {
    expect(found('', 'portfolio')).toEqual(['Positions', 'PnL'])
    expect(found('loss', 'portfolio')).toEqual(['PnL'])
    expect(found('swap', 'automation')).toEqual(['Copy Trade'])
    expect(filterDirectory(groups, '', 'nope')).toEqual([])
  })

  it('Quick Trade is an action, not a page, and keys apart from every page', () => {
    const quick = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.label === 'Quick Trade')
    expect(quick && isNavAction(quick)).toBe(true)
    const keys = NAV_GROUPS.flatMap((g) => g.items).map(entryKey)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
