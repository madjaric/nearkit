import { Page } from '@/components/page/Page'
import { ComingSoon } from '@/components/ui/Indicators'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { isKitToken, KIT } from '@/config/kit'
import { BurnTracker } from '@/features/kit/BurnTracker'
import { burnFigures } from '@/features/kit/buyback'
import { HolderRewards } from '@/features/kit/HolderRewards'
import { KitActions, KitHero } from '@/features/kit/KitHero'
import { KitMarket } from '@/features/kit/KitMarket'
import { useHolderRewards } from '@/features/kit/rewards'
import { KitTokenomics } from '@/features/kit/Tokenomics'
import { useBurnTracker } from '@/features/kit/useBurnTracker'
import { useNearPrice, usePriceHistory, useTokenMarket, useTokens } from '@/services/queries'
import { useTradeDrawer } from '@/state/contexts'

const UTILITY = [
  { title: 'Fee benefits', text: `Reduced NEARKITS fees for ${KIT.ticker} holders. Terms are published before they apply.` },
  { title: 'Advanced tools', text: 'Advanced multi-wallet and intelligence tools for holders.' },
  { title: 'Higher limits', text: 'Larger wallet groups, batch sizes and rule counts.' },
  { title: 'Premium automation', text: 'Extended Volume Bot, DCA, copy trading and sniper options.' },
]

/**
 * $KITS' page, from its one configuration (src/config/kit.ts): Near Kits at kits.nearlytrade.near, live
 * on NEAR mainnet. Read top to bottom it says: this is a live token; buy it; bridge into it; here is
 * what the tax does, the real Buyback & Burn, the real holder rewards; here is its market; and here
 * is the utility to come. The live sections read NEAR mainnet through NEARKITS' server; the market
 * comes from the sources the token screen uses. On a network without $KITS (testnet) it is
 * mainnet-only: nothing trades it and no market figure is shown.
 *
 * Wide screens (xl) lay the market out as its own column beside the header and the two ways in;
 * narrower ones stack every section in the order above. The header and the two ways in lay
 * themselves out by their own width (container queries), not the window's.
 */
export default function KitPage() {
  const { data: tokens = [], isPending } = useTokens()
  const { openTrade } = useTradeDrawer()
  const burns = useBurnTracker()
  const rewards = useHolderRewards()
  const listed = tokens.find((t) => isKitToken(t.id) && t.status === 'listed')
  // On this build's network (mainnet, the demo); live to trade once the list has it.
  const onNetwork = KIT.status === 'live'
  const live = KIT.tradable && listed !== undefined
  const marketId = onNetwork ? (listed?.id ?? KIT.contract) : null
  const market = useTokenMarket(marketId)
  const history = usePriceHistory(marketId, '1W')
  const { data: nearQuote } = useNearPrice()
  const priceUsd = live && listed?.market ? listed.market.priceUsd : null
  const burnView = burns.state === 'live' ? burns.view : null

  const buyReason = !onNetwork
    ? `${KIT.ticker} trades on NEAR mainnet, not in this build.`
    : live
      ? null
      : isPending
        ? `Reading ${KIT.ticker} from NEAR…`
        : `NEARKITS can’t read ${KIT.ticker} from NEAR right now. Try again shortly.`

  return (
    <Page>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <KitHero onNetwork={onNetwork} price={market.data?.priceUsd} change={market.data?.change24hPct} className="pb-2 pt-1 xl:col-start-1 xl:row-start-1" />
        <KitActions
          onNetwork={onNetwork}
          canBuy={live}
          buyReason={buyReason}
          onBuy={() => listed && openTrade({ tokenId: listed.id, side: 'buy' })}
          className="xl:col-start-1 xl:row-start-2"
        />

        {/* The analytics centrepiece: burns as NEARKITS' server reads them from NEAR mainnet, valued at today's price only where one is known. */}
        <BurnTracker tracker={burns} priceUsd={priceUsd} className="xl:col-span-2" />

        <div className="flex min-w-0 flex-col gap-4 xl:col-span-2">
          <KitTokenomics />
          <HolderRewards state={rewards} nearUsd={nearQuote?.priceUsd ?? null} />
        </div>

        <KitMarket
          onNetwork={onNetwork}
          market={market.data}
          history={history.data}
          supplyNow={burnView ? burnFigures(burnView, null).supply : null}
          className="xl:col-start-2 xl:row-span-2 xl:row-start-1"
        />

        <section aria-labelledby="kit-utility" className="xl:col-span-2">
          <Panel>
            <PanelHeader id="kit-utility" title="Planned utility" actions={<ComingSoon />} />
            <ul className="grid grid-cols-1 divide-y divide-line-soft sm:grid-cols-2 sm:divide-y-0 xl:grid-cols-4">
              {UTILITY.map((u, i) => (
                <li
                  key={u.title}
                  className={
                    'flex flex-col gap-1 px-4 py-3.5 sm:border-line-soft ' +
                    (i % 2 === 1 ? 'sm:border-l ' : '') +
                    (i >= 2 ? 'sm:border-t xl:border-t-0 ' : '') +
                    (i >= 1 ? 'xl:border-l' : '')
                  }
                >
                  <span className="text-sm font-medium text-fg-2">{u.title}</span>
                  <span className="text-xs leading-5 text-fg-3">{u.text}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </section>
      </div>
    </Page>
  )
}
