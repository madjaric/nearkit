import { RotateCcw } from 'lucide-react'
import { AccountText } from '@/components/domain/Account'
import { TokenGlyph } from '@/components/domain/TokenGlyph'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/Copy'
import { Figures } from '@/components/ui/Figures'
import { Led, Tag, type LedTone } from '@/components/ui/Indicators'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { ReadoutSlot, ReadoutStrip } from '@/components/ui/Readout'
import { cn } from '@/lib/cn'
import { formatDateTime, formatNumber } from '@/lib/format'
import type { ChainScan, FactKind, RiskLevel, ScanFact } from '@/types/domain'

const KIND: Record<FactKind, { tone: LedTone; label: string; text: string }> = {
  verified: { tone: 'on', label: 'Verified', text: 'text-fg-2' },
  derived: { tone: 'idle', label: 'Derived', text: 'text-fg-3' },
  unknown: { tone: 'off', label: 'Unknown', text: 'text-fg-4' },
}

const LEVEL: Record<RiskLevel, { label: string; tag: 'neg' | 'warn' | 'neutral' }> = {
  high: { label: 'High', tag: 'neg' },
  elevated: { label: 'Elevated', tag: 'warn' },
  info: { label: 'Info', tag: 'neutral' },
}

function Provenance({ kind, className }: { kind: FactKind; className?: string }) {
  const k = KIND[kind]
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.07em]', k.text, className)}>
      <Led tone={k.tone} />
      {k.label}
    </span>
  )
}

function Slot({ fact }: { fact: ScanFact | undefined }) {
  if (!fact) return null
  return <ReadoutSlot legend={fact.label} value={fact.value ?? <span className="text-fg-4">Unknown</span>} sub={<Provenance kind={fact.kind} />} />
}

/**
 * On-chain scan: each figure carries its provenance (verified from chain,
 * derived from an indexer or price feed, or unknown). Observations are neutral
 * pointers; NearKit never issues a safe/scam verdict.
 */
export function ChainScanView({ report, onRescan, rescanning }: { report: ChainScan; onRescan: () => void; rescanning: boolean }) {
  const fact = (id: string) => report.facts.find((f) => f.id === id)
  const counts = (['verified', 'derived', 'unknown'] as const).map((k) => [k, report.facts.filter((f) => f.kind === k).length] as const)

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader
          title={
            <span className="flex items-center gap-2 normal-case tracking-normal">
              <TokenGlyph symbol={report.symbol} tokenId={report.contract} size={20} />
              <span className="text-sm text-fg">{report.name}</span>
              <span className="num text-xs text-fg-3">{report.symbol}</span>
            </span>
          }
          actions={
            <>
              <Tag tone="neutral">{report.network === 'mainnet' ? 'Mainnet' : 'Testnet'}</Tag>
              <Button size="xs" variant="ghost" icon={<RotateCcw size={12} />} onClick={onRescan} loading={rescanning}>
                Rescan
              </Button>
            </>
          }
        />
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-xs">
          <span className="flex min-w-0 items-center gap-1">
            <span className="legend mr-1">Contract</span>
            <AccountText id={report.contract} className="text-fg-2" />
            <CopyButton value={report.contract} label="Copy contract" />
          </span>
          <span className="text-fg-3">
            <Figures>{`Scanned ${formatDateTime(report.scannedAt)}`}</Figures>
          </span>
        </div>
        <ReadoutStrip cols="grid-cols-2 md:grid-cols-3 xl:grid-cols-6" inset className="border-t border-line-soft">
          <Slot fact={fact('supply')} />
          <Slot fact={fact('holders')} />
          <Slot fact={fact('top10')} />
          <Slot fact={fact('upgrade')} />
          <Slot fact={fact('created')} />
          <Slot fact={fact('price')} />
        </ReadoutStrip>
      </Panel>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <Panel>
          <PanelHeader
            title="Facts"
            actions={
              <span className="flex items-center gap-3 text-xs">
                {counts.map(([k, n]) => (
                  <span key={k} className="flex items-center gap-1.5 text-fg-3">
                    <Led tone={KIND[k].tone} />
                    <span className="num text-fg-2">{n}</span> {KIND[k].label.toLowerCase()}
                  </span>
                ))}
              </span>
            }
          />
          <dl className="divide-y divide-line-soft">
            {report.facts.map((f) => (
              <div key={f.id} className="grid grid-cols-1 gap-1 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-4">
                <dt className="min-w-0">
                  <span className="text-sm text-fg-2">{f.label}</span>
                  {f.note && (
                    <p className="mt-0.5 text-xs text-fg-3">
                      <Figures>{f.note}</Figures>
                    </p>
                  )}
                </dt>
                <dd className="flex flex-col items-start gap-1 sm:items-end">
                  <span className={cn('num text-sm', f.value === null ? 'text-fg-4' : 'text-fg')}>{f.value ?? 'Unknown'}</span>
                  <span className="flex items-center gap-2">
                    <Provenance kind={f.kind} />
                    <span className="text-[11px] text-fg-4">{f.source}</span>
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </Panel>

        <div className="flex flex-col gap-4">
          <Panel>
            <PanelHeader title="Observations" meta={report.observations.length === 0 ? 'None' : String(report.observations.length)} />
            {report.observations.length === 0 ? (
              <p className="px-4 py-4 text-sm text-fg-3">Nothing stood out in the facts NearKit can read. That is not a safety rating.</p>
            ) : (
              <ul className="divide-y divide-line-soft">
                {report.observations.map((o) => (
                  <li key={o.id} className="flex gap-3 px-4 py-3">
                    <Tag tone={LEVEL[o.level].tag} className="mt-px w-[68px] justify-center">
                      {LEVEL[o.level].label}
                    </Tag>
                    <div className="min-w-0">
                      <p className="text-sm text-fg">{o.label}</p>
                      <p className="mt-0.5 text-xs text-fg-3">
                        <Figures>{o.detail}</Figures>
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel>
            <PanelHeader title="Largest holders" meta={<Provenance kind={report.topHolders ? 'derived' : 'unknown'} />} />
            {report.topHolders ? (
              <ol className="divide-y divide-line-soft">
                {report.topHolders.map((h, i) => (
                  <li key={h.accountId} className="grid grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2">
                    <span className="num text-xs text-fg-4">{i + 1}</span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5">
                        <AccountText id={h.accountId} className="text-xs text-fg-2" />
                        {h.burn && (
                          <Tag tone="neutral" title="Tokens sent to the all-zeros account can never move again">
                            Burn
                          </Tag>
                        )}
                      </span>
                      <span className="mt-1 block h-1 overflow-hidden rounded-[1px] bg-raised" aria-hidden="true">
                        <span className="block h-full bg-fg-3" style={{ width: `${Math.min(100, h.pct)}%` }} />
                      </span>
                    </span>
                    <span className="num text-xs text-fg">{formatNumber(h.pct, 2, 2)}%</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="px-4 py-4 text-sm text-fg-3">The indexer did not answer, so holder ranking is unknown.</p>
            )}
          </Panel>
        </div>
      </div>

      <p className="text-xs text-fg-3">
        Verified figures are read from the chain by NearKit. Derived figures come from NearBlocks or Rhea and can lag or be wrong. Unknown means public data can’t answer it. None
        of this is a safety rating or advice.
      </p>
    </div>
  )
}
