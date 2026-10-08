import { ArrowRight, ExternalLink } from 'lucide-react'
import { Link } from 'react-router'
import { ChainMark } from '@/components/brand/ChainMark'
import { LogoMark } from '@/components/brand/Brand'
import { TokenGlyph } from '@/components/domain/TokenGlyph'
import { Button } from '@/components/ui/Button'
import { buttonClass } from '@/components/ui/buttonClass'
import { CopyButton } from '@/components/ui/Copy'
import { Led } from '@/components/ui/Indicators'
import { Pct, Price } from '@/components/ui/Num'
import { BRIDGE_CHAINS } from '@/config/bridge'
import { KIT, KITS_CONTRACT } from '@/config/kit'
import { NATIVE_TOKEN_ID } from '@/config/networks'
import { cn } from '@/lib/cn'
import { formatAgo } from '@/lib/format'
import { useNow, usePageTitle } from '@/lib/hooks'
import type { MarketFigure } from '@/types/domain'

/**
 * The top of $KITS' page: what it is (Near Kits, $KITS, live on NEAR, its contract) and its live price,
 * then the two ways in: Buy $KITS with NEAR, and Bridge & Buy $KITS from SOL, ETH or BNB. Every
 * figure is a source's own, said where it comes from; a missing one is "—".
 */

const known = (f: MarketFigure | undefined): number | null => (f && (f.state === 'known' || f.state === 'stale') ? f.value : null)

export function KitHero({ onNetwork, price, change, className }: { onNetwork: boolean; price: MarketFigure | undefined; change: MarketFigure | undefined; className?: string }) {
  usePageTitle(KIT.ticker)
  const now = useNow(15_000)
  const usd = known(price)
  const source = price && (price.state === 'known' || price.state === 'stale') ? `${price.source} · ${formatAgo(price.at, now)}` : null
  return (
    <header className={cn('@container', className)}>
      <div className="flex flex-col gap-5 @xl:flex-row @xl:items-end @xl:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <LogoMark size={64} className="mt-1 shrink-0" />
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="num leading-none tracking-[-0.03em] text-fg" style={{ fontSize: 'clamp(2.4rem, 7vw, 3.4rem)' }}>
                {KIT.ticker}
              </h1>
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-xs border px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.1em]',
                  onNetwork ? 'border-accent/40 text-accent' : 'border-line text-fg-3',
                )}
              >
                <Led tone={onNetwork ? 'on' : 'off'} /> {onNetwork ? 'Live on NEAR' : 'Mainnet only'}
              </span>
            </div>
            <p className="text-sm font-semibold uppercase tracking-[0.14em] text-fg-2" style={{ fontStretch: '110%' }}>
              {KIT.name}
            </p>
            <p className="max-w-[52ch] text-sm text-fg-3">The token of NEARKITS, the trading toolkit for NEAR. Launched on {KIT.launchVenue}.</p>
            <p className="flex min-w-0 items-center gap-1.5 text-xs text-fg-3">
              <span className="num truncate text-fg-2">{KITS_CONTRACT}</span>
              <CopyButton value={KITS_CONTRACT} label={`Copy the ${KIT.ticker} contract`} />
            </p>
          </div>
        </div>
        {onNetwork && (
          <div className="flex shrink-0 flex-col gap-1 @xl:items-end @xl:text-right">
            <span className="legend">Price</span>
            <p className="flex items-baseline gap-3">
              {usd !== null ? <Price value={usd} className="text-3xl leading-9 text-fg" /> : <span className="num text-3xl leading-9 text-fg-4">—</span>}
              {known(change) !== null && <Pct value={known(change)} className="text-sm" />}
            </p>
            <p className="text-[11px] text-fg-3">
              {source ? `${source}${known(change) !== null ? ' · 24h' : ''}` : price?.state === 'unavailable' ? price.reason : 'Reading the market…'}
            </p>
          </div>
        )}
      </div>
    </header>
  )
}

