import { RotateCcw } from 'lucide-react'
import { AccountText } from '@/components/domain/Account'
import { TokenGlyph } from '@/components/domain/TokenGlyph'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/Copy'
import { Figures } from '@/components/ui/Figures'
import { Term } from '@/components/ui/Help'
import { Led, Tag, type LedTone } from '@/components/ui/Indicators'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { ReadoutSlot, ReadoutStrip } from '@/components/ui/Readout'
import { cn } from '@/lib/cn'
import { formatCompact, formatDateTime, formatDuration, formatNumber, formatUsdCompact } from '@/lib/format'
import type { GlossaryKey } from '@/lib/glossary'
import type { RiskLevel, ScanReport as Report } from '@/types/domain'

type Grade = 'high' | 'elevated' | 'normal'

const GRADE: Record<Grade, { tone: LedTone; text: string; label: string }> = {
  high: { tone: 'neg', text: 'text-neg', label: 'High' },
  elevated: { tone: 'warn', text: 'text-warn', label: 'Elevated' },
  normal: { tone: 'idle', text: 'text-fg-3', label: 'Normal' },
}

const LEVEL: Record<RiskLevel, { tone: LedTone; label: string; tag: 'neg' | 'warn' | 'neutral' }> = {
  high: { tone: 'neg', label: 'High', tag: 'neg' },
  elevated: { tone: 'warn', label: 'Elevated', tag: 'warn' },
  info: { tone: 'idle', label: 'Info', tag: 'neutral' },
}

const gradeTop10 = (pct: number): Grade => (pct >= 60 ? 'high' : pct >= 40 ? 'elevated' : 'normal')
const gradeCreator = (pct: number): Grade => (pct >= 15 ? 'high' : pct >= 5 ? 'elevated' : 'normal')
const gradeLiquidity = (usd: number): Grade => (usd < 25_000 ? 'high' : usd < 100_000 ? 'elevated' : 'normal')

function Graded({ value, grade }: { value: string; grade: Grade }) {
  const g = GRADE[grade]
  return (
    <span className="flex items-baseline gap-2">
      {value}
      <span className={cn('font-sans text-[11px] font-semibold uppercase tracking-[0.06em]', g.text)}>{g.label}</span>
    </span>
  )
}

interface IndicatorRow {
  term: GlossaryKey
  value: string
  grade: Grade
}

