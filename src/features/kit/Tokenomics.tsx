import type { ReactNode } from 'react'
import { Figures } from '@/components/ui/Figures'
import { ComingSoon, Led, Tag, type LedTone } from '@/components/ui/Indicators'
import { Legend, Panel, PanelHeader } from '@/components/ui/Panel'
import { ReadoutSlot, ReadoutStrip } from '@/components/ui/Readout'
import { KIT, KIT_LAUNCH, KIT_POOL_FEE_NOTE, KIT_TAX_NOTE } from '@/config/kit'
import { cn } from '@/lib/cn'
import { buybackReadouts, UNKNOWN, type BuybackTracker } from './buyback'

/**
 * $KIT's tokenomics on its page, from its launch configuration (KIT_LAUNCH): the trading tax and
 * where it goes, and apart from it the pool fee with NEARKITS' share; then the Buyback & Burn
 * tracker and holder rewards. Rules are printed as rules; nothing here is a market figure, and the
 * tracker prints only what an on-chain source has read (today: nothing).
 */

const pct = (n: number) => `${n}%`
const { tax, taxSplit, poolFee } = KIT_LAUNCH

/** A labelled part of the panel: its legend, its readouts and the sentence under them. */
function Part({ name, legend, aside, note, className, children }: { name: string; legend: string; aside?: ReactNode; note?: string; className?: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={legend} data-group={name} className={cn('flex min-w-0 flex-col', className)}>
      <Legend className="px-4 pt-3.5" action={aside}>
        {legend}
      </Legend>
      {children}
      {note && (
        <p className="px-4 pb-4 pt-1 text-sm text-fg-2">
          <Figures>{note}</Figures>
        </p>
      )}
    </div>
  )
}

/** A share's color, in the split bar and beside its readout. */
const SHARE_TONE = { buyback: 'bg-accent/80', holders: 'bg-accent/45' }

const Swatch = ({ tone }: { tone: keyof typeof SHARE_TONE }) => <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-[1px]', SHARE_TONE[tone])} />

export function KitTokenomics() {
  return (
    <Panel aria-labelledby="kit-tokenomics">
      <PanelHeader id="kit-tokenomics" title={`${KIT.ticker} tokenomics`} />
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line-soft px-4 py-3">
        <p className="flex min-w-0 items-baseline gap-2.5">
          <span className="num text-lg text-fg">{KIT.ticker}</span>{' '}
          <span className="text-sm font-semibold uppercase tracking-[0.06em] text-fg-2" style={{ fontStretch: '92%' }}>
            {KIT_LAUNCH.name}
          </span>
        </p>
        <p className="text-xs text-fg-3">Launch configuration on {KIT.launchVenue}</p>
      </div>
      {/* Phones read the tax, where it goes, then the pool fee; from md the tax and the pool fee share the first row, apart. */}
      <div className="grid grid-cols-1 md:grid-cols-2">
        <Part name="trading-tax" legend="Trading tax" note={KIT_TAX_NOTE} className="md:col-start-1 md:row-start-1">
          <ReadoutStrip inset cols="grid-cols-2">
            <ReadoutSlot legend="Buy tax" value={pct(tax.buyPct)} sub="on every buy" />
            <ReadoutSlot legend="Sell tax" value={pct(tax.sellPct)} sub="on every sell" />
          </ReadoutStrip>
        </Part>
        <Part
          name="tax-distribution"
          legend="Tax distribution"
          aside={
            <span className="shrink-0 text-xs text-fg-3">
              Creator <span className="num text-fg-2">{pct(taxSplit.creatorPct)}</span>
            </span>
          }
          className="border-t border-line-soft md:col-span-2 md:row-start-2"
        >
          <div
            role="img"
            aria-label={`Buyback & Burn ${pct(taxSplit.buybackBurnPct)} of the tax, holders ${pct(taxSplit.holdersPct)}, creator ${pct(taxSplit.creatorPct)}`}
            className="mx-4 mt-3 flex h-2.5 gap-px overflow-hidden rounded-xs bg-well"
          >
            <span className={cn('h-full basis-0', SHARE_TONE.buyback)} style={{ flexGrow: taxSplit.buybackBurnPct }} />
            <span className={cn('h-full basis-0', SHARE_TONE.holders)} style={{ flexGrow: taxSplit.holdersPct }} />
          </div>
          <ReadoutStrip inset cols="grid-cols-2">
            <ReadoutSlot
              legend={
                <>
                  <Swatch tone="buyback" /> Buyback & Burn
                </>
              }
              value={pct(taxSplit.buybackBurnPct)}
              sub="of the tax"
            />
            <ReadoutSlot
              legend={
                <>
                  <Swatch tone="holders" /> Holders
                </>
              }
              value={pct(taxSplit.holdersPct)}
              sub="of the tax"
            />
          </ReadoutStrip>
        </Part>
        <Part name="pool-fee" legend="Pool fee" note={KIT_POOL_FEE_NOTE} className="border-t border-line-soft md:col-start-2 md:row-start-1 md:border-l md:border-t-0">
          <ReadoutStrip inset cols="grid-cols-2">
            <ReadoutSlot legend="Pool fee" value={pct(poolFee.pct)} sub="separate from the tax" />
            <ReadoutSlot legend="NEARKITS share" value={pct(poolFee.nearkitsSharePct)} sub="of the pool fee" />
          </ReadoutStrip>
        </Part>
      </div>
    </Panel>
  )
}