/** One cross-chain route, as the page draws it: the source coin, NEAR, $KITS. */
function Route({ chain }: { chain: (typeof BRIDGE_CHAINS)[number] }) {
  return (
    <li className="flex items-center gap-2 text-xs text-fg-2">
      <ChainMark chain={chain.id} size={18} />
      <span className="num w-8 text-fg">{chain.symbol}</span>
      <ArrowRight size={12} className="text-fg-4" aria-hidden="true" />
      <TokenGlyph symbol="NEAR" tokenId={NATIVE_TOKEN_ID} size={18} />
      <span className="num">NEAR</span>
      <ArrowRight size={12} className="text-fg-4" aria-hidden="true" />
      <TokenGlyph symbol="KITS" tokenId={KITS_CONTRACT} size={18} />
      <span className="num text-fg">$KITS</span>
    </li>
  )
}

/**
 * The two ways in, side by side and equal: Buy $KITS with NEAR (the trade ticket), and Bridge & Buy
 * $KITS, the cross-chain way for someone holding SOL, ETH or BNB (its own page, /bridge).
 */
export function KitActions({
  onNetwork,
  canBuy,
  buyReason,
  onBuy,
  className,
}: {
  onNetwork: boolean
  canBuy: boolean
  buyReason: string | null
  onBuy: () => void
  className?: string
}) {
  return (
    <div className={cn('@container', className)}>
      <section aria-label={`Get ${KIT.ticker}`} className="grid grid-cols-1 overflow-hidden rounded-[10px] border border-line @xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
        <div className="flex flex-col justify-between gap-4 bg-panel p-4 sm:p-5">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold text-fg">Buy with NEAR</h2>
            <p className="text-sm text-fg-3">From your NEARKITS wallet or the NEAR wallet you connect, on {KIT.ticker}’ own pool.</p>
          </div>
          <div className="flex flex-col gap-2">
            <Button variant="primary" size="xl" block onClick={onBuy} disabled={!canBuy} aria-describedby={buyReason ? 'kit-buy-reason' : undefined}>
              Buy {KIT.ticker}
            </Button>
            {buyReason && (
              <p id="kit-buy-reason" className="text-xs text-fg-3">
                {buyReason}
              </p>
            )}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {KIT.links.token && onNetwork && (
                <Link to={KIT.links.token} className="text-fg-2 underline decoration-fg-4 underline-offset-2 hover:text-fg">
                  Market and chart
                </Link>
              )}
              <a
                href={KIT.links.explorer}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-fg-2 underline decoration-fg-4 underline-offset-2 hover:text-fg"
              >
                Explorer <ExternalLink size={11} aria-hidden="true" />
              </a>
            </div>
          </div>
        </div>
        <div className="@container flex flex-col gap-4 border-t border-line bg-well p-4 sm:p-5 @xl:border-l @xl:border-t-0">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h2 className="text-base font-semibold text-fg">Bridge &amp; Buy</h2>
            <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-accent">Cross-chain</span>
          </div>
          <div className="flex flex-col gap-4 @sm:flex-row @sm:items-center @sm:justify-between">
            <ul className="flex flex-col gap-2" aria-label="Routes">
              {BRIDGE_CHAINS.map((c) => (
                <Route key={c.id} chain={c} />
              ))}
            </ul>
            <p className="max-w-[30ch] text-sm text-fg-2">Have SOL, ETH or BNB? Bridge to NEAR and buy {KIT.ticker} in one flow.</p>
          </div>
          {onNetwork ? (
            <Link to="/bridge" className={buttonClass({ variant: 'outline', size: 'xl', block: true })}>
              Bridge &amp; Buy {KIT.ticker}
            </Link>
          ) : (
            <p className="text-xs text-fg-3">Bridge &amp; Buy runs on NEAR mainnet, where {KIT.ticker} trades.</p>
          )}
          <p className="text-[11px] text-fg-3">Powered by NEAR Intents. Your own wallet sends; NEARKITS never holds it.</p>
        </div>
      </section>
    </div>
  )
}
