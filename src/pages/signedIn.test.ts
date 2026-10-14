import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement as h, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { beforeAll, describe, expect, it } from 'vitest'
import { Toaster } from '@/components/ui/Toaster'
import { TopBar } from '@/layouts/TopBar'
import DashboardPage from '@/pages/DashboardPage'
import PnlPage from '@/pages/PnlPage'
import PositionsPage from '@/pages/PositionsPage'
import WalletsPage from '@/pages/WalletsPage'
import { createMockServices } from '@/services/mock'
import { createNearKitWeb, type NearKitWebSession } from '@/services/nearkitWeb'
import { qk } from '@/services/queries'
import { memoryStorage } from '@/services/real/stores'
import { ServicesProvider } from '@/services/ServicesProvider'
import type { Capabilities, NearKitServices } from '@/services/types'
import { ConnectProvider } from '@/state/ConnectProvider'
import { SettingsProvider } from '@/state/SettingsProvider'
import { TradeDrawerProvider } from '@/state/TradeDrawerProvider'
import type { PortfolioSummary, Session, TokenListing } from '@/types/domain'

/**
 * Who the pages take for signed in, and what they show when a read fails, rendered as the app
 * renders them (mainnet, real services' capabilities). Most real activity comes from users with
 * only a NEARKITS web session (signed in from the bot's /web link, no browser wallet): their
 * Dashboard, Positions and PnL are theirs, not a "connect a wallet" wall. A NEARKITS session that
 * ended says so. A read that failed says so too: never $0, "No positions" or a skeleton forever.
 */

const API = 'https://api.nearkits.test'
const TOKEN = 'T'.repeat(43)
const WEB: NearKitWebSession = { token: TOKEN, expiresAt: Date.now() + 3_600_000, userName: 'Tess', userHandle: 'tess' }
const WALLET: Session = { accountId: 'alice.near', walletId: 'alice.near', connectedAt: 1, mode: 'near', walletName: 'Meteor Wallet', accounts: ['alice.near'] }

const CAPS: Capabilities = {
  mode: 'near',
  network: 'mainnet',
  networkLabel: 'Mainnet',
  explorerUrl: 'https://nearblocks.io',
  rpcUrls: [],
  prices: true,
  pnl: true,
  automation: 'drafts',
  execution: { enabled: true, simulated: false, reason: null, trading: { enabled: true, reason: null, router: 'aggregator', feeCharged: true, feeRecipient: 'fees.near' } },
  kitContract: null,
  configIssues: [],
}

const summary = (o: Partial<PortfolioSummary> = {}): PortfolioSummary => ({
  valueUsd: 15,
  pnl24hUsd: null,
  pnl24hPct: null,
  unrealizedPnlUsd: null,
  availableNear: 3,
  availableNearUsd: 15,
  mainNear: 0,
  activePositions: 0,
  openOrders: 0,
  walletCount: 2,
  executableWalletCount: 2,
  unavailableWalletCount: 0,
  updatedAt: Date.now(),
  ...o,
})

let tokens: TokenListing[]
beforeAll(async () => {
  tokens = await createMockServices().tokens.listTokens()
})

type Web = 'signed-in' | 'ended' | null

/** The NEARKITS web client as the page has it: signed in, a session that ended (expired), or none. Nothing reaches a server. */
function nearkitWeb(web: Web) {
  const store = memoryStorage()
  if (web === 'signed-in') store.set('nearkit:web-session:mainnet', JSON.stringify(WEB))
  if (web === 'ended') store.set('nearkit:web-session:mainnet', JSON.stringify({ ...WEB, expiresAt: Date.now() - 1 }))
  return createNearKitWeb({ apiUrl: API, network: 'mainnet', store, fetchImpl: (async () => Promise.reject(new Error('no network in tests'))) as typeof fetch })
}

interface Setup {
  wallet?: Session | null
  web?: Web
  /** Query data the page finds already read. */
  data?: [readonly unknown[], unknown][]
  /** Queries whose last read failed (with this message). */
  failed?: [readonly unknown[], string][]
}

