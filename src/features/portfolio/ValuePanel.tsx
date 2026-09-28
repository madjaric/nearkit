import { useMemo, useState } from 'react'
import { ValueTrace } from '@/components/chart/ValueTrace'
import { Segmented } from '@/components/ui/Form'
import { Skeleton } from '@/components/ui/Indicators'
import { Pct } from '@/components/ui/Num'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { Table, Td, Th, Tr } from '@/components/ui/Table'
import { formatDate, formatDateTime, formatUsd, formatUsdCompact } from '@/lib/format'
import { useValueHistory } from '@/services/queries'

type Range = '7' | '30'
type View = 'chart' | 'table'

/** Portfolio value over time, with a table twin for exact readings. */
export function ValuePanel() {
  const [range, setRange] = useState<Range>('7')
  const [view, setView] = useState<View>('chart')
  const history = useValueHistory(Number(range))
  const points = useMemo(() => (history.data ?? []).map((p) => ({ t: p.t, v: p.valueUsd })), [history.data])
  const first = points[0]
  const last = points[points.length - 1]
  const change = first && last && first.v > 0 ? ((last.v - first.v) / first.v) * 100 : 0
  const daily = points.filter((_, i) => (points.length - 1 - i) % 4 === 0).reverse()

  return (
    <Panel>
      <PanelHeader
        title="Portfolio value"
        meta={first && last ? <Pct value={change} /> : undefined}
        actions={
          <>
            <Segmented
              label="Range"
              size="sm"
              value={range}
              onChange={setRange}
              options={[
                { value: '7', label: '7D' },
                { value: '30', label: '30D' },
              ]}
            />
            <Segmented
              label="View"
              size="sm"
              value={view}
              onChange={setView}
              options={[
                { value: 'chart', label: 'Chart' },
                { value: 'table', label: 'Table' },
              ]}
            />
          </>
        }
      />
      <div className="px-4 pb-3 pt-4">
        {history.isPending ? (
          <Skeleton className="h-[248px] w-full" />
        ) : points.length < 2 ? (
          <p className="py-16 text-center text-sm text-fg-3">No value history for this account yet.</p>
        ) : view === 'chart' ? (
          <ValueTrace
            points={points}
            label={`Portfolio value, last ${range} days`}
            formatValue={(v) => formatUsd(v)}
            formatTick={(v) => formatUsdCompact(v, 1)}
            formatTime={formatDateTime}
            formatAxis={formatDate}
            measure
            key={range}
            height={220}
            dim={history.isPlaceholderData}
          />
        ) : (
          <div className="max-h-[200px] overflow-y-auto">
            <Table label={`Portfolio value, last ${range} days`}>
              <thead className="sticky top-0 bg-panel">
                <tr>
                  <Th>Date</Th>
                  <Th align="right">Value</Th>
                  <Th align="right">Change</Th>
                </tr>
              </thead>
              <tbody>
                {daily.map((p, i) => {
                  const prev = daily[i + 1]
                  return (
                    <Tr key={p.t}>
                      <Td className="text-fg-2">{formatDateTime(p.t)}</Td>
                      <Td align="right" mono className="text-fg">
                        {formatUsd(p.v)}
                      </Td>
                      <Td align="right">{prev ? <Pct value={((p.v - prev.v) / prev.v) * 100} /> : <span className="text-fg-4">—</span>}</Td>
                    </Tr>
                  )
                })}
              </tbody>
            </Table>
          </div>
        )}
      </div>
    </Panel>
  )
}
