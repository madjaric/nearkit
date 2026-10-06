import { QuoteFreshness } from '@/components/domain/QuoteFreshness'
import { TokenGlyph } from '@/components/domain/TokenGlyph'
import { InfoTip, Term } from '@/components/ui/Help'
import { Line, Lines } from '@/components/ui/Panel'
import { cn } from '@/lib/cn'
import { NEARKIT_FEE_LABEL } from '@/lib/fees'
import { ACTUAL_NETWORK_FEE_LABEL } from '@/lib/gasReserve'
import { ROUTE_SOURCE_LABEL } from '@/services/routing/select'
import { formatAmount, formatNumber, formatPct, formatPrice, formatUsd } from '@/lib/format'
import { useCapabilities } from '@/services/queries'
import type { Quote } from '@/types/domain'

const bpsLabel = (bps: number) => `${formatNumber(bps / 100, 2, 2)}%`

interface QuoteDetailsProps {
  quote: Quote | undefined
  inSymbol: string
  outSymbol: string
  /** The output token's id, for its glyph on the estimate. */
  outTokenId?: string
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
export function QuoteDetails({
  quote: q,
  inSymbol,
  outSymbol,
  outTokenId,
  outDecimals,
  outPriceUsd,
  stale,
  settling,
  error,
  showPath = false,
  showReceive = true,
}: QuoteDetailsProps) {
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
      ? `Of the ${NEARKIT_FEE_LABEL}, NEARKITS receives ${bpsLabel(fee.receivedBps)} and Rhea keeps ${bpsLabel(fee.routerShareBps)}.${fee.routerFeeBps ? ` Rhea also charges its own ${bpsLabel(fee.routerFeeBps)} on every swap.` : ''}`
      : null
  const fade = stale && q ? 'opacity-45' : ''
  const small = q ? q.rate < 0.01 : false

  return (
    <div className="flex flex-col gap-1.5">
      {showReceive && (
        <div className="mb-1 flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="legend">You receive (est.)</span>
            {q && outPriceUsd !== undefined && <span className="num text-xs text-fg-3">≈ {formatUsd(q.amountOut * outPriceUsd)}</span>}
          </div>
          <div className={cn('flex h-14 items-center gap-3 rounded-md border border-line bg-well px-3.5 transition-opacity duration-200', fade)} aria-live="polite">
            <TokenGlyph symbol={outSymbol} tokenId={outTokenId} size={24} />
            <span className={cn('num min-w-0 flex-1 truncate text-xl', q ? 'text-fg' : 'text-fg-4')}>{q ? formatAmount(q.amountOut, outDecimals) : '—'}</span>
            <span className="shrink-0 text-sm font-semibold tracking-[0.04em] text-fg-3">{outSymbol}</span>
          </div>
        </div>
      )}
      <Lines dense className={cn('transition-opacity duration-200', fade)}>
        <Line label={<Term term="minReceived" />}>{q ? `${formatAmount(q.minAmountOut, outDecimals)} ${outSymbol}` : '—'}</Line>
        <Line label="Rate">{q ? `1 ${inSymbol} ≈ ${small ? formatPrice(q.rate) : formatAmount(q.rate)} ${outSymbol}` : '—'}</Line>
        {showPath && (
          <Line label="Route">
            {q ? (
              <span className="flex items-center justify-end gap-1.5">
                {q.path.join(' → ')}
                {q.source && <span className="text-fg-3">· {ROUTE_SOURCE_LABEL[q.source]}</span>}
                <InfoTip>
                  {q.router === 'demo'
                    ? 'Demo route through NEAR.'
                    : q.source === 'dcl'
                      ? 'Quoted on the DCL exchange’s own pools, read from chain. It is quoted again right before you sign.'
                      : 'Route from Rhea’s router. It is quoted again right before you sign.'}
                </InfoTip>
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
              NEARKITS fee <span className="num text-fg-2">{NEARKIT_FEE_LABEL}</span> {feeSplit ? <InfoTip>{feeSplit}</InfoTip> : <InfoTip term="nearkitFee" />}
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
        <Line label={<Term term="networkFee">{ACTUAL_NETWORK_FEE_LABEL}</Term>}>{q ? `≈ ${formatNumber(q.networkFeeNear, 4, 4)} NEAR` : '—'}</Line>
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