/** Renders `el` at `path` inside the app's providers, with what was already read (or failed to be). */
async function render(el: ReactNode, path: string, o: Setup = {}): Promise<string> {
  const base = createMockServices()
  const services: NearKitServices = { ...base, mode: 'near', capabilities: CAPS, nearkit: nearkitWeb(o.web ?? null) }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } } })
  qc.setQueryData(qk.session, o.wallet ?? null)
  qc.setQueryData(qk.tokens, tokens)
  qc.setQueryData(qk.wallets, [])
  qc.setQueryData(qk.presets, [])
  qc.setQueryData(qk.orders, [])
  for (const [key, value] of o.data ?? []) qc.setQueryData(key, value)
  for (const [key, message] of o.failed ?? []) await qc.prefetchQuery({ queryKey: key, queryFn: () => Promise.reject(new Error(message)) })
  const router = createMemoryRouter([{ path: '*', element: el }], { initialEntries: [path] })
  return renderToStaticMarkup(
    h(
      ServicesProvider,
      { services, children: null },
      h(QueryClientProvider, { client: qc }, h(SettingsProvider, null, h(Toaster, null, h(ConnectProvider, null, h(TradeDrawerProvider, null, h(RouterProvider, { router })))))),
    ),
  )
}

const read = (html: string) =>
  html
    .replace(/<\/?span[^>]*>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, '’')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => read(m[1] as string))

const RENDERS = { timeout: 30_000 }
const topBar = h(TopBar, { onOpenNav: () => undefined })

describe('signed in with only a NEARKITS web session (no browser wallet)', RENDERS, () => {
  it('Positions: the page itself, not the connect wall', async () => {
    const text = read(await render(h(PositionsPage), '/positions', { web: 'signed-in', data: [[qk.positions, []]] }))
    expect(text).not.toMatch(/Connect a wallet/)
    expect(text).toContain('No positions yet')
  })

  it('PnL: the page itself, not the connect wall', async () => {
    const text = read(await render(h(PnlPage), '/pnl', { web: 'signed-in' }))
    expect(text).not.toMatch(/Connect a wallet/)
    expect(text).toContain('Cumulative realized PnL')
  })

  it('Dashboard: the NEARKITS wallets’ portfolio; no “Connect a wallet”, no “No wallet connected”', async () => {
    const text = read(
      await render(h(DashboardPage), '/', {
        web: 'signed-in',
        data: [
          [qk.summary, summary()],
          [qk.positions, []],
        ],
      }),
    )
    expect(text).toContain('$15.00')
    expect(text).toContain('across 2 executable wallets')
    expect(text).toContain('Your trading terminal on NEAR.')
    expect(text).not.toMatch(/Connect a wallet|No wallet connected/)
  })

  it('the top bar names who is signed in, where “Connect wallet” was', async () => {
    const html = await render(topBar, '/', { web: 'signed-in', data: [[qk.summary, summary()]] })
    expect(read(html)).toContain('@tess')
    expect(html).toMatch(/aria-label="NEARKITS web: signed in as Tess \(@tess\)"/)
    expect(html).not.toContain('aria-label="Connect wallet"')
  })

  it('a browser wallet too: the top bar keeps the wallet’s own chip, as before', async () => {
    const html = await render(topBar, '/', { wallet: WALLET, web: 'signed-in', data: [[qk.summary, summary()]] })
    expect(read(html)).toContain('alice.near')
    expect(html).not.toContain('aria-label="Connect wallet"')
  })
})

describe('a NEARKITS web session that ended', RENDERS, () => {
  it('Positions and PnL say it ended and how to sign in again: /web to the bot', async () => {
    for (const [page, path] of [
      [PositionsPage, '/positions'],
      [PnlPage, '/pnl'],
    ] as const) {
      const html = await render(h(page), path, { web: 'ended', data: [[qk.positions, []]] })
      const text = read(html)
      expect(text).toContain('Your NEARKITS web session ended')
      expect(text).toContain('send /web')
      expect(text).not.toMatch(/No positions yet|Cumulative realized PnL/)
      expect(buttons(html)).toEqual(expect.arrayContaining(['Connect wallet', 'Dismiss']))
    }
  })

  it('the Dashboard shows no $0: its figures say the session ended', async () => {
    const text = read(await render(h(DashboardPage), '/', { web: 'ended', data: [[qk.summary, summary({ valueUsd: 0, executableWalletCount: 0, walletCount: 0 })]] }))
    // (Quick Trade's token prices are dollar figures too: the readouts are what is checked.)
    expect(text).not.toMatch(/Portfolio value \$0\.00|Available NEAR 0\.00/)
    expect(text).toContain('Portfolio value — NEARKITS session ended')
    expect(text).toContain('Available NEAR — NEARKITS session ended')
    expect(text).toContain('Your NEARKITS web session ended')
  })
})

