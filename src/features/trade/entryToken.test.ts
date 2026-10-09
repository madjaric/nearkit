import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement as h, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { Toaster } from '@/components/ui/Toaster'
import { KITS_CONTRACT } from '@/config/kit'
import { MultiTrade } from '@/features/multi/MultiTrade'
import { BotSetup } from '@/features/volumeBot/BotSetup'
import { defaultBotConfig } from '@/lib/volumeBot/config'
import type { BotSummary } from '@/lib/volumeBot/api'
import SwapPage from '@/pages/SwapPage'
import { createMockServices } from '@/services/mock'
import { ServicesProvider } from '@/services/ServicesProvider'
import type { NearKitServices } from '@/services/types'
import { ConnectProvider } from '@/state/ConnectProvider'
import { SettingsProvider } from '@/state/SettingsProvider'
import { TradeDrawerProvider } from '@/state/TradeDrawerProvider'
import type { TokenListing } from '@/types/domain'

/**
 * The token Swap, Multi Trade and the Volume Bot open on when entered from the navigation: $KITS
 * (kits.nearlytrade.near), the NEARKITS token, while it is listed, exactly as Quick Trade does; never
 * the network's older default (Black Dragon). Rendered as the app renders them, with the demo's
 * services, whose token ids are mainnet's. The token is checked by its contract (what the quote, the
 * chart and the order are built for), not only by its label. A token chosen on purpose (a link's
 * `?token=`, a saved bot's own token) is still the one shown; Black Dragon stays a token like any other.
 */

// Rendered as the mainnet build is (where $KITS is kits.nearlytrade.near), before any module reads its configuration.
vi.hoisted(() => vi.stubEnv('VITE_NEAR_NETWORK', 'mainnet'))

const BLACKDRAGON = 'blackdragon.tkn.near'

let services: NearKitServices
let tokens: TokenListing[]

beforeAll(async () => {
  services = createMockServices()
  tokens = await services.tokens.listTokens()
})

/** Renders `el` at `path` inside the app's providers, with the token list and the wallets already loaded. */
async function render(el: ReactNode, path: string, list: TokenListing[] = tokens): Promise<string> {
  const qc = new QueryClient()
  qc.setQueryData(['tokens'], list)
  qc.setQueryData(['wallets'], await services.wallets.listWallets())
  qc.setQueryData(['session'], await services.wallets.getSession())
  const router = createMemoryRouter([{ path: '*', element: el }], { initialEntries: [path] })
  return renderToStaticMarkup(
    h(
      ServicesProvider,
      { services, children: null },
      h(QueryClientProvider, { client: qc }, h(SettingsProvider, null, h(Toaster, null, h(ConnectProvider, null, h(TradeDrawerProvider, null, h(RouterProvider, { router })))))),
    ),
  )
}

const tokenLabels = (html: string) => (html.match(/aria-label="(?:From token|To token|Token): [^"]*"/g) ?? []).map((m) => m.slice('aria-label="'.length, -1))
const multi = (initialTokenId: string | null = null) => h(MultiTrade, { initialSide: 'buy', initialPresetId: null, initialTokenId })

// Each test renders whole pages (a few hundred ms each, more on a busy machine).
const RENDERS = { timeout: 30_000 }

describe('entered from the navigation, the trade tools open on $KITS', RENDERS, () => {
  it('the demo lists $KITS and Black Dragon by their mainnet contracts (what the tests below rely on)', () => {
    expect(tokens.find((t) => t.id === KITS_CONTRACT)).toMatchObject({ symbol: 'KITS', name: 'Near Kits', status: 'listed' })
    expect(tokens.find((t) => t.id === BLACKDRAGON)).toMatchObject({ symbol: 'BLACKDRAGON', status: 'listed' })
  })

  it('Swap: NEAR → $KITS, its contract shown with the pair', async () => {
    const html = await render(h(SwapPage), '/swap')
    expect(tokenLabels(html)).toEqual(['From token: NEAR', 'To token: KITS'])
    expect(html).toContain(`title="${KITS_CONTRACT}"`)
    expect(html).not.toContain('BLACKDRAGON')
  })

  it('Multi Trade: the order’s token is $KITS', async () => {
    const html = await render(multi(), '/multi-trade')
    expect(tokenLabels(html)).toEqual(['Token: KITS'])
    expect(html).not.toContain('Token: BLACKDRAGON')
  })

  it('Volume Bot: a new bot’s token is $KITS', async () => {
    const html = await render(h(BotSetup, { onSaved: () => undefined }), '/volume-bot/console')
    expect(tokenLabels(html)).toEqual(['Token: KITS'])
    expect(html).not.toContain('Token: BLACKDRAGON')
  })

  it('where $KITS isn’t listed (not live, or testnet), each falls back to the network’s default as before', async () => {
    const withoutKits = tokens.filter((t) => t.id !== KITS_CONTRACT)
    expect(tokenLabels(await render(h(SwapPage), '/swap', withoutKits))).toEqual(['From token: NEAR', 'To token: BLACKDRAGON'])
    expect(tokenLabels(await render(multi(), '/multi-trade', withoutKits))).toEqual(['Token: BLACKDRAGON'])
    expect(tokenLabels(await render(h(BotSetup, { onSaved: () => undefined }), '/volume-bot/console', withoutKits))).toEqual(['Token: BLACKDRAGON'])
  })
})

describe('a token chosen on purpose is still the one shown, Black Dragon included', RENDERS, () => {
  it('Swap and Multi Trade opened for a token (a link’s ?token=) open on that token', async () => {
    expect(tokenLabels(await render(h(SwapPage), `/swap?token=${BLACKDRAGON}`))).toEqual(['From token: NEAR', 'To token: BLACKDRAGON'])
    expect(tokenLabels(await render(h(SwapPage), `/swap?side=sell&token=${BLACKDRAGON}`))).toEqual(['From token: BLACKDRAGON', 'To token: NEAR'])
    expect(tokenLabels(await render(multi(BLACKDRAGON), `/multi-trade?token=${BLACKDRAGON}`))).toEqual(['Token: BLACKDRAGON'])
  })

  it('a saved Volume Bot keeps its own token', async () => {
    const config = defaultBotConfig('market-maker', { id: BLACKDRAGON, symbol: 'BLACKDRAGON', decimals: 24 }, [])
    const bot = { id: 'bot-1', token: BLACKDRAGON, symbol: 'BLACKDRAGON' } as BotSummary
    const html = await render(h(BotSetup, { editing: { bot, config }, onSaved: () => undefined }), '/volume-bot/console')
    expect(tokenLabels(html)).toEqual(['Token: BLACKDRAGON'])
  })
})
