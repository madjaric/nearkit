import { ExternalLink } from 'lucide-react'
import { Link } from 'react-router'
import { LogoMark } from '@/components/brand/Brand'
import { Page, PageHeader } from '@/components/page/Page'
import { Button } from '@/components/ui/Button'
import { buttonClass } from '@/components/ui/buttonClass'
import { CopyButton } from '@/components/ui/Copy'
import { ComingSoon, Led, Tag } from '@/components/ui/Indicators'
import { Price } from '@/components/ui/Num'
import { Line, Lines, Panel, PanelHeader } from '@/components/ui/Panel'
import { isKitToken, KIT } from '@/config/kit'
import { buybackTracker } from '@/features/kit/buyback'
import { BuybackPanel, HolderRewardsPanel, KitTokenomics } from '@/features/kit/Tokenomics'
import { useTokens } from '@/services/queries'
import { useTradeDrawer } from '@/state/contexts'

const UTILITY = [
  { title: 'Fee benefits', text: 'Reduced NEARKITS fees for $KIT holders. Terms are published before they apply.' },
  { title: 'Advanced tool access', text: 'Holder access to advanced multi-wallet and intelligence tools.' },
  { title: 'Higher limits', text: 'Larger wallet groups, batch sizes and rule counts.' },
  { title: 'Premium automation features', text: 'Extended Volume Bot, DCA, copy trading and sniper options.' },
]

/**
 * $KIT's page, from its one configuration (src/config/kit.ts): Coming Soon until the build names its
 * contract, then live: its contract, its price, and a trade like any token's. Nothing is shown that
 * isn't known: no price, supply or contract before launch.
 */
export default function KitPage() {
  const { data: tokens = [] } = useTokens()
  const { openTrade } = useTradeDrawer()
  const listed = tokens.find((t) => isKitToken(t.id) && t.status === 'listed')
  const live = KIT.tradable && listed !== undefined
  const pending = 'Published at launch'

  return (
    <Page>
      <PageHeader title={KIT.ticker} status={live ? <Tag tone="accent">Live</Tag> : <ComingSoon label="Not launched" />} description={`${KIT.name}, the token of NEARKITS.`} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Panel>
          <div className="flex flex-col gap-6 p-5 sm:flex-row sm:items-start sm:p-6">
            <LogoMark size={56} className="shrink-0" />
            <div className="flex min-w-0 flex-col gap-4">
              <div>
                <h2 className="text-xl font-semibold leading-7 text-fg" style={{ fontStretch: '110%' }}>
                  {KIT.name}
                </h2>
                <p className="num mt-0.5 text-md text-fg-2">{KIT.ticker}</p>
              </div>
              <p className="max-w-[60ch] text-base leading-6 text-fg-2">
                {KIT.ticker} is the token of NEARKITS, the trading toolkit for NEAR. It launches on {KIT.launchVenue}: NEARKITS is a trading toolkit, not a launchpad.
                {live ? ' It is live: trade it here like any NEAR token.' : ' Until it is live, nothing here trades it and no market figure about it is shown.'}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {live && listed ? (
                  <>
                    <Button variant="primary" size="lg" onClick={() => openTrade({ tokenId: listed.id, side: 'buy' })}>
                      Trade {KIT.ticker}
                    </Button>
                    {KIT.links.token && (
                      <Link to={KIT.links.token} className={buttonClass({ variant: 'secondary', size: 'lg' })}>
                        Market and chart
                      </Link>
                    )}
                    {KIT.links.explorer && (
                      <a href={KIT.links.explorer} target="_blank" rel="noreferrer noopener" className={buttonClass({ variant: 'ghost', size: 'lg' })}>
                        Explorer <ExternalLink size={14} aria-hidden="true" />
                      </a>
                    )}
                  </>
                ) : (
                  <>
                    <Button variant="primary" size="lg" disabled aria-describedby="kit-not-live">
                      Trade {KIT.ticker}
                    </Button>
                    <span id="kit-not-live" className="text-sm text-fg-3">
                      Trading opens when {KIT.ticker} is live.
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Token facts" />
          <div className="p-4">
            <Lines>
              <Line label="Status" mono={false}>
                <span className="flex items-center justify-end gap-2">
                  <Led tone={live ? 'on' : 'off'} /> {live ? 'Live' : 'Not launched'}
                </span>
              </Line>
              <Line label="Launch venue" mono={false}>
                {KIT.launchVenue}
              </Line>
              <Line label="Contract" mono={false}>
                {KIT.contract ? (
                  <span className="flex items-center justify-end gap-1.5">
                    <span className="num break-all text-xs">{KIT.contract}</span>
                    <CopyButton value={KIT.contract} label="Copy the $KIT contract" />
                  </span>
                ) : (
                  pending
                )}
              </Line>
              <Line label="Price" mono={false}>
                {live && listed?.market ? <Price value={listed.market.priceUsd} /> : live ? 'No market price yet' : pending}
              </Line>
            </Lines>
            <p className="mt-3 border-t border-line-soft pt-3 text-xs text-fg-3">
              {live
                ? 'Market cap, supply and liquidity are on the token’s market page, from the sources that report them.'
                : 'NEARKITS shows no $KIT price, supply or market figures before launch. The KIT position in the demo is simulated, for layout only.'}
            </p>
          </div>
        </Panel>
      </div>

      <KitTokenomics />

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* No on-chain source reads $KIT's buybacks and burns yet (no API or indexer for them): the tracker gets no facts, and says so. A source plugs in here. */}
        <BuybackPanel tracker={buybackTracker(KIT.status, null)} kitDecimals={listed?.decimals ?? null} />
        <HolderRewardsPanel />
      </div>

      <Panel>
        <PanelHeader title="Planned utility" />
        <ul className="divide-y divide-line-soft">
          {UTILITY.map((u) => (
            <li key={u.title} className="flex flex-col gap-1 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-6">
              <span className="w-56 shrink-0 text-sm font-medium text-fg">{u.title}</span>
              <span className="flex-1 text-sm text-fg-3">{u.text}</span>
              <ComingSoon />
            </li>
          ))}
        </ul>
      </Panel>
    </Page>
  )
}
