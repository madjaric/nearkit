import { Figures } from '@/components/ui/Figures'
import { InfoTip } from '@/components/ui/Help'
import { Line } from '@/components/ui/Panel'
import { GAS_RESERVE_LABEL, GAS_RESERVE_NOTE } from '@/lib/gasReserve'

/**
 * The gas reserve on a review: what NEAR holds for the attached gas while the transaction runs,
 * named as a reserve that is refunded, with its explanation right under the figure. Never a fee.
 */
export function GasReserveLine({ value }: { value: string }) {
  return (
    <Line
      label={
        <>
          {GAS_RESERVE_LABEL} <InfoTip term="gasReserveRefunded" />
        </>
      }
    >
      <span className="flex flex-col items-end gap-0.5">
        <Figures>{value}</Figures>
        <span className="max-w-64 text-right font-sans text-xs text-fg-3">{GAS_RESERVE_NOTE}</span>
      </span>
    </Line>
  )
}
