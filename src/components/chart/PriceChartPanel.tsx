import type { ReactNode } from 'react'
import { Segmented } from '@/components/ui/Form'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { CANDLE_INTERVALS, INTERVAL_LABEL, type CandleInterval } from '@/lib/chart/intervals'
import { PriceChart, type PriceChartProps } from './PriceChart'

/**
 * A token's price panel, the same wherever NEARKITS charts a token (Launch Radar, the Token page): its
 * title, the candle intervals (1min to 1d), the interactive chart and a line saying where the data comes
 * from. An interval the source doesn't have stays in the control, disabled, with the reason on hover.
 */
export function PriceChartPanel({
  interval,
  onInterval,
  unavailable,
  chartKey,
  chart,
  alert,
  note,
}: {
  interval: CandleInterval
  onInterval: (i: CandleInterval) => void
  /** Intervals this token's source doesn't have, each with why. */
  unavailable?: Partial<Record<CandleInterval, string>>
  /** A new key rebuilds the chart (switching between candles and a line). */
  chartKey?: string
  chart: PriceChartProps
  /** A warning under the chart (a refresh that failed while the last data stays). */
  alert?: ReactNode
  /** Where the data comes from, and how to read it. */
  note?: ReactNode
}) {
  return (
    <Panel>
      <PanelHeader
        title="Price"
        actions={
          <Segmented
            label="Candle interval"
            size="sm"
            value={interval}
            onChange={onInterval}
            options={CANDLE_INTERVALS.map((i) => ({ value: i, label: INTERVAL_LABEL[i], disabled: unavailable?.[i] !== undefined, title: unavailable?.[i] }))}
          />
        }
      />
      <div className="flex flex-col gap-2 p-3">
        <PriceChart key={chartKey} {...chart} />
        {alert && (
          <p className="text-xs text-warn" role="alert">
            {alert}
          </p>
        )}
        {note && <p className="text-[11px] leading-4 text-fg-3">{note}</p>}
      </div>
    </Panel>
  )
}
