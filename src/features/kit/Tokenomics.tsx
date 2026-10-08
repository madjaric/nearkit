import type { ReactNode } from 'react'
import { Figures } from '@/components/ui/Figures'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { KIT, KIT_LAUNCH, KIT_POOL_FEE_NOTE, KIT_TAX_NOTE } from '@/config/kit'
import { cn } from '@/lib/cn'

/**
 * $KITS' tokenomics on its page, from its launch configuration (KIT_LAUNCH), as one compact spec band:
 * the trading tax, where the tax goes, and apart from both the pool fee with NEARKITS' share. Rules are
 * printed as rules; nothing here is a market figure. The burns and the holder payouts themselves are
 * the live sections' (BurnTracker, HolderRewards).
 */

const pct = (n: number) => `${n}%`
const { tax, taxSplit, poolFee } = KIT_LAUNCH

/** One part of the band: its legend, its figures, one line under them. */
function Part({ name, legend, aside, note, className, children }: { name: string; legend: string; aside?: ReactNode; note: string; className?: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={legend} data-group={name} className={cn('flex min-w-0 flex-col gap-2.5 px-4 py-3.5', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="legend">{legend}</span> {aside}
      </div>
      {children}
      <p className="text-[11px] leading-4 text-fg-3">
        <Figures>{note}</Figures>
      </p>
    </div>
  )
}

/** A figure and what it is, set as a pair: the figure large, its name small under it. */
function Rate({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col">
      <p className="num text-2xl leading-7 text-fg">{value}</p>
      <p className="text-[11px] uppercase tracking-[0.08em] text-fg-3">{label}</p>
    </div>
  )
}

export function KitTokenomics() {
  return (
    <Panel aria-labelledby="kit-tokenomics">
      <PanelHeader id="kit-tokenomics" title={`${KIT.ticker} tokenomics`} meta={`Launch configuration on ${KIT.launchVenue}`} />
      <div className="grid grid-cols-1 divide-y divide-line-soft md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.5fr)_minmax(0,0.9fr)] md:divide-x md:divide-y-0">
        <Part name="trading-tax" legend="Trading tax" note={KIT_TAX_NOTE}>
          <div className="flex gap-8">
            <Rate value={pct(tax.buyPct)} label="Buy" />
            <Rate value={pct(tax.sellPct)} label="Sell" />
          </div>
        </Part>
        <Part
          name="tax-distribution"
          legend="Tax distribution"
          aside={
            <span className="shrink-0 text-[11px] text-fg-3">
              Creator <span className="num text-fg-2">{pct(taxSplit.creatorPct)}</span>
            </span>
          }
          note="Of the tax, as the launch configures it."
        >
          <div
            role="img"
            aria-label={`Buyback & Burn ${pct(taxSplit.buybackBurnPct)} of the tax, holders ${pct(taxSplit.holdersPct)}, creator ${pct(taxSplit.creatorPct)}`}
            className="flex h-1.5 gap-0.5 overflow-hidden rounded-xs"
          >
            <span className="h-full basis-0 bg-accent" style={{ flexGrow: taxSplit.buybackBurnPct }} />
            <span className="h-full basis-0 bg-accent/40" style={{ flexGrow: taxSplit.holdersPct }} />
          </div>
          <div className="flex justify-between gap-4">
            <span className="flex items-baseline gap-2">
              <span className="num text-xl leading-6 text-fg">{pct(taxSplit.buybackBurnPct)}</span> <span className="text-xs text-fg-2">Buyback & Burn</span>
            </span>
            <span className="flex items-baseline gap-2">
              <span className="text-xs text-fg-2">Holders</span> <span className="num text-xl leading-6 text-fg">{pct(taxSplit.holdersPct)}</span>
            </span>
          </div>
        </Part>
        <Part name="pool-fee" legend="Pool fee" aside={<span className="text-[11px] text-fg-3">separate from the tax</span>} note={KIT_POOL_FEE_NOTE}>
          <div className="flex gap-8">
            <Rate value={pct(poolFee.pct)} label="Pool fee" />
            <Rate value={pct(poolFee.nearkitsSharePct)} label="NEARKITS share" />
          </div>
        </Part>
      </div>
    </Panel>
  )
}
