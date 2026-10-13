import { InfoTip, Term } from '@/components/ui/Help'
import { Line } from '@/components/ui/Panel'
import { costLines, impactLabel, impactValue } from '@/lib/quoteCosts'
import type { QuoteCosts } from '@/types/domain'

/**
 * A quote's costs besides the NEARKITS fee, each its own row of a `Lines` list: the pool's or Rhea's fee,
 * a token's own tax. The figures come from the route (services/real/swapCosts.ts), the words from
 * lib/quoteCosts.ts, the same as the NEARKITS-wallet review and Telegram say them.
 */
export function CostLines({ costs, inSymbol, outSymbol }: { costs: QuoteCosts | null | undefined; inSymbol: string; outSymbol: string }) {
  if (!costs) return null
  return (
    <>
      {costLines(costs, { in: inSymbol, out: outSymbol }).map((l) => (
        <Line
          key={l.key}
          label={
            <>
              {l.label} <InfoTip>{l.hint}</InfoTip>
            </>
          }
        >
          {l.value}
        </Line>
      ))}
    </>
  )
}

/** Price impact's row: measured, or labelled as an estimate from listed prices; unknown said as such. */
export function ImpactLine({ pct, estimated, quoted, className }: { pct: number | null; estimated: boolean; quoted: boolean; className?: string }) {
  return (
    <Line label={<Term term="priceImpact">{impactLabel(estimated)}</Term>}>
      <span className={className}>{quoted ? impactValue(pct, estimated) : '—'}</span>
    </Line>
  )
}
