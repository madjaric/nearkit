import { useQueryClient } from '@tanstack/react-query'
import { ScanSearch } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Page, PageHeader } from '@/components/page/Page'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Input } from '@/components/ui/Form'
import { Skeleton, Tag } from '@/components/ui/Indicators'
import { Panel } from '@/components/ui/Panel'
import { ChainScanView } from '@/features/scanner/ChainScan'
import { ScanReportView } from '@/features/scanner/ScanReport'
import { accountIdError } from '@/lib/validation'
import { describeError } from '@/services/errors'
import { useCapabilities, useScan, useScanSuggestions, useTokens } from '@/services/queries'

function Suggestions({ onPick }: { onPick: (q: string) => void }) {
  const { data = [] } = useScanSuggestions()
  const { mode } = useCapabilities()
  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      {data.map((s) => (
        <button
          key={s.query}
          type="button"
          title={s.query}
          onClick={() => onPick(s.query)}
          className="num h-7 rounded-xs border border-line px-2.5 text-xs text-fg-2 transition-colors hover:border-line-strong hover:text-fg"
        >
          {/* Real contracts can be 64-char implicit IDs, so real mode shows the symbol. */}
          {mode === 'demo' ? s.query : s.label}
        </button>
      ))}
    </div>
  )
}

function ReportSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Scanning">
      <Panel className="p-4">
        <Skeleton className="h-5 w-56" />
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-6">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      </Panel>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
      </div>
    </div>
  )
}

export default function ScannerPage() {
  const [params, setParams] = useSearchParams()
  const query = params.get('q') ?? ''
  const [input, setInput] = useState(query)
  const [seen, setSeen] = useState(query)
  if (seen !== query) {
    // The search box can open the scanner with a new ?q=; mirror it into the field.
    setSeen(query)
    setInput(query)
  }
  const scan = useScan(query)
  const caps = useCapabilities()
  const real = caps.mode === 'near'
  const net = caps.networkLabel.toLowerCase()
  const qc = useQueryClient()
  const { data: tokens = [] } = useTokens()
  const recent = qc
    .getQueryCache()
    .findAll({ queryKey: ['scan'] })
    .map((q) => String(q.queryKey[1] ?? ''))
    .filter((q) => q && q !== query)
    .slice(-5)
    .reverse()

  const submit = (value: string) => {
    const v = value.trim()
    if (!v) return
    setInput(v)
    setParams({ q: v })
  }

  const q = query.trim().toLowerCase().replace(/^\$/, '')
  const listed = tokens.find((t) => t.symbol.toLowerCase() === q || t.contract === q || t.id === q)
  const invalid = query && !listed && !/\s/.test(query) && /[.]/.test(query) ? accountIdError(query.trim()) : null

  let body
  if (!query) {
    body = (
      <Panel>
        <EmptyState title="Scan a token contract" action={<Suggestions onPick={submit} />}>
          {real
            ? `Paste a NEP-141 contract or a listed symbol. NearKit reads supply, metadata and upgrade keys from ${net} and marks every figure that comes from an indexer instead. Try one:`
            : 'Paste a contract or symbol to read its supply, holder concentration, creator holdings, liquidity and contract permissions. The demo scanner reads sample contracts. Try one:'}
        </EmptyState>
      </Panel>
    )
  } else if (scan.isPending || (scan.isFetching && !scan.data)) {
    body = <ReportSkeleton />
  } else if (scan.data?.kind === 'chain') {
    body = <ChainScanView report={scan.data} rescanning={scan.isFetching} onRescan={() => scan.refetch()} />
  } else if (scan.data) {
    body = <ScanReportView report={scan.data} rescanning={scan.isFetching} onRescan={() => scan.refetch()} />
  } else if (scan.isError) {
    const err = describeError(scan.error)
    body = (
      <Panel>
        <EmptyState
          title={err.code === 'INVALID_TOKEN' ? 'Not a token contract' : 'The scan didn’t finish'}
          action={
            <Button size="sm" onClick={() => scan.refetch()}>
              Try again
            </Button>
          }
        >
          {err.message}
        </EmptyState>
      </Panel>
    )
  } else if (listed?.status === 'prelaunch') {
    body = (
      <Panel>
        <EmptyState
          title="$KIT has not launched"
          action={
            <Link to="/kit" className="keycap inline-flex h-8 items-center rounded-sm border border-line px-3 text-xs text-fg-2 hover:border-line-strong hover:text-fg">
              About $KIT
            </Link>
          }
        >
          There is no deployed contract to scan yet. $KIT launches separately through Nearly.
        </EmptyState>
      </Panel>
    )
  } else if (listed && !real) {
    body = (
      <Panel>
        <EmptyState title={`No demo scan data for ${listed.symbol}`} action={<Suggestions onPick={submit} />}>
          The demo scanner only reports on sample contracts, so it never shows invented figures for a real token. Run NearKit on a network to scan real contracts.
        </EmptyState>
      </Panel>
    )
  } else {
    body = (
      <Panel>
        <EmptyState title={`Nothing found for “${query}”`} action={<Suggestions onPick={submit} />}>
          {invalid ? `${invalid}.` : real ? `No account with that name exists on ${net}, and no listed token has that symbol.` : 'Check the contract or symbol.'}
          {real ? '' : ' The demo scanner reads sample contracts only.'}
        </EmptyState>
      </Panel>
    )
  }

  return (
    <Page>
      <PageHeader
        title="Scanner"
        status={<Tag tone="neutral">{real ? `${caps.networkLabel} data` : 'Sample contracts'}</Tag>}
        description="Contract facts and risk indicators for any NEAR token. Indicators, never verdicts."
      />
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault()
          submit(input)
        }}
        className="flex flex-col gap-2"
      >
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <ScanSearch size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-3" />
            <Input
              aria-label="Token contract or symbol"
              placeholder={real ? 'Token contract or symbol' : 'Token contract or symbol, e.g. moss.sample.near'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              mono
              spellCheck={false}
              autoComplete="off"
              className="h-11 pl-10 text-base"
            />
          </div>
          <Button type="submit" variant="primary" size="lg" disabled={!input.trim()} loading={scan.isFetching && Boolean(query)}>
            Scan
          </Button>
        </div>
        {recent.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-fg-3">
            <span className="legend">Recent</span>
            {recent.map((r) => (
              <button key={r} type="button" onClick={() => submit(r)} className="num rounded-xs px-1.5 py-0.5 text-fg-2 hover:bg-raised hover:text-fg">
                {r}
              </button>
            ))}
          </div>
        )}
      </form>
      {body}
    </Page>
  )
}
