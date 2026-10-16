import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { readFileSync } from 'node:fs'
import { createElement as h, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { describe, expect, it } from 'vitest'
import { Toaster } from '@/components/ui/Toaster'
import LaunchDetailPage from '@/pages/LaunchDetailPage'
import LaunchRadarPage from '@/pages/LaunchRadarPage'
import ToolsPage from '@/pages/ToolsPage'
import TopWalletsSoonPage from '@/pages/TopWalletsSoonPage'
import { createDemoDiscovery } from '@/services/discoveryDemo'
import { createMockServices } from '@/services/mock'
import { qk } from '@/services/queries'
import { ServicesProvider } from '@/services/ServicesProvider'
import { ConnectProvider } from '@/state/ConnectProvider'
import { SettingsProvider } from '@/state/SettingsProvider'
import { TradeDrawerProvider } from '@/state/TradeDrawerProvider'
import { loadTopWallets, loadWalletDetail } from './gate'
import { dk } from './queries'

/**
 * Top Wallets is paused (config/paused.ts): its routes open the Coming Soon screen, no listing or link
 * opens its rankings, and Launch Radar shows nothing derived from them, as the app renders it.
 */

function render(Page: ComponentType, path: string, data: [readonly unknown[], unknown][] = [], pattern = '*'): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } } })
  qc.setQueryData(qk.session, null)
  for (const [key, value] of data) qc.setQueryData(key, value)
  const router = createMemoryRouter([{ path: pattern, element: h(Page) }], { initialEntries: [path] })
  return renderToStaticMarkup(
    h(
      ServicesProvider,
      { services: createMockServices(), children: null },
      h(QueryClientProvider, { client: qc }, h(SettingsProvider, null, h(Toaster, null, h(ConnectProvider, null, h(TradeDrawerProvider, null, h(RouterProvider, { router })))))),
    ),
  )
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

describe('the Top Wallets routes', () => {
  it('both open the Coming Soon screen, never the ranking or wallet pages', async () => {
    expect((await loadTopWallets()).default).toBe(TopWalletsSoonPage)
    expect((await loadWalletDetail()).default).toBe(TopWalletsSoonPage)
    const router = readFileSync(new URL('../../router.tsx', import.meta.url), 'utf8')
    expect(router).toContain("{ path: 'top-wallets', lazy: page(loadTopWallets) }")
    expect(router).toContain("{ path: 'top-wallets/:id', lazy: page(loadWalletDetail) }")
    expect(router).not.toMatch(/TopWalletsPage|WalletDetailPage/)
  })

  it('the screen says Coming soon, shows no ranking or wallet figures, and leads back to Launch Radar', () => {
    for (const path of ['/top-wallets', '/top-wallets/whale.sample.near']) {
      const html = render(TopWalletsSoonPage, path)
      const t = text(html)
      expect(t).toContain('Top Wallets')
      expect(t).toContain('Coming soon')
      expect(t).toContain('Top Wallets is coming soon')
      expect(t).not.toContain('not part of the public beta')
      expect(html).not.toContain('<table')
      expect(html).toContain('href="/launch-radar"')
    }
  })
})

describe('listings', () => {
  it('All Tools lists Top Wallets with its Coming soon badge; Launch Radar stays live', () => {
    const t = text(render(ToolsPage, '/tools'))
    expect(t).toMatch(/Top Wallets Coming soon/)
    expect(t).not.toMatch(/Launch Radar (Coming soon|Soon)/)
  })
})

describe('Launch Radar while Top Wallets is paused', () => {
  const demo = createDemoDiscovery()

  it('the list: launches as before, no Tracked column and no link into Top Wallets', async () => {
    const launches = await demo.launches('24h')
    expect(launches.launches.some((l) => l.tracked > 0)).toBe(true)
    const html = render(LaunchRadarPage, '/launch-radar', [[dk.launches('24h'), launches]])
    expect(html).toContain('aria-label="Launches"')
    expect(html).toContain(`href="/launch-radar/${encodeURIComponent(launches.launches[0]?.token ?? '')}"`)
    expect(html).not.toContain('/top-wallets')
    expect(text(html)).not.toMatch(/Tracked|tracked wallet/)
  })

  it('a launch: facts, risk and swaps as before; no tracked wallets, Smart Money or wallet PnL, and no link into Top Wallets', async () => {
    const launches = await demo.launches('7d')
    const token = launches.launches.find((l) => l.tracked > 0)?.token
    expect(token).toBeDefined()
    const detail = await demo.launch(token as string)
    expect(detail.signals.length).toBeGreaterThan(0)
    const html = render(LaunchDetailPage, `/launch-radar/${encodeURIComponent(token as string)}`, [[dk.launch(token as string), detail]], 'launch-radar/:id')
    const t = text(html)
    expect(t).toContain('Launch facts')
    expect(t).toContain('Risk evidence')
    expect(t).toContain('Latest swaps')
    expect(html).not.toContain('/top-wallets')
    expect(t).not.toMatch(/Tracked wallets|Smart Money/)
  })
})
