import { FileUp, Plus, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { AccountText } from '@/components/domain/Account'
import { SimulationNote } from '@/components/domain/Status'
import { TokenSelect } from '@/components/domain/TokenSelect'
import { WalletSelect } from '@/components/domain/WalletSelect'
import { Button, IconButton } from '@/components/ui/Button'
import { AmountInput, Field, Input, Tabs, Textarea } from '@/components/ui/Form'
import { tabPanelProps } from '@/components/ui/tabs'
import { InfoTip, Term } from '@/components/ui/Help'
import { Amount } from '@/components/ui/Num'
import { Line, Lines, Panel, PanelHeader } from '@/components/ui/Panel'
import { Table, Td, Th, Tr } from '@/components/ui/Table'
import { formatUnits } from '@/lib/amounts'
import { batchExample, parseBatchList, type BatchRow } from '@/lib/batch'
import { cn } from '@/lib/cn'
import { NETWORK_FEE_NEAR_PER_TX, STORAGE_DEPOSIT_NEAR } from '@/lib/fees'
import { formatAmount, formatNumber } from '@/lib/format'
import { executesViaNearKit } from '@/lib/wallets'
import { NATIVE_TOKEN_ID } from '@/config/networks'
import { useBalance, useCapabilities, useHoldings, usePlanners, useRawBalance, useTokens } from '@/services/queries'
import { NearKitSendsModal } from '../tools/NearKitSendsModal'
import { OperationModal } from '../tools/OperationModal'
import { useSourceWallet } from '../tools/useSource'
import { nearkitLines, rowSource, totalsBySource } from './rowSources'

type Mode = 'paste' | 'manual'
interface ManualRow {
  id: number
  account: string
  amount: string
  /** The NearKit wallet this row sends from; unset: Send from (rowSources.ts). */
  from?: string
}

let seq = 3
/** The demo starts from an example; real mode starts empty so nothing is sent to accounts the user didn't enter. */
const initialManual = (demo: boolean): ManualRow[] =>
  demo
    ? [
        { id: 1, account: 'alice.near', amount: '100' },
        { id: 2, account: 'bob.near', amount: '250' },
        { id: 3, account: 'charlie.near', amount: '500' },
      ]
    : [{ id: 1, account: '', amount: '' }]

/** Why a line won't be sent, in the line's own words. */
function RowStatus({ row }: { row: BatchRow }) {
  return <span className={cn('text-xs', row.status === 'duplicate' ? 'text-warn' : 'text-neg')}>{row.message}</span>
}

/** `initialTokenId` / `initialSourceId`: preselected by a token screen's Send (`?token=&from=`). */
export function BatchSend({ initialTokenId = null, initialSourceId = null }: { initialTokenId?: string | null; initialSourceId?: string | null } = {}) {
  const { data: tokens = [] } = useTokens()
  const { sourceId, setSourceId, signers, source } = useSourceWallet(initialSourceId)
  const planners = usePlanners()
  const fileRef = useRef<HTMLInputElement>(null)
  const [tokenId, setTokenId] = useState<string>(initialTokenId ?? NATIVE_TOKEN_ID)
  const [mode, setMode] = useState<Mode>('paste')
  const caps = useCapabilities()
  const demo = caps.mode === 'demo'
  const example = batchExample(caps.network)
  const [text, setText] = useState(demo ? example : '')
  const [manual, setManual] = useState<ManualRow[]>(() => initialManual(demo))
  const [fileNote, setFileNote] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const token = tokens.find((t) => t.id === tokenId)
  const symbol = token?.symbol ?? ''
  const decimals = tokenId === NATIVE_TOKEN_ID ? 2 : 0
  const balance = useBalance(sourceId, tokenId)
  const rawBalance = useRawBalance(sourceId, tokenId)
  const { data: holdings = [] } = useHoldings()
  // Manual rows of a batch on NearKit wallets may each name the NearKit wallet they send from
  // (never watch-only or frozen); with a single NearKit wallet there is nothing to choose.
  const nearkitPool = signers.filter(executesViaNearKit)
  const perRowSources = mode === 'manual' && source !== undefined && executesViaNearKit(source) && nearkitPool.length > 1
  const rowSourceId = (line: number) => (perRowSources ? rowSource(manual[line - 1]?.from, sourceId, nearkitPool) : sourceId)
  const walletOf = (id: string) => signers.find((w) => w.id === id)

  // Manual rows run through the same parser; blank rows become comments so line numbers map to rows.
  const input = mode === 'paste' ? text : manual.map((r) => (r.account.trim() || r.amount.trim() ? `${r.account.trim()},${r.amount.trim()}` : '#')).join('\n')
  // Amounts are validated against the token's own decimals and totalled exactly.
  const parsed = parseBatchList(input, token ? { decimals: token.decimals } : {})
  // Every wallet must hold its own share: one share (Send from) unless Manual rows name other NearKit wallets.
  const shares =
    perRowSources && token
      ? totalsBySource(
          parsed.valid.map((r) => ({ source: rowSourceId(r.line), amountText: r.amountText ?? '0' })),
          token.decimals,
        )
      : null
  const rawOf = (id: string) => BigInt(holdings.find((h) => h.walletId === id && h.tokenId === tokenId)?.raw ?? '0')
  const short = shares ? [...shares].find(([id, need]) => need > rawOf(id)) : undefined
  const over = shares ? short !== undefined : rawBalance !== null && parsed.totalRaw !== null ? parsed.totalRaw > BigInt(rawBalance) : parsed.total > balance + 1e-9
  const senders = shares && shares.size > 0 ? [...shares.keys()] : [sourceId]
  const ownShare = senders.length === 1 && senders[0] === sourceId
  const totalText = parsed.totalText ?? formatAmount(parsed.total, decimals)
  const issue =
    parsed.rows.length === 0
      ? 'Add at least one recipient'
      : parsed.valid.length === 0
        ? 'No valid lines to send'
        : parsed.invalidCount > 0
          ? `Fix ${parsed.invalidCount} invalid ${parsed.invalidCount === 1 ? 'line' : 'lines'} before sending`
          : short && token
            ? `The batch needs ${formatUnits(short[1], token.decimals, { maxFraction: 6 })} ${symbol} from ${walletOf(short[0])?.label ?? 'a wallet'}; it holds ${formatUnits(rawOf(short[0]), token.decimals, { maxFraction: 6 })}`
            : over
              ? `The batch needs ${totalText} ${symbol}; ${source?.label ?? 'the wallet'} holds ${formatAmount(balance, decimals)}`
              : null

  const rowFor = (line: number) => parsed.rows.find((r) => r.line === line)

  const onFile = async (file: File | undefined) => {
    if (!file) return
    if (file.size > 256_000) {
      setFileNote('That file is larger than 250 KB. Paste a shorter list.')
      return
    }
    const content = await file.text()
    setText(content.trim())
    setMode('paste')
    setFileNote(`Loaded ${file.name}. The file stays in your browser.`)
  }

  const summary = (
    <Lines>
      <Line label="Recipients" emphasis>
        {parsed.valid.length}
      </Line>
      <Line label="Total amount" emphasis>
        {`${totalText} ${symbol}`}
      </Line>
      <Line label="From">{ownShare ? (source?.label ?? '—') : senders.length === 1 ? (walletOf(senders[0] ?? '')?.label ?? '—') : `${senders.length} NearKit wallets`}</Line>
      <Line label="Balance after">
        {over ? <span className="text-neg">Insufficient</span> : ownShare ? `${formatAmount(balance - parsed.total, decimals)} ${symbol}` : 'Each wallet covers its lines'}
      </Line>
    </Lines>
  )

  return (
    <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-4">
        <Panel>
          <PanelHeader title="Source" />
          <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2">
            <Field label="Send from">{({ id }) => <WalletSelect id={id} value={sourceId} onChange={setSourceId} wallets={signers} />}</Field>
            <Field
              label="Token"
              aside={
                <span className="flex items-center gap-1">
                  Available <Amount value={balance} minDecimals={decimals} unit={symbol} className="text-fg-2" />
                </span>
              }
            >
              {({ id }) => <TokenSelect id={id} label="Token" size="md" value={tokenId} onChange={setTokenId} holdingsOf={[sourceId]} />}
            </Field>
          </div>
        </Panel>

        <Panel>
          <PanelHeader
            title="Recipients"
            actions={
              <span className="flex items-center gap-1 text-xs text-fg-3">
                One transfer per line <InfoTip term="batchSend" />
              </span>
            }
          />
          <div className="px-4 pt-2">
            <Tabs
              idBase="batch"
              label="Input mode"
              value={mode}
              onChange={setMode}
              tabs={[
                { value: 'paste', label: 'Paste list' },
                { value: 'manual', label: 'Manual' },
              ]}
            />
          </div>
          <div {...tabPanelProps('batch', mode)} className="p-4 outline-none">
            {mode === 'paste' ? (
              <div className="flex flex-col gap-2">
                <Textarea aria-label="Batch list" value={text} onChange={(e) => setText(e.target.value)} rows={8} spellCheck={false} placeholder={example} />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-fg-3">
                    Format <span className="num text-fg-2">account,amount</span>. Commas, tabs or spaces work; # starts a comment.
                  </p>
                  <div className="flex items-center gap-1.5">
                    <input
                      ref={fileRef}
                      type="file"
                      accept=".csv,.txt,text/csv,text/plain"
                      className="sr-only"
                      onChange={(e) => onFile(e.target.files?.[0])}
                      aria-label="Load a CSV or text file"
                    />
                    <Button size="xs" variant="ghost" icon={<FileUp size={13} />} onClick={() => fileRef.current?.click()}>
                      Load file
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => setText(example)}>
                      Example
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => setText('')} disabled={!text}>
                      Clear
                    </Button>
                  </div>
                </div>
                {fileNote && <p className="text-xs text-fg-3">{fileNote}</p>}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {manual.map((r, i) => {
                  const row = rowFor(i + 1)
                  const bad = row && row.status !== 'ok'
                  return (
                    <div key={r.id} className="flex flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2 md:flex-nowrap">
                        <span className="num w-6 shrink-0 text-xs text-fg-4">{String(i + 1).padStart(2, '0')}</span>
                        {perRowSources && (
                          <WalletSelect
                            label={`From, recipient ${i + 1}`}
                            size="sm"
                            value={rowSource(r.from, sourceId, nearkitPool)}
                            onChange={(id) => setManual((list) => list.map((m) => (m.id === r.id ? { ...m, from: id } : m)))}
                            wallets={nearkitPool}
                            className="min-w-0 flex-1 md:w-48 md:flex-none"
                          />
                        )}
                        <div className={cn('flex min-w-0 items-center gap-2', perRowSources ? 'basis-full pl-8 md:basis-auto md:flex-1 md:pl-0' : 'flex-1')}>
                          <Input
                            inputSize="sm"
                            mono
                            aria-label={`Recipient ${i + 1}`}
                            placeholder="account.near"
                            value={r.account}
                            aria-invalid={row?.status === 'invalid-account'}
                            onChange={(e) => setManual((list) => list.map((m) => (m.id === r.id ? { ...m, account: e.target.value } : m)))}
                            className="min-w-0 flex-1"
                          />
                          <AmountInput
                            aria-label={`Amount ${i + 1}`}
                            value={r.amount}
                            onValueChange={(v) => setManual((list) => list.map((m) => (m.id === r.id ? { ...m, amount: v } : m)))}
                            unit={symbol}
                            placeholder="0"
                            aria-invalid={row?.status === 'invalid-amount'}
                            size="sm"
                            className="w-36 shrink-0"
                          />
                          <IconButton label={`Remove recipient ${i + 1}`} size="sm" tone="danger" onClick={() => setManual((list) => list.filter((m) => m.id !== r.id))}>
                            <Trash2 size={14} />
                          </IconButton>
                        </div>
                      </div>
                      {bad && <p className={cn('pl-8 text-xs', row.status === 'duplicate' ? 'text-warn' : 'text-neg')}>{row.message}</p>}
                    </div>
                  )
                })}
                <div>
                  <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={() => setManual((list) => [...list, { id: (seq += 1), account: '', amount: '' }])}>
                    Add recipient
                  </Button>
                </div>
              </div>
            )}
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Preview" meta={parsed.rows.length || undefined} />
          {parsed.rows.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-sm font-medium text-fg">Nothing to preview</p>
              <p className="mt-1 text-sm text-fg-3">Paste lines like alice.near,100 or add recipients manually.</p>
            </div>
          ) : (
            <>
              <div className="hidden max-h-[26rem] overflow-y-auto md:block">
                <Table label="Batch preview">
                  <thead className="sticky top-0 z-[1] bg-panel">
                    <tr>
                      <Th className="w-16">Line</Th>
                      {perRowSources && <Th>From</Th>}
                      <Th>Recipient</Th>
                      <Th align="right">Amount</Th>
                      <Th align="right">Status</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.rows.map((row) => (
                      <Tr key={row.line} className={cn(row.status !== 'ok' && (row.status === 'duplicate' ? 'bg-warn/[0.04]' : 'bg-neg/[0.05]'))}>
                        <Td mono className="text-xs text-fg-4">
                          {row.line}
                        </Td>
                        {perRowSources && <Td className="text-xs text-fg-2">{walletOf(rowSourceId(row.line))?.label ?? '—'}</Td>}
                        <Td>
                          {row.account ? (
                            <AccountText id={row.account} className={row.status === 'invalid-account' ? 'text-neg' : 'text-fg'} />
                          ) : (
                            <span className="text-fg-4">—</span>
                          )}
                        </Td>
                        <Td align="right" mono className={row.amount !== null ? 'text-fg' : 'text-fg-4'}>
                          {row.amount !== null ? formatAmount(row.amount, decimals) : '—'}
                        </Td>
                        <Td align="right">{row.status === 'ok' ? <span className="text-xs text-fg-3">Ready</span> : <RowStatus row={row} />}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </div>
              <ul className="divide-y divide-line-soft md:hidden" aria-label="Batch preview">
                {parsed.rows.map((row) => (
                  <li key={row.line} className="flex items-start justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0">
                      <span className="num mr-2 text-xs text-fg-4">{row.line}</span>
                      {row.account ? <AccountText id={row.account} className="text-sm text-fg" /> : <span className="text-fg-4">—</span>}
                      {perRowSources && <p className="mt-0.5 text-xs text-fg-3">{`from ${walletOf(rowSourceId(row.line))?.label ?? '—'}`}</p>}
                      {row.status !== 'ok' && <p className={cn('mt-0.5 text-xs', row.status === 'duplicate' ? 'text-warn' : 'text-neg')}>{row.message}</p>}
                    </div>
                    <span className="num shrink-0 text-sm text-fg">{row.amount !== null ? formatAmount(row.amount, decimals) : '—'}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Panel>
      </div>

      <div className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-16">
        <Panel>
          <PanelHeader title="Summary" />
          <div className="flex flex-col gap-4 p-4">
            {summary}
            <div className="border-t border-line-soft pt-3">
              <Lines>
                <Line label="Invalid lines">
                  <span className={parsed.invalidCount ? 'text-neg' : ''}>{parsed.invalidCount}</span>
                </Line>
                <Line label="Duplicates skipped">
                  <span className={parsed.duplicateCount ? 'text-warn' : ''}>{parsed.duplicateCount}</span>
                </Line>
                {tokenId !== NATIVE_TOKEN_ID && (
                  <Line label={<Term term="storageDeposit">Storage deposits (max)</Term>}>{formatNumber(parsed.valid.length * STORAGE_DEPOSIT_NEAR, 2, 5)} NEAR</Line>
                )}
                <Line label={<Term term="networkFee">Network fee (est.)</Term>}>{formatNumber(parsed.valid.length * NETWORK_FEE_NEAR_PER_TX, 4, 4)} NEAR</Line>
              </Lines>
            </div>
            {issue && <p className="text-xs text-neg">{issue}</p>}
            <div className="flex flex-col gap-2">
              <Button size="lg" block variant="primary" disabled={issue !== null} onClick={() => setConfirming(true)}>
                Send batch
              </Button>
              <SimulationNote
                real={
                  source && executesViaNearKit(source)
                    ? `NearKit’s server sends each line from ${ownShare ? source.label : 'its own NearKit wallet'} (no wallet prompt), to its owner wallet or addresses approved for it.`
                    : undefined
                }
              />
            </div>
          </div>
        </Panel>
      </div>

      {confirming && source && executesViaNearKit(source) && token && (
        <NearKitSendsModal
          title="Review batch send"
          confirmLabel="Send batch"
          wallet={source}
          asset={tokenId}
          symbol={symbol}
          decimals={token.decimals}
          lines={nearkitLines(
            parsed.valid.map((r) => ({ to: r.account, amount: r.amountText ?? '', source: walletOf(rowSourceId(r.line)) ?? source })),
            source,
          )}
          onClose={() => setConfirming(false)}
        />
      )}
      {confirming && !(source && executesViaNearKit(source)) && (
        <OperationModal
          title="Review batch send"
          confirmLabel="Send batch"
          prepare={() =>
            planners.transfer({
              kind: 'batch-send',
              tokenId,
              sourceWalletId: sourceId,
              lines: parsed.valid.map((r) => ({ accountId: r.account, amount: r.amountText ?? '' })),
              skippedLines: parsed.duplicateCount,
            })
          }
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  )
}