describe('nobody signed in', RENDERS, () => {
  it('Positions and PnL ask to connect a wallet or sign in with Telegram', async () => {
    expect(read(await render(h(PositionsPage), '/positions'))).toContain('Connect a wallet or sign in with Telegram to use Positions')
    expect(read(await render(h(PnlPage), '/pnl'))).toContain('Connect a wallet or sign in with Telegram to use PnL')
  })

  it('the Dashboard and the top bar offer Connect wallet', async () => {
    const text = read(await render(h(DashboardPage), '/', { data: [[qk.summary, summary({ valueUsd: 0, executableWalletCount: 0, walletCount: 0 })]] }))
    expect(text).toContain('No wallet connected')
    expect(await render(topBar, '/')).toContain('aria-label="Connect wallet"')
  })
})

describe('a read that failed is said so: never $0, “No positions” or a skeleton forever', RENDERS, () => {
  it('Dashboard: a failed summary is not $0.00, and can be read again', async () => {
    const html = await render(h(DashboardPage), '/', { web: 'signed-in', failed: [[qk.summary, 'The NEARKITS server can’t be reached right now.']], data: [[qk.positions, []]] })
    const text = read(html)
    expect(text).not.toMatch(/Portfolio value \$0\.00|Available NEAR 0\.00/)
    expect(text).toContain('Portfolio value — Portfolio can’t be loaded · Try again')
    expect(text).toContain('Available NEAR — unavailable')
    expect(buttons(html)).toContain('Try again')
  })

  it('Dashboard: failed positions are not “No tokens yet”', async () => {
    const text = read(await render(h(DashboardPage), '/', { web: 'signed-in', data: [[qk.summary, summary()]], failed: [[qk.positions, 'RPC down']] }))
    expect(text).toContain('Assets can’t be loaded right now')
    expect(text).not.toContain('No tokens yet')
    expect(text).toContain('RPC down')
  })

  it('Dashboard: a portfolio read with a wallet it couldn’t read says it is partial', async () => {
    const text = read(
      await render(h(DashboardPage), '/', {
        web: 'signed-in',
        data: [
          [qk.summary, summary({ unavailableWalletCount: 1 })],
          [qk.positions, []],
        ],
      }),
    )
    expect(text).toContain('partial: 1 wallet unavailable')
  })

  it('Positions: a failed read is an error with Try again, not “No positions yet” or a count of 0', async () => {
    const html = await render(h(PositionsPage), '/positions', { web: 'signed-in', failed: [[qk.positions, 'The NEAR network isn’t answering.']] })
    const text = read(html)
    expect(text).toContain('Positions can’t be loaded right now')
    expect(text).toContain('The NEAR network isn’t answering.')
    expect(text).not.toContain('No positions yet')
    expect(text).not.toMatch(/Positions 0 /)
    expect(buttons(html)).toContain('Try again')
  })

  it('PnL: a failed read is an error with Try again, not a skeleton forever', async () => {
    const html = await render(h(PnlPage), '/pnl', { web: 'signed-in', failed: [[qk.pnl('90d'), 'History can’t be read.']] })
    const text = read(html)
    expect(text).toContain('PnL can’t be loaded right now')
    expect(text).toContain('History can’t be read.')
    expect(buttons(html)).toContain('Try again')
  })

  it('PnL: no wallet to report on is said, not a skeleton forever', async () => {
    const text = read(await render(h(PnlPage), '/pnl', { web: 'signed-in', data: [[qk.pnl('90d'), null]] }))
    expect(text).toContain('No wallet to report on yet')
  })

  it('Wallets: failed balances are an error, not “No wallet connected”', async () => {
    const html = await render(h(WalletsPage), '/wallets', {
      web: 'signed-in',
      data: [[qk.nearkitWallets(TOKEN), { wallets: [], limit: 10, canCreate: true }]],
      failed: [[qk.snapshots, 'The NEAR network isn’t answering.']],
    })
    const text = read(html)
    expect(text).toContain('Wallet balances can’t be loaded right now')
    expect(text).not.toContain('No wallet connected')
    expect(buttons(html)).toContain('Try again')
  })
})
