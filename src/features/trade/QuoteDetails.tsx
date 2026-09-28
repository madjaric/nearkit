import { QuoteFreshness } from '@/components/domain/QuoteFreshness'
import { InfoTip, Term } from '@/components/ui/Help'
import { Line, Lines } from '@/components/ui/Panel'
import { cn } from '@/lib/cn'
import { NEARKIT_FEE_LABEL } from '@/lib/fees'
import { formatAmount, formatNumber, formatPct, formatPrice, formatUsd } from '@/lib/format'
import { useCapabilities } from '@/services/queries'
import type { Quote } from '@/types/domain'

const bpsLabel = (bps: number) => `${formatNumber(bps / 100, 2, 2)}%`

interface QuoteDetailsProps {
  quote: Quote | undefined
  inSymbol: string
  outSymbol: string
  /** Decimals for the output amount (NEAR keeps 2, tokens 0 for large values). */
  outDecimals: number
  /** USD price of the output token, for the estimate's dollar value. */
  outPriceUsd?: number
  stale: boolean
  settling: boolean
  error?: string | null
  showPath?: boolean
  showReceive?: boolean
}

/**
 * The quote, printed the same way on every ticket: estimate first, then the
 * lines a trader checks before firing. Empty slots hold their place with a dash.
 */
export function QuoteDetails({ quote: q, inSymbol, outSymbol, outDecimals, outPriceUsd, stale, settling, error, showPath = false, showReceive = true }: QuoteDetailsProps) {
  const caps = useCapabilities()
  const impact = q?.priceImpactPct ?? null
  const impactTone = impact === null ? 'text-fg-4' : impact > 10 ? 'text-neg' : impact > 3 ? 'text-warn' : 'text-fg-2'
  const fee = q?.nearkitFee
  // Demo shows the fee for illustration; real mode states whether it is charged and how it splits.
  const feeText =
    !q || !fee
      ? '—'
      : caps.mode === 'near' && !fee.charged
        ? 'Not charged on testnet'
        : fee.amountNear === null
          ? `${NEARKIT_FEE_LABEL} of the trade`
          : `${formatNumber(fee.amountNear, 2, 4)} NEAR`
  const feeSplit =
    fee && fee.charged && fee.receivedBps !== null && fee.routerShareBps !== null
      ? `Of the ${NEARKIT_FEE_LABEL}, NearKit receives ${bpsLabel(fee.receivedBps)} and Rhea keeps ${bpsLabel(fee.routerShareBps)}.${fee.routerFeeBps ? ` Rhea also charges its own ${bpsLabel(fee.routerFeeBps)} on every swap.` : ''}`
      : null
  const fade = stale && q ? 'opacity-45' : ''
  const small = q ? q.rate < 0.01 : false

  return (
    <div className="flex flex-col gap-1.5">
      {showReceive && (
        <>
          <div className="flex items-baseline justify-between gap-3">
            <span className="legend">You receive (est.)</span>
            {q && outPriceUsd !== undefined && <span className="num text-xs text-fg-3">≈ {formatUsd(q.amountOut * outPriceUsd)}</span>}
          </div>
          <div className={cn('num truncate text-xl leading-7 transition-opacity duration-200', q ? 'text-fg' : 'text-fg-4', fade)} aria-live="polite">
            {q ? formatAmount(q.amountOut, outDecimals) : '0'} <span className="font-sans text-sm font-medium text-fg-3">{outSymbol}</span>
          </div>
        </>
      )}
      <Lines dense className={cn('transition-opacity duration-200', fade)}>
        <Line label={<Term term="minReceived" />}>{q ? `${formatAmount(q.minAmountOut, outDecimals)} ${outSymbol}` : '—'}</Line>
        <Line label="Rate">{q ? `1 ${inSymbol} ≈ ${small ? formatPrice(q.rate) : formatAmount(q.rate)} ${outSymbol}` : '—'}</Line>
        {showPath && (
          <Line label="Path">
            {q ? (
              <span className="flex items-center justify-end gap-1.5">
                {q.path.join(' → ')}
                <InfoTip>{q.router === 'demo' ? 'Demo route through NEAR.' : 'Route from Rhea’s router. It is quoted again right before you sign.'}</InfoTip>
              </span>
            ) : (
              '—'
            )}
          </Line>
        )}
        <Line label={<Term term="priceImpact" />}>
          <span className={impactTone}>{!q ? '—' : impact === null ? 'Unknown' : formatPct(impact, { signed: false })}</span>
        </Line>
        <Line
          label={
            <>
              NearKit fee <span className="num text-fg-2">{NEARKIT_FEE_LABEL}</span> {feeSplit ? <InfoTip>{feeSplit}</InfoTip> : <InfoTip term="nearkitFee" />}
            </>
          }
        >
          {q && fee && fee.amountUsd !== null && (caps.mode === 'demo' || fee.charged) ? (
            <>
              {feeText} <span className="text-fg-4">· {formatUsd(fee.amountUsd)}</span>
            </>
          ) : (
            feeText
          )}
        </Line>
        {fee?.routerFeeBps ? <Line label="Rhea protocol fee">{bpsLabel(fee.routerFeeBps)}</Line> : null}
        <Line label={<Term term="networkFee">Network fee (est.)</Term>}>{q ? `${formatNumber(q.networkFeeNear, 4, 4)} NEAR` : '—'}</Line>
      </Lines>
      <QuoteFreshness quotedAt={q?.quotedAt} expiresAt={q?.expiresAt} fetching={settling} className="mt-0.5" />
      {error && <p className="text-xs text-neg">{error}</p>}
      {impact !== null && impact > 3 && (
        <p className={cn('text-xs', impact > 10 ? 'text-neg' : 'text-warn')}>
          {impact > 10 ? 'Very high price impact. ' : 'High price impact. '}
          This order moves the pool price by {formatPct(impact, { signed: false, decimals: 1 })}.
        </p>
      )}
    </div>
  )
}
