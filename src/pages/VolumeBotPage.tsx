import { ArrowRight, ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { LogoMark, Wordmark } from '@/components/brand/Brand'
import { buttonClass } from '@/components/ui/buttonClass'
import { Figures } from '@/components/ui/Figures'
import { FAQ, LINKS, PIPELINE, SPECS, TWAP_RANGE, VOLUME_BOT_CONSOLE_PATH, VOLUME_BOT_PATH, VOLUME_BOT_TITLE, VOLUME_BOT_UPDATED } from '@/features/volumeBot/content'
import { NEARKIT_FEE_LABEL, RHEA_APP_FEE_SHARE_LABEL } from '@/lib/fees'
import { usePageTitle, useRouteMeta } from '@/lib/hooks'
import { MAX_BOT_WALLETS, MIN_EDGE_BPS, MIN_INTERVAL_SEC } from '@/lib/volumeBot/config'

/**
 * The Volume Bot's public page: what it is, how it decides, what limits it, and how to start one.
 * It stands outside the app's shell and uses no wallet or service, so the build prerenders it
 * as static HTML (src/prerender.tsx) that reads the same before and after the app loads.
 */

const SECTIONS = [
  { id: 'what', title: 'What a NEAR trading bot is' },
  { id: 'market-making', title: 'Market making on NEAR' },
  { id: 'how', title: 'How it works' },
  { id: 'strategies', title: 'Strategies' },
  { id: 'wallets', title: 'Multi-wallet trading' },
  { id: 'data', title: 'Market data' },
  { id: 'risk', title: 'Risk management' },
  { id: 'inventory', title: 'Inventory' },
  { id: 'execution', title: 'Execution' },
  { id: 'analytics', title: 'Analytics' },
  { id: 'near', title: 'Built for the NEAR ecosystem' },
  { id: 'start', title: 'Getting started' },
  { id: 'faq', title: 'Questions' },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

const NAV = [
  { to: '/swap', label: 'Swap' },
  { to: '/multi-trade', label: 'Multi Trade' },
  { to: '/docs', label: 'Docs' },
  { to: '/telegram', label: 'Telegram' },
]

function Section({ id, children }: { id: SectionId; children: ReactNode }) {
  const title = SECTIONS.find((s) => s.id === id)?.title ?? ''
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20 border-t border-line-soft pt-8">
      <h2 id={`${id}-title`} className="flex items-center gap-2 text-lg font-semibold text-fg" style={{ fontStretch: '106%' }}>
        <ChevronRight size={16} strokeWidth={2.25} aria-hidden="true" className="shrink-0 text-fg-4" />
        {title}
      </h2>
      <div className="mt-4 flex flex-col gap-4 text-base leading-7 text-fg-2">{children}</div>
    </section>
  )
}

function Points({ items }: { items: ReactNode[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3">
          <span aria-hidden="true" className="mt-3 size-1.5 shrink-0 bg-fg-4" />
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ul>
  )
}

const F = ({ children }: { children: string }) => <Figures>{children}</Figures>

/** A reference outside NEARKITS, opened in a new tab. */
function Ref({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg">
      {children}
    </a>
  )
}

const UPDATED = new Date(`${VOLUME_BOT_UPDATED}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

export default function VolumeBotPage() {
  usePageTitle('Volume Bot')
  useRouteMeta(VOLUME_BOT_PATH)
  return (
    <div className="min-h-dvh bg-canvas text-fg">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:rounded-sm focus:bg-panel focus:px-3 focus:py-2">
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-line bg-canvas/95 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 lg:px-6">
          <Link to="/" className="flex items-center gap-2.5" aria-label="NEARKITS home">
            <LogoMark size={22} />
            <Wordmark />
          </Link>
          <nav aria-label="NEARKITS" className="hidden items-center gap-1 md:flex">
            {NAV.map((n) => (
              <Link key={n.to} to={n.to} className="rounded-sm px-3 py-2 text-sm text-fg-2 transition-colors hover:text-fg">
                {n.label}
              </Link>
            ))}
          </nav>
          <Link to={VOLUME_BOT_CONSOLE_PATH} className={buttonClass({ variant: 'primary', size: 'sm' })}>
            Open console
          </Link>
        </div>
      </header>

      <main id="main">
        <div className="mx-auto max-w-6xl px-4 lg:px-6">
          <nav aria-label="Breadcrumb" className="pt-6 text-xs text-fg-3">
            <ol className="flex items-center gap-1.5">
              <li>
                <Link to="/" className="hover:text-fg">
                  NEARKITS
                </Link>
              </li>
              <li aria-hidden="true">/</li>
              <li aria-current="page" className="text-fg-2">
                Volume Bot
              </li>
            </ol>
          </nav>

          <div className="grid grid-cols-1 gap-10 pb-10 pt-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:items-end">
            <div className="min-w-0">
              <p className="legend">Automation · NEAR</p>
              <h1 className="mt-3 text-[length:clamp(1.75rem,5vw,2.75rem)] font-bold leading-[1.12] tracking-[-0.01em] text-fg" style={{ fontStretch: '108%' }}>
                {VOLUME_BOT_TITLE}
              </h1>
              <p className="mt-5 max-w-[62ch] text-lg leading-8 text-fg-2">
                <F>
                  {`A trading bot that runs on NEARKITS’s server and trades from your NEARKITS wallets: a market maker that buys below fair value and sells above it only with an edge of at least ${(MIN_EDGE_BPS / 100).toFixed(2)}% after every fee, or TWAP accumulate and distribute over ${TWAP_RANGE}. Every trade takes the same route, checks and fee as one you make by hand.`}
                </F>
              </p>
              <div className="mt-7 flex flex-wrap gap-3">
                <Link to={VOLUME_BOT_CONSOLE_PATH} className={buttonClass({ variant: 'primary', size: 'lg' })}>
                  Open the console <ArrowRight size={16} aria-hidden="true" />
                </Link>
                <a href="#how" className={buttonClass({ variant: 'secondary', size: 'lg' })}>
                  How it works
                </a>
              </div>
              <p className="mt-6 text-xs text-fg-3">
                Updated <time dateTime={VOLUME_BOT_UPDATED}>{UPDATED}</time>
              </p>
            </div>
            <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line-soft">
              {SPECS.map((s) => (
                <div key={s.label} className="flex flex-col gap-1 bg-panel px-4 py-4">
                  <dt className="text-xs font-medium text-fg-3">{s.label}</dt>
                  <dd className="text-2xl text-fg">
                    <Figures>{s.value}</Figures>
                  </dd>
                  <dd className="text-xs text-fg-3">{s.note}</dd>
                </div>
              ))}
            </dl>
          </div>

          <section aria-labelledby="pipeline-title" className="pb-12">
            <h2 id="pipeline-title" className="legend">
              Each step, every time
            </h2>
            <ol className="mt-3 grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-line bg-line-soft sm:grid-cols-2 lg:grid-cols-4">
              {PIPELINE.map((p, i) => (
                <li key={p.name} className="flex flex-col gap-1.5 bg-panel px-4 py-4">
                  <span className="flex items-center gap-2">
                    <span className="num text-xs text-accent">{String(i + 1).padStart(2, '0')}</span>
                    <span className="text-sm font-semibold text-fg">{p.name}</span>
                  </span>
                  <span className="text-sm leading-6 text-fg-3">{p.text}</span>
                </li>
              ))}
            </ol>
          </section>

          <div className="grid grid-cols-1 gap-10 pb-16 lg:grid-cols-[13rem_minmax(0,1fr)]">
            <nav aria-label="On this page" className="hidden lg:block">
              <ol className="sticky top-20 flex flex-col gap-0.5 border-l border-line-soft">
                {SECTIONS.map((s) => (
                  <li key={s.id}>
                    <a href={`#${s.id}`} className="-ml-px block border-l border-transparent px-3 py-1.5 text-sm text-fg-3 transition-colors hover:border-fg-3 hover:text-fg">
                      {s.title}
                    </a>
                  </li>
                ))}
              </ol>
            </nav>

            <article className="flex min-w-0 max-w-[72ch] flex-col gap-10">
              <Section id="what">
                <p>
                  A trading bot watches a market and places trades by rules you set, so you don’t have to sit at the screen. The NEARKITS Volume Bot is one for NEAR: you choose a
                  token, a strategy, the wallets it may use and every limit, and it trades that token against NEAR through <Ref href={LINKS.rhea}>Rhea</Ref>, the main exchange on
                  NEAR.
                </p>
                <p>
                  It is not a separate wallet or a script you run. It runs on NEARKITS’s server and trades from your NEARKITS wallets through the same path as a trade you confirm
                  by hand: the same quotes, the same checks and the same fee. It can’t trade from a watch-only account or a wallet you connect in the browser.
                </p>
              </Section>

              <Section id="market-making">
                <p>
                  A market maker buys when a price is low against its estimate of fair value and sells when it is high. Rhea’s pools have no order book, so the bot doesn’t post
                  orders: it trades against the pool only when the pool’s executable price, after every fee and the trade’s own price impact, is away from fair value by more than
                  your edge.
                </p>
                <p>
                  <F>{`Fair value is a time-weighted average of the price over a window you choose. The edge is yours to set, from ${(MIN_EDGE_BPS / 100).toFixed(2)}% up: the bot never trades without one. Inside that band it waits and says so.`}</F>
                </p>
                <p>
                  Inventory skew keeps it near the mix you want: holding more of the token than your target, it asks a smaller edge to sell and a larger one to buy, and the other
                  way round.
                </p>
              </Section>

              <Section id="how">
                <p>
                  <F>{`On each check, at a moment drawn between your shortest and longest interval (never closer than ${MIN_INTERVAL_SEC} s), the bot:`}</F>
                </p>
                <ol className="flex flex-col gap-2">
                  {[
                    'Reads the market: a small buy and the sell back, quoted through the route a real trade would take, and the pool’s liquidity.',
                    'Updates fair value and lets the guardian check the market, its wallets and its own health.',
                    'Asks the strategy what to do: trade, or wait with a reason you can read on the console.',
                    'Quotes the exact trade and accepts it only if the quote is fresh and within your slippage, price impact and price limits.',
                    'Executes it from one wallet, confirms it on chain and records the fill in that wallet’s books.',
                  ].map((step, i) => (
                    <li key={i} className="flex gap-3">
                      <span className="num w-6 shrink-0 pt-px text-sm text-fg-3">{i + 1}.</span>
                      <span className="min-w-0">{step}</span>
                    </li>
                  ))}
                </ol>
              </Section>

              <Section id="strategies">
                <Points
                  items={[
                    <>
                      <strong className="font-semibold text-fg">Market maker.</strong> Buys below fair value and sells above it with your edge, leaning toward your target
                      inventory.
                    </>,
                    <>
                      <strong className="font-semibold text-fg">Accumulate (TWAP).</strong>{' '}
                      <F>{`Buys a NEAR budget in slices spread over ${TWAP_RANGE}, never above your price cap.`}</F>
                    </>,
                    <>
                      <strong className="font-semibold text-fg">Distribute (TWAP).</strong> Sells a token amount in slices over the period you set, never below your price floor.
                    </>,
                  ]}
                />
                <p>Trade size is fixed, drawn from a range, a share of the wallet or a share of the inventory, and can be capped at a share of the pool’s liquidity.</p>
              </Section>

              <Section id="wallets">
                <p>
                  <F>{`A bot trades from up to ${MAX_BOT_WALLETS} of your NEARKITS wallets. Each trade comes from the one wallet best able to make it: the most NEAR for a buy, the most tokens for a sell. Wallets are not rotated to look like different traders.`}</F>
                </p>
                <p>
                  One wallet has one trade in flight at a time, so trades never trip over each other, and you choose how many may run at once. Each of your tokens has at most one
                  live bot, so two of your bots never trade it against each other.
                </p>
              </Section>

              <Section id="data">
                <p>
                  Prices come from Rhea quotes for the route a trade would take: what a small buy costs and what selling it back returns, after every fee. That spread is the real
                  cost of crossing, and the bot waits while it is above your limit. Pool liquidity and NEAR’s dollar price come from public market data.
                </p>
                <p>When a source fails or its data grows older than your limit, the bot doesn’t guess: the guardian pauses it and says which.</p>
              </Section>

              <Section id="risk">
                <p>You set every limit; none is fixed by NEARKITS:</p>
                <Points
                  items={[
                    'Largest trade, daily loss limit (UTC day) and drawdown from the peak.',
                    'Slippage, price impact and spread limits on every quote.',
                    'A pool liquidity floor, and NEAR kept in every wallet for gas.',
                    'Exposure caps: how much of one wallet, and of all of them, may sit in the token.',
                  ]}
                />
                <p>
                  The guardian pauses the bot with the exact reason on an abnormal price move, a liquidity collapse, stale market data or quotes, a degraded RPC, a failing data
                  source, a balance that changed outside its trades, a timed-out transaction, slippage or impact beyond limits, the loss or drawdown limit, or too many failures in
                  a row. It stays paused until you look and resume it.
                </p>
              </Section>

              <Section id="inventory">
                <p>
                  You give the market maker a target share of its value to hold in the token, a band around it and the most NEAR it may have in the token at once. Each wallet keeps
                  its own books: what it bought, at what average cost, what it sold, and its realized and unrealized result.
                </p>
              </Section>

              <Section id="execution">
                <p>
                  <F>{`Trades run through NEARKITS custody like any other: Rhea’s route with the ${NEARKIT_FEE_LABEL} NEARKITS fee inside it (Rhea’s aggregator keeps ${RHEA_APP_FEE_SHARE_LABEL} of it), your slippage limit, and a confirmation read from chain. A buy counts when its tokens arrive; a sell when NEAR is back.`}</F>
                </p>
                <p>If NEARKITS’s server restarts mid-trade, the bot settles that trade from its record when it comes back. It is never sent a second time.</p>
              </Section>

              <Section id="analytics">
                <p>
                  The console shows what the bot really did: executed volume, trades and their success rate, fees and gas, PnL, exposure and every wallet’s figures, with charts of
                  price, PnL, volume and exposure over the run and a log of each start, pause and guardian decision. A planned, skipped or failed trade is never counted as volume.
                </p>
              </Section>

              <Section id="near">
                <p>
                  <Ref href={LINKS.near}>NEAR</Ref> accounts, <Ref href={LINKS.nep141}>NEP-141</Ref> tokens and Rhea’s pools are what the bot works with, and NEAR’s low fees make
                  frequent small trades practical. Everything else on NEARKITS works with the same wallets:{' '}
                  <Link to="/swap" className="text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg">
                    Swap
                  </Link>
                  ,{' '}
                  <Link to="/multi-trade" className="text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg">
                    Multi Trade
                  </Link>{' '}
                  across many wallets at once,{' '}
                  <Link to="/split" className="text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg">
                    Split
                  </Link>{' '}
                  and{' '}
                  <Link to="/consolidate" className="text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg">
                    Consolidate
                  </Link>{' '}
                  to move tokens between them, and the{' '}
                  <Link to="/scanner" className="text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg">
                    Scanner
                  </Link>{' '}
                  to look at a token before you trade it.
                </p>
              </Section>

              <Section id="start">
                <ol className="flex flex-col gap-2">
                  {[
                    <>
                      Sign in to NEARKITS web from Telegram: send <span className="num text-fg">/web</span> to the NEARKITS bot (see{' '}
                      <Link to="/telegram" className="text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg">
                        Telegram
                      </Link>
                      ).
                    </>,
                    'Create NEARKITS wallets and fund them with the NEAR, or the tokens, the bot will trade.',
                    'Open the console, choose the token, strategy, wallets and limits, and save. Nothing trades yet.',
                    <>
                      Start it. NEARKITS confirms in Telegram, and <span className="num text-fg">/volume</span> shows its status there, with Pause, Resume and Stop.
                    </>,
                  ].map((step, i) => (
                    <li key={i} className="flex gap-3">
                      <span className="num w-6 shrink-0 pt-px text-sm text-fg-3">{i + 1}.</span>
                      <span className="min-w-0">{step}</span>
                    </li>
                  ))}
                </ol>
                <div className="flex flex-wrap gap-3 pt-2">
                  <Link to={VOLUME_BOT_CONSOLE_PATH} className={buttonClass({ variant: 'primary' })}>
                    Open the console
                  </Link>
                  <Link to="/docs" className={buttonClass({ variant: 'ghost' })}>
                    Read the docs
                  </Link>
                </div>
              </Section>

              <Section id="faq">
                <dl className="flex flex-col divide-y divide-line-soft rounded-lg border border-line bg-panel">
                  {FAQ.map((f) => (
                    <div key={f.q} className="px-4 py-4">
                      <dt className="text-base font-semibold text-fg">{f.q}</dt>
                      <dd className="mt-2 text-sm leading-6 text-fg-2">
                        <F>{f.a}</F>
                      </dd>
                    </div>
                  ))}
                </dl>
              </Section>
            </article>
          </div>
        </div>
      </main>

      <footer className="border-t border-line bg-well">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-sm text-fg-3 sm:flex-row sm:items-center sm:justify-between lg:px-6">
          <span className="flex items-center gap-2">
            <LogoMark size={18} />
            NEARKITS · the trading toolkit for NEAR
          </span>
          <nav aria-label="More from NEARKITS" className="flex flex-wrap gap-x-5 gap-y-2">
            <Link to="/" className="hover:text-fg">
              Dashboard
            </Link>
            <Link to="/swap" className="hover:text-fg">
              Swap
            </Link>
            <Link to="/kit" className="hover:text-fg">
              $KIT
            </Link>
            <Link to="/docs" className="hover:text-fg">
              Docs
            </Link>
            <Link to="/telegram" className="hover:text-fg">
              Telegram
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  )
}
