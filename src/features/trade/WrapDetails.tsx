import { InfoTip, Term } from '@/components/ui/Help'
import { Line, Lines } from '@/components/ui/Panel'
import { NEAR_DECIMALS } from '@/config/networks'
import { formatUnits } from '@/lib/amounts'
import { ACTUAL_NETWORK_FEE_LABEL } from '@/lib/gasReserve'
import { WRAP_NETWORK_FEE_YOCTO, type WrapDirection } from '@/services/near/wrap'
import { WRAP_FEE_TEXT, wrapExplainer } from './wrapCopy'

/**
 * NEAR ↔ wNEAR on the Swap ticket, in place of a quote: one call to the wrap contract, and
 * exactly what goes in comes out. No route, no NEARKITS fee, nothing to slip.
 */
export function WrapDetails({ direction, contract }: { direction: WrapDirection; contract: string }) {
  const [inSymbol, outSymbol] = direction === 'unwrap' ? ['wNEAR', 'NEAR'] : ['NEAR', 'wNEAR']
  return (
    <Lines dense>
      <Line label="Rate">{`1 ${inSymbol} = 1 ${outSymbol} · exact`}</Line>
      <Line label="Contract call">
        <span className="flex items-center justify-end gap-1.5">
          {`${contract} · ${direction === 'unwrap' ? 'near_withdraw' : 'near_deposit'}`}
          <InfoTip>{wrapExplainer(direction)}</InfoTip>
        </span>
      </Line>
      <Line label="NEARKITS fee">{WRAP_FEE_TEXT}</Line>
      <Line label={<Term term="networkFee">{ACTUAL_NETWORK_FEE_LABEL}</Term>}>{`≈ ${formatUnits(WRAP_NETWORK_FEE_YOCTO, NEAR_DECIMALS, { maxFraction: 4 })} NEAR`}</Line>
    </Lines>
  )
}
