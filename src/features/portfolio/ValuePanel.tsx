import { useMemo, useState } from 'react'
import { ValueTrace } from '@/components/chart/ValueTrace'
import { Segmented } from '@/components/ui/Form'
import { Skeleton } from '@/components/ui/Indicators'
import { Pct } from '@/components/ui/Num'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { Table, Td, Th, Tr } from '@/components/ui/Table'
import { formatClock, formatDate, formatDateTime, formatUsd, formatUsdCompact } from '@/lib/format'
import { useCapabilities, useValueHistory } from '@/services/queries'

type Range = '1' | '7' | '30'
type View = 'chart' | 'table'

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** What each range's table lists (the last value seen in each hour, or day), and the window it names. */
const RANGES: Record<Range, { bucket: number; window: string }> = {
  '1': { bucket: HOUR, window: 'last 24 hours' },
  '7': { bucket: DAY, window: 'last 7 days' },
  '30': { bucket: DAY, window: 'last 30 days' },
}
/** Samples further apart than this are a gap (NearKit wasn't open): no line is drawn across it. */
const GAP_MS = 2 * HOUR

/** The last sample of each bucket, newest first. */
function perBucket<T extends { t: number }>(points: readonly T[], bucket: number): T[] {
  const last = new Map<number, T>()
  for (const p of points) last.set(Math.floor(p.t / bucket), p)
  return [...last.values()].sort((a, b) => b.t - a.t)
}

/**
 * Portfolio value over time, with a table twin for exact readings. Real mode shows what this browser
 * recorded while NearKit was open (src/lib/valueHistory.ts), placed by time: a gap stays a gap.
 */
export function ValuePanel() {
  const caps = useCapabilities()
  const [range, setRange] = useState<Range>('7')
  const [view, setView] = useState<View>('chart')
  const history = useValueHistory(Number(range))
  const points = useMemo(() => (history.data ?? []).map((p) => ({ t: p.t, v: p.valueUsd })), [history.data])
  const first = points[0]
  const last = points[points.length - 1]
  const change = first && last && first.v > 0 ? ((last.v - first.v) / first.v) * 100 : 0
  const rows = perBucket(points, RANGES[range].bucket)
  const recorded = caps.mode !== 'demo'

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
                { value: '1', label: '1D' },
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
          <p className="py-16 text-center text-sm text-fg-3">
            {recorded
              ? `No value history for the ${RANGES[range].window} yet. NEARKITS records your portfolio’s value while it is open, so the history builds up from now.`
              : 'No value history for this account yet.'}
          </p>
        ) : view === 'chart' ? (
          <ValueTrace
            points={points}
            label={`Portfolio value, ${RANGES[range].window}`}
            formatValue={(v) => formatUsd(v)}
            formatTick={(v) => formatUsdCompact(v, 1)}
            formatTime={formatDateTime}
            formatAxis={range === '1' ? formatClock : formatDate}
            measure
            timeScale
            gapMs={recorded ? GAP_MS : undefined}
            key={range}
            height={220}
            dim={history.isPlaceholderData}
          />
        ) : (
          <div className="max-h-[200px] overflow-y-auto">
            <Table label={`Portfolio value, ${RANGES[range].window}`}>
              <thead className="sticky top-0 bg-panel">
                <tr>
                  <Th>Date</Th>
                  <Th align="right">Value</Th>
                  <Th align="right">Change</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p, i) => {
                  const prev = rows[i + 1]
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
