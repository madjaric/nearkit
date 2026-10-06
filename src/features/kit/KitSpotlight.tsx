import { ArrowRight } from 'lucide-react'
import { Link } from 'react-router'
import { LogoMark } from '@/components/brand/Brand'
import { Button } from '@/components/ui/Button'
import { buttonClass } from '@/components/ui/buttonClass'
import { Tag } from '@/components/ui/Indicators'
import { Pct, Price } from '@/components/ui/Num'
import { Panel } from '@/components/ui/Panel'
import { isKitToken, KIT } from '@/config/kit'
import { useTokens } from '@/services/queries'
import { useTradeDrawer } from '@/state/contexts'

/**
 * $KIT on the Dashboard: one slim band. Before launch it says where $KIT launches and links its
 * page (nothing trades it); once live it shows the price and opens a trade on it.
 */
export function KitSpotlight() {
  const { data: tokens = [] } = useTokens()
  const { openTrade } = useTradeDrawer()
  const listed = tokens.find((t) => isKitToken(t.id) && t.status === 'listed')
  const live = KIT.tradable && listed !== undefined
  return (
    <Panel aria-labelledby="kit-spotlight-title" className="flex flex-wrap items-center gap-x-4 gap-y-2.5 px-4 py-3">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <LogoMark size={28} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="kit-spotlight-title" className="num text-sm font-semibold tracking-[0.02em] text-fg">
              {KIT.ticker}
            </h2>
            {live ? <Tag tone="accent">Live</Tag> : <Tag tone="soon">Coming soon</Tag>}
            {live && listed?.market && (
              <span className="flex items-baseline gap-2 text-sm">
                <Price value={listed.market.priceUsd} className="text-fg" />
                <Pct value={listed.market.change24hPct} className="text-xs" />
              </span>
            )}
          </div>
          <p className="text-xs text-fg-3">
            {live ? `${KIT.name}: trade it like any NEAR token.` : `${KIT.name}: launches on ${KIT.launchVenue}. Its contract and price are published at launch.`}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {live && listed ? (
          <>
            <Link to={KIT.links.page} className={buttonClass({ variant: 'ghost', size: 'sm' })}>
              About {KIT.ticker}
            </Link>
            <Button variant="primary" size="sm" onClick={() => openTrade({ tokenId: listed.id, side: 'buy' })}>
              Trade {KIT.ticker}
            </Button>
          </>
        ) : (
          <Link to={KIT.links.page} className={buttonClass({ variant: 'secondary', size: 'sm' })}>
            About {KIT.ticker} <ArrowRight size={13} aria-hidden="true" />
          </Link>
        )}
      </div>
    </Panel>
  )
}