/** Scan result: facts, contract indicators and graded flags. Never a SAFE/SCAM verdict. */
export function ScanReportView({ report, onRescan, rescanning }: { report: Report; onRescan: () => void; rescanning: boolean }) {
  const age = report.scannedAt - report.createdAt
  const indicators: IndicatorRow[] = [
    { term: 'contractVerified', value: report.indicators.contractVerified ? 'Verified' : 'Not verified', grade: report.indicators.contractVerified ? 'normal' : 'high' },
    { term: 'mintCapability', value: report.indicators.mintEnabled ? 'Enabled' : 'Disabled', grade: report.indicators.mintEnabled ? 'high' : 'normal' },
    {
      term: 'transferRestrictions',
      value: report.indicators.transferRestrictions === 'none' ? 'None found' : report.indicators.transferRestrictions === 'pausable' ? 'Pausable' : 'Allowlist',
      grade: report.indicators.transferRestrictions === 'none' ? 'normal' : 'high',
    },
    {
      term: 'liquidityStatus',
      value: report.indicators.liquidity === 'locked' ? 'Locked' : report.indicators.liquidity === 'unlocked' ? 'Unlocked' : 'Low',
      grade: report.indicators.liquidity === 'locked' ? 'normal' : report.indicators.liquidity === 'unlocked' ? 'elevated' : 'high',
    },
  ]
  const order: RiskLevel[] = ['high', 'elevated', 'info']
  const flags = [...report.flags].sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level))
  const counts = order.map((l) => report.flags.filter((f) => f.level === l).length)
  const shades = ['bg-fg-2', 'bg-fg-3', 'bg-fg-4']

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader
          title={
            <span className="flex items-center gap-2 normal-case tracking-normal">
              <TokenGlyph symbol={report.symbol} size={20} />
              <span className="text-sm text-fg">{report.name}</span>
              <span className="num text-xs text-fg-3">{report.symbol}</span>
            </span>
          }
          actions={
            <>
              {report.sample && (
                <Tag tone="warn" title="Fictional token used to demonstrate the scanner">
                  Sample data
                </Tag>
              )}
              <Button size="xs" variant="ghost" icon={<RotateCcw size={12} />} onClick={onRescan} loading={rescanning}>
                Rescan
              </Button>
            </>
          }
        />
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-xs">
          <span className="flex items-center gap-1">
            <span className="legend mr-1">Contract</span>
            <AccountText id={report.contract} className="text-fg-2" />
            <CopyButton value={report.contract} label="Copy contract" />
          </span>
          <span className="text-fg-3">
            <Figures>{`Scanned ${formatDateTime(report.scannedAt)}`}</Figures>
          </span>
        </div>
        <ReadoutStrip cols="grid-cols-2 md:grid-cols-3 xl:grid-cols-6" className="rounded-none border-x-0 border-b-0">
          <ReadoutSlot legend="Supply" value={formatCompact(report.totalSupply, 2)} sub={`${formatNumber(report.totalSupply, 0, 0)} ${report.symbol}`} />
          <ReadoutSlot legend="Holders" value={formatNumber(report.holders, 0, 0)} sub="accounts with a balance" />
          <ReadoutSlot
            legend={<Term term="top10">Top 10</Term>}
            value={<Graded value={`${formatNumber(report.top10Pct, 1, 1)}%`} grade={gradeTop10(report.top10Pct)} />}
            sub="of total supply"
          />
          <ReadoutSlot
            legend={<Term term="creatorHoldings">Creator</Term>}
            value={<Graded value={`${formatNumber(report.creatorPct, 1, 1)}%`} grade={gradeCreator(report.creatorPct)} />}
            sub="held by deployer"
          />
          <ReadoutSlot legend="Liquidity" value={<Graded value={formatUsdCompact(report.liquidityUsd)} grade={gradeLiquidity(report.liquidityUsd)} />} sub="pooled, USD" />
          <ReadoutSlot legend="Age" value={formatDuration(age)} sub={`since ${formatDateTime(report.createdAt)}`} />
        </ReadoutStrip>
      </Panel>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <Panel>
          <PanelHeader title="Contract indicators" />
          <dl className="divide-y divide-line-soft">
            {indicators.map((row) => (
              <div key={row.term} className="flex items-center justify-between gap-3 px-4 py-3">
                <dt className="text-sm text-fg-2">
                  <Term term={row.term} />
                </dt>
                <dd className="flex items-center gap-2">
                  <span className={cn('text-sm font-semibold uppercase tracking-[0.05em]', GRADE[row.grade].text === 'text-fg-3' ? 'text-fg' : GRADE[row.grade].text)}>
                    {row.value}
                  </span>
                  <Led tone={GRADE[row.grade].tone} />
                </dd>
              </div>
            ))}
          </dl>
        </Panel>

        <Panel>
          <PanelHeader
            title="Risk flags"
            actions={
              <span className="flex items-center gap-3 text-xs">
                {order.map((l, i) => (
                  <span key={l} className="flex items-center gap-1.5 text-fg-3">
                    <Led tone={LEVEL[l].tone} />
                    <span className="num text-fg-2">{counts[i]}</span> {LEVEL[l].label.toLowerCase()}
                  </span>
                ))}
              </span>
            }
          />
          <ul className="divide-y divide-line-soft">
            {flags.map((f) => (
              <li key={f.id} className="flex gap-3 px-4 py-3">
                <Tag tone={LEVEL[f.level].tag} className="mt-px w-[68px] justify-center">
                  {LEVEL[f.level].label}
                </Tag>
                <div className="min-w-0">
                  <p className="text-sm text-fg">
                    <Figures>{f.label}</Figures>
                  </p>
                  <p className="mt-0.5 text-xs text-fg-3">
                    <Figures>{f.detail}</Figures>
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <Panel>
        <PanelHeader title="Holder distribution" />
        <div className="flex flex-col gap-3 p-4">
          <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-xs" role="img" aria-label={report.holderBreakdown.map((h) => `${h.label} ${h.pct}%`).join(', ')}>
            {report.holderBreakdown.map((h, i) => (
              <span key={h.label} className={cn('h-full', shades[i] ?? 'bg-fg-4')} style={{ width: `${h.pct}%` }} />
            ))}
          </div>
          <ul className="flex flex-wrap gap-x-6 gap-y-1.5 text-xs">
            {report.holderBreakdown.map((h, i) => (
              <li key={h.label} className="flex items-center gap-2">
                <span className={cn('size-2 rounded-[1px]', shades[i] ?? 'bg-fg-4')} aria-hidden="true" />
                <span className="text-fg-2">{h.label}</span>
                <span className="num text-fg">{formatNumber(h.pct, 1, 1)}%</span>
              </li>
            ))}
          </ul>
        </div>
      </Panel>

      <p className="text-xs text-fg-3">
        Indicators describe the contract and its market at scan time. They are not a safety rating or advice. Always verify a contract before trading.
      </p>
    </div>
  )
}