/** An instrument's bar graph: `cells` segments, the first `share`% of them lit. */
function Meter({ share, label, cells = 20 }: { share: number; label: string; cells?: number }) {
  const lit = Math.round((share / 100) * cells)
  return (
    <div role="img" aria-label={label} className="flex h-3 min-w-48 flex-1 gap-[3px]">
      {Array.from({ length: cells }, (_, i) => (
        <span key={i} className={cn('h-full min-w-0 flex-1 rounded-[1px]', i < lit ? 'bg-accent/80' : 'border border-line-strong')} />
      ))}
    </div>
  )
}

const TRACKER_STATUS: Record<BuybackTracker['state'], { label: string; tone: LedTone }> = {
  'awaiting-launch': { label: 'Awaiting launch', tone: 'off' },
  'awaiting-data': { label: 'Awaiting data', tone: 'off' },
  tracking: { label: 'Tracking', tone: 'on' },
}

const TRACKER_NOTE: Record<BuybackTracker['state'], string> = {
  'awaiting-launch': `Tracking begins after launch. Its figures will come from ${KIT.ticker}’s buyback and burn transactions on NEAR; none is shown until then.`,
  'awaiting-data': `Not tracked yet: NEARKITS doesn’t read ${KIT.ticker}’s buybacks and burns from the chain yet, so no figure is shown.`,
  tracking: `Read from ${KIT.ticker}’s buyback and burn transactions on NEAR.`,
}

/** Buyback & Burn: the readouts an on-chain source fills in ("—" until it has), and the tax share that pays for it. */
export function BuybackPanel({ tracker, kitDecimals }: { tracker: BuybackTracker; kitDecimals: number | null }) {
  const status = TRACKER_STATUS[tracker.state]
  const share = taxSplit.buybackBurnPct
  return (
    <Panel aria-labelledby="kit-buyback">
      <PanelHeader
        id="kit-buyback"
        title="Buyback & Burn"
        actions={
          <Tag tone={tracker.state === 'tracking' ? 'accent' : 'neutral'}>
            <Led tone={status.tone} /> {status.label}
          </Tag>
        }
      />
      <ReadoutStrip inset cols="grid-cols-2 xl:grid-cols-4">
        {buybackReadouts(tracker, kitDecimals).map((r) => (
          // An absent figure is a ghost, as everywhere on the panel; it never reads as measured.
          <ReadoutSlot key={r.legend} legend={r.legend} value={r.value === UNKNOWN ? <span className="text-fg-4">{r.value}</span> : r.value} sub={r.sub} />
        ))}
      </ReadoutStrip>
      <div className="flex flex-col gap-3 p-4">
        <Legend>Tax allocation</Legend>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Meter share={share} label={`${pct(share)} of the trading tax goes to Buyback & Burn`} />
          <span className="shrink-0 text-sm text-fg-2">
            <Figures>{`${pct(share)} → Buyback & Burn`}</Figures>
          </span>
        </div>
        <p className="text-sm text-fg-3">{TRACKER_NOTE[tracker.state]}</p>
      </div>
    </Panel>
  )
}

/** Holder rewards: the confirmed share of the tax, and nothing earned or claimable until tracking exists. */
export function HolderRewardsPanel() {
  return (
    <Panel aria-labelledby="kit-holder-rewards">
      <PanelHeader id="kit-holder-rewards" title="Holder rewards" actions={<ComingSoon />} />
      <ReadoutStrip inset cols="grid-cols-1">
        <ReadoutSlot legend="Allocated to holders" value={pct(taxSplit.holdersPct)} unit="of the tax" sub="set by the launch configuration" />
      </ReadoutStrip>
      <p className="p-4 text-sm text-fg-2">Holder reward tracking will be available after launch.</p>
    </Panel>
  )
}
