import { Plus, Trash2, Upload } from 'lucide-react'
import { useState } from 'react'
import { AllocationBar } from '@/components/domain/AllocationBar'
import { SimulationNote } from '@/components/domain/Status'
import { PercentKeys } from '@/components/domain/TradeControls'
import { TokenSelect } from '@/components/domain/TokenSelect'
import { RecipientSelect } from '@/components/domain/RecipientSelect'
import { WalletSelect } from '@/components/domain/WalletSelect'
import { Button, IconButton } from '@/components/ui/Button'
import { Figures } from '@/components/ui/Figures'
import { AmountInput, Field, Segmented } from '@/components/ui/Form'
import { InfoTip, Term } from '@/components/ui/Help'
import { Amount } from '@/components/ui/Num'
import { Line, Lines, Panel, PanelHeader } from '@/components/ui/Panel'
import { NATIVE_TOKEN_ID } from '@/config/networks'
import { executesViaNearKit } from '@/lib/wallets'
import { amountsFromPercents, equalPercents, percentState, sumOf } from '@/lib/allocation'
import { formatUnits, fractionOf, parsePercent, PERCENT_SCALE, splitByWeights, splitEqual, tryParseUnits } from '@/lib/amounts'
import { cn } from '@/lib/cn'
import { NETWORK_FEE_NEAR_PER_TX, STORAGE_DEPOSIT_NEAR } from '@/lib/fees'
import { maxNearSendYocto } from '@/services/near/gas'
import { floorTo, formatAmount, formatNumber, parseAmount, toInputString } from '@/lib/format'
import { nextTarget, recipientAccount, takenBy, type RecipientTarget } from '@/lib/recipientTarget'
import { accountIdError } from '@/lib/validation'
import { useBalance, useCapabilities, usePlanners, useRawBalance, useTokens } from '@/services/queries'
import type { Wallet } from '@/types/domain'
import { NearKitSendsModal } from '../tools/NearKitSendsModal'
import { OperationModal } from '../tools/OperationModal'
import { useSourceWallet } from '../tools/useSource'
import { ImportRecipients, type ImportedRow } from './ImportRecipients'

export type Recipient = { id: string; pct: string } & RecipientTarget

let seq = 10
const rid = () => `r${(seq += 1)}`

const SEED: Recipient[] = [
  { id: 'r1', kind: 'wallet', walletId: 'w02', pct: '25' },
  { id: 'r2', kind: 'wallet', walletId: 'w03', pct: '25' },
  { id: 'r3', kind: 'wallet', walletId: 'w04', pct: '20' },
  { id: 'r4', kind: 'wallet', walletId: 'w05', pct: '15' },
  { id: 'r5', kind: 'wallet', walletId: 'w06', pct: '15' },
]

/** The brief's demo example (25/25/20/15/15) when the demo wallets exist; two empty external rows otherwise. */
function initialRows(walletIds: Set<string>): Recipient[] {
  if (SEED.every((r) => r.kind === 'wallet' && walletIds.has(r.walletId))) return SEED
  return [
    { id: rid(), kind: 'account', accountId: '', pct: '50' },
    { id: rid(), kind: 'account', accountId: '', pct: '50' },
  ]
}

export function Split() {
  const caps = useCapabilities()
  const { data: tokens = [] } = useTokens()
  const { sourceId, setSourceId, signers, wallets, source } = useSourceWallet()
  const planners = usePlanners()
  const [pickedToken, setTokenId] = useState<string | null>(null)
  const [amountText, setAmountText] = useState(caps.mode === 'demo' ? '1000000' : '')
  const [mode, setMode] = useState<'equal' | 'custom'>('custom')
  const [pickedRows, setRows] = useState<Recipient[] | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const rows = pickedRows ?? initialRows(new Set(wallets.map((w) => w.id)))
  const tokenId = pickedToken ?? (tokens.some((t) => t.id === 'kit') ? 'kit' : (tokens.find((t) => !t.isNative)?.id ?? NATIVE_TOKEN_ID))
  const token = tokens.find((t) => t.id === tokenId)
  const symbol = token?.symbol ?? ''
  const balance = useBalance(sourceId, tokenId)
  const rawBalance = useRawBalance(sourceId, tokenId)
  const amount = parseAmount(amountText) ?? 0
  const decimals = tokenId === NATIVE_TOKEN_ID ? 4 : 2
  const exactTotal = token ? tryParseUnits(amountText, token.decimals) : null

  const accountOf = (r: Recipient) => recipientAccount(r, wallets)
  const percents = mode === 'equal' ? equalPercents(rows.length) : rows.map((r) => parseAmount(r.pct) ?? Number.NaN)
  const safePercents = percents.map((p) => (Number.isFinite(p) ? p : 0))
  const amounts = amountsFromPercents(amount, safePercents, 6)
  // Percentages are exact to 4 decimals (100% = 1,000,000 units), so "balanced" means exactly 100%.
  const weights = rows.map((r) => {
    try {
      return parsePercent(r.pct)
    } catch {
      return null
    }
  })
  const pctExact = weights.every((w) => w !== null) ? weights.reduce<bigint>((s, w) => s + (w ?? 0n), 0n) : null
  const state =
    mode === 'equal'
      ? rows.length
        ? 'balanced'
        : 'empty'
      : pctExact === null
        ? percentState(percents)
        : pctExact === PERCENT_SCALE
          ? 'balanced'
          : pctExact === 0n
            ? 'empty'
            : pctExact < PERCENT_SCALE
              ? 'under'
              : 'over'
  const pctTotal = sumOf(safePercents)

  // Exact per-recipient amounts in the token's own decimals. Every raw unit is handed out:
  // leftover smallest units go to the rows with the largest remainders (first row on ties).
  const totalRaw = exactTotal?.ok && exactTotal.value > 0n ? exactTotal.value : null
  const rawParts =
    token && totalRaw !== null && rows.length > 0 && state === 'balanced'
      ? mode === 'equal'
        ? splitEqual(totalRaw, rows.length)
        : splitByWeights(
            totalRaw,
            weights.map((w) => w ?? 0n),
          )
      : null
  const exactAmounts = token && rawParts ? rawParts.map((part) => formatUnits(part, token.decimals)) : null
  const remainderUsed =
    totalRaw !== null && rawParts !== null && (mode === 'equal' ? totalRaw % BigInt(rows.length) !== 0n : weights.some((w) => w !== null && (totalRaw * w) % PERCENT_SCALE !== 0n))
  const shownAmount = (i: number) => exactAmounts?.[i] ?? formatAmount(amounts[i] ?? 0)
  // 25/50/75/MAX on the exact balance when it is known. NEAR keeps back exactly the gas each
  // recipient's transfer holds (src/services/near/gas.ts), nothing more: what stays is dust.
  const recipientIds = rows.map((r) => {
    const a = accountOf(r)
    return a && accountIdError(a) === null ? a : undefined
  })
  const nearHoldRaw = tokenId === NATIVE_TOKEN_ID ? 10n ** 24n - maxNearSendYocto(10n ** 24n, recipientIds) : 0n
  const spendableRaw = rawBalance !== null && token ? (tokenId === NATIVE_TOKEN_ID ? maxNearSendYocto(BigInt(rawBalance), recipientIds) : BigInt(rawBalance)) : null
  const presetText = (f: number) =>
    spendableRaw !== null && token
      ? formatUnits(fractionOf(spendableRaw > 0n ? spendableRaw : 0n, Math.round(f * 100), 100), token.decimals)
      : toInputString(floorTo(Math.max(0, balance - Number(formatUnits(nearHoldRaw, 24))) * f, decimals), decimals)

  const rowError = (r: Recipient, index: number): string | null => {
    const account = accountOf(r)
    if (r.kind === 'account') {
      const err = accountIdError(account)
      if (err) return err
    }
    if (source && account === source.accountId) return 'The source wallet cannot receive its own split'
    if (rows.slice(0, index).some((o) => accountOf(o) === account)) return 'Duplicate recipient'
    if (mode === 'custom') {
      const p = parseAmount(r.pct)
      if (p === null || p <= 0) return 'Enter a percentage above 0'
      if (weights[index] === null) return 'Use at most 4 decimals in a percentage'
    }
    return null
  }
  const rowErrors = rows.map(rowError)
  const badRows = rowErrors.filter(Boolean).length

  const issues: string[] = []
  const exceeds = rawBalance !== null && totalRaw !== null ? totalRaw > BigInt(rawBalance) : amount > balance + 1e-9
  if (!(amount > 0)) issues.push('Enter an amount to distribute')
  else if (exactTotal && !exactTotal.ok) issues.push(exactTotal.error.message)
  else if (exceeds) issues.push(`Amount exceeds the available ${formatAmount(balance)} ${symbol} in ${source?.label ?? 'this wallet'}`)
  if (rows.length === 0) issues.push('Add at least one recipient')
  if (mode === 'custom' && rows.length > 0 && state !== 'balanced') issues.push(`Percentages add up to ${formatNumber(pctTotal, 2, 2)}%. They must total exactly 100%.`)
  if (badRows > 0) issues.push(`${badRows} recipient ${badRows === 1 ? 'row needs' : 'rows need'} attention`)

  const update = (id: string, patch: Partial<Recipient> | ((r: Recipient) => Recipient)) =>
    setRows((list) => (list ?? rows).map((r) => (r.id === id ? (typeof patch === 'function' ? patch(r) : ({ ...r, ...patch } as Recipient)) : r)))

  const applyImport = (imported: ImportedRow[], withPercents: boolean) => {
    const own = new Map(wallets.map((w) => [w.accountId, w.id]))
    setRows(
      imported.map((row) => {
        const walletId = own.get(row.account)
        const pct = row.pct !== null ? toInputString(row.pct, 2) : ''
        return walletId ? { id: rid(), kind: 'wallet', walletId, pct } : { id: rid(), kind: 'account', accountId: row.account, pct }
      }),
    )
    setMode(withPercents ? 'custom' : 'equal')
    setImportOpen(false)
  }

  const recipientControl = (r: Recipient, index: number, compact = false) => (
    <RecipientSelect
      index={index}
      target={r}
      onChange={(t) => update(r.id, (cur) => ({ id: cur.id, pct: cur.pct, ...t }))}
      wallets={wallets}
      exclude={takenBy(sourceId, rows, r.id)}
      invalid={Boolean(rowErrors[index])}
      compact={compact}
    />
  )

  const summary = (
    <Lines>
      <Line label="Distributing" emphasis>
        {formatAmount(amount)} {symbol}
      </Line>
      <Line label="From">{source ? `${source.label}` : '—'}</Line>
      <Line label="Recipients">{rows.length}</Line>
      <Line label="Balance after">{amount > 0 && amount <= balance ? `${formatAmount(balance - amount)} ${symbol}` : '—'}</Line>
    </Lines>
  )

  return (
    <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-4">
        <Panel>
          <PanelHeader title="Source" />
          <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2">
            <Field label="Source wallet">{({ id }) => <WalletSelect id={id} value={sourceId} onChange={setSourceId} wallets={signers} />}</Field>
            <Field label="Token">{({ id }) => <TokenSelect id={id} label="Token" value={tokenId} onChange={setTokenId} holdingsOf={[sourceId]} size="md" />}</Field>
            <div className="flex flex-col gap-2 md:col-span-2">
              <Field
                label="Amount to distribute"
                aside={
                  <span className="flex items-center gap-1">
                    Available <Amount value={balance} unit={symbol} className="text-fg-2" />
                  </span>
                }
                error={amount > balance + 1e-9 ? `Exceeds the available ${formatAmount(balance)} ${symbol}` : undefined}
              >
                {({ id, describedBy, invalid }) => (
                  <AmountInput
                    id={id}
                    size="lg"
                    value={amountText}
                    onValueChange={setAmountText}
                    unit={symbol}
                    placeholder="0"
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                  />
                )}
              </Field>
              <PercentKeys
                disabled={balance <= 0}
                active={amount > 0 && balance > 0 ? ([0.25, 0.5, 0.75, 1].find((f) => presetText(f) === amountText) ?? null) : null}
                onPick={(f) => setAmountText(presetText(f))}
              />
            </div>
          </div>
        </Panel>

        <Panel>
          <PanelHeader
            title="Recipients"
            meta={rows.length}
            actions={
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Plus size={14} />}
                  onClick={() => setRows((list) => [...(list ?? rows), { id: rid(), pct: '', ...nextTarget(sourceId, rows, wallets) }])}
                >
                  Add wallet
                </Button>
                <Button size="sm" variant="secondary" icon={<Upload size={14} />} onClick={() => setImportOpen(true)}>
                  Import list
                </Button>
              </>
            }
          />
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-4 py-2.5">
            <span className="legend flex items-center gap-1.5">
              Distribution <InfoTip term="split" />
            </span>
            <Segmented
              label="Distribution"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'equal', label: 'Equal split' },
                { value: 'custom', label: 'Custom %' },
              ]}
            />
          </div>

          {rows.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-sm font-medium text-fg">No recipients yet</p>
              <p className="mt-1 text-sm text-fg-3">Add your own wallets, paste a list, or load a preset with Import list.</p>
            </div>
          ) : (
            <>
              <div className="hidden md:block">
                <table className="w-full border-collapse text-sm" aria-label="Recipients">
                  <thead>
                    <tr className="border-b border-line">
                      <th className="legend h-9 w-10 pl-4 text-left font-normal">#</th>
                      <th className="legend px-3 text-left font-normal">Recipient</th>
                      <th className="legend w-32 px-3 text-right font-normal">Percentage</th>
                      <th className="legend w-44 px-3 text-right font-normal">Amount</th>
                      <th className="w-12 pr-4">
                        <span className="sr-only">Remove</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => {
                      const err = rowErrors[i]
                      return (
                        <tr key={r.id} className={cn('border-b border-line-soft align-top last:border-b-0', err && 'bg-neg/[0.04]')}>
                          <td className="num pl-4 pt-3.5 text-xs text-fg-4">{String(i + 1).padStart(2, '0')}</td>
                          <td className="px-3 py-2">
                            {recipientControl(r, i)}
                            {err && <p className="mt-1 text-xs text-neg">{err}</p>}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {mode === 'custom' ? (
                              <AmountInput
                                aria-label={`Recipient ${i + 1} percentage`}
                                value={r.pct}
                                onValueChange={(v) => update(r.id, { pct: v })}
                                unit="%"
                                placeholder="0"
                                size="sm"
                                className="ml-auto w-28"
                                aria-invalid={mode === 'custom' && (parseAmount(r.pct) ?? 0) <= 0}
                              />
                            ) : (
                              <span className="num inline-block pt-1.5 text-fg-2">{formatNumber(percents[i] ?? 0, 2, 2)}%</span>
                            )}
                          </td>
                          <td className="num px-3 pt-3.5 text-right text-fg">
                            {shownAmount(i)} <span className="font-sans text-xs text-fg-3">{symbol}</span>
                          </td>
                          <td className="pr-4 pt-2 text-right">
                            <IconButton label={`Remove recipient ${i + 1}`} size="sm" tone="danger" onClick={() => setRows((list) => (list ?? rows).filter((o) => o.id !== r.id))}>
                              <Trash2 size={14} />
                            </IconButton>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-line">
                      <td />
                      <td className="legend px-3 py-3">Total</td>
                      <td className={cn('num px-3 py-3 text-right', state === 'balanced' ? 'text-accent' : state === 'under' ? 'text-warn' : 'text-neg')}>
                        {formatNumber(pctTotal, 2, 2)}%
                      </td>
                      <td className="num px-3 py-3 text-right text-fg">
                        {formatAmount(sumOf(amounts))} <span className="font-sans text-xs text-fg-3">{symbol}</span>
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>

              <ul className="divide-y divide-line-soft md:hidden" aria-label="Recipients">
                {rows.map((r, i) => {
                  const err = rowErrors[i]
                  return (
                    <li key={r.id} className={cn('flex flex-col gap-2 px-4 py-3', err && 'bg-neg/[0.04]')}>
                      <div className="flex items-center justify-between">
                        <span className="legend">Recipient {String(i + 1).padStart(2, '0')}</span>
                        <IconButton label={`Remove recipient ${i + 1}`} size="sm" tone="danger" onClick={() => setRows((list) => (list ?? rows).filter((o) => o.id !== r.id))}>
                          <Trash2 size={14} />
                        </IconButton>
                      </div>
                      {recipientControl(r, i, true)}
                      {err && <p className="text-xs text-neg">{err}</p>}
                      <div className="flex items-center justify-between gap-3">
                        {mode === 'custom' ? (
                          <AmountInput
                            aria-label={`Recipient ${i + 1} percentage`}
                            value={r.pct}
                            onValueChange={(v) => update(r.id, { pct: v })}
                            unit="%"
                            placeholder="0"
                            size="sm"
                            className="w-28"
                          />
                        ) : (
                          <span className="num text-sm text-fg-2">{formatNumber(percents[i] ?? 0, 2, 2)}%</span>
                        )}
                        <span className="num text-sm text-fg">
                          {shownAmount(i)} <span className="font-sans text-xs text-fg-3">{symbol}</span>
                        </span>
                      </div>
                    </li>
                  )
                })}
                <li className="flex items-center justify-between px-4 py-3">
                  <span className="legend">Total</span>
                  <span className={cn('num text-sm', state === 'balanced' ? 'text-accent' : state === 'under' ? 'text-warn' : 'text-neg')}>{formatNumber(pctTotal, 2, 2)}%</span>
                </li>
              </ul>
            </>
          )}

          <div className="border-t border-line-soft px-4 py-3">
            <AllocationBar
              segments={rows.map((r, i) => ({
                key: r.id,
                label: r.kind === 'wallet' ? (wallets.find((w) => w.id === r.walletId)?.label ?? '') : r.accountId || `Recipient ${i + 1}`,
                value: safePercents[i] ?? 0,
              }))}
              budget={100}
              state={state}
              unit="%"
              summary={`${formatNumber(pctTotal, 2, 2)}% of 100%`}
            />
          </div>
        </Panel>
      </div>

      <div className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-16">
        <Panel>
          <PanelHeader title="Summary" />
          <div className="flex flex-col gap-4 p-4">
            {summary}
            {remainderUsed && token && (
              <p className="text-xs text-fg-3">
                <Figures>{`Amounts are exact to ${token.decimals} decimals. Smallest units that don't divide evenly go one each to the rows with the largest remainders (the first row on ties), so the total is kept exactly.`}</Figures>
              </p>
            )}
            <div className="border-t border-line-soft pt-3">
              <Lines>
                <Line label="Transfers">{`${rows.length} × ${tokenId === NATIVE_TOKEN_ID ? 'Transfer' : 'ft_transfer'}`}</Line>
                <Line label={<Term term="storageDeposit">Storage deposits (max)</Term>}>{formatNumber(rows.length * STORAGE_DEPOSIT_NEAR, 2, 5)} NEAR</Line>
                <Line label={<Term term="networkFee">Network fee (est.)</Term>}>{formatNumber(rows.length * NETWORK_FEE_NEAR_PER_TX, 4, 4)} NEAR</Line>
              </Lines>
            </div>
            {issues.length > 0 && (
              <ul className="flex flex-col gap-1.5 rounded-sm border border-line-soft bg-well/50 px-3 py-2.5" aria-live="polite">
                {issues.map((issue) => (
                  <li key={issue} className="flex gap-2 text-xs text-neg">
                    <span aria-hidden="true" className="mt-[5px] size-1.5 shrink-0 rounded-[1px] bg-neg" />
                    {issue}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-col gap-2">
              <Button size="lg" block variant="primary" disabled={issues.length > 0} onClick={() => setConfirming(true)}>
                Split tokens
              </Button>
              <SimulationNote
                real={
                  source && executesViaNearKit(source)
                    ? `NEARKITS’ server sends each line from ${source.label} (no wallet prompt), to its owner wallet, your other NEARKITS wallets under the same owner, or addresses approved for it.`
                    : undefined
                }
              />
            </div>
          </div>
        </Panel>
      </div>

      <ImportRecipients open={importOpen} onClose={() => setImportOpen(false)} onImport={applyImport} wallets={wallets} sourceId={sourceId} />

      {confirming && exactAmounts && source && executesViaNearKit(source) && token && (
        <NearKitSendsModal
          title="Review split"
          confirmLabel="Split tokens"
          wallet={source}
          asset={tokenId}
          symbol={symbol}
          decimals={token.decimals}
          lines={rows.map((r, i) => ({ to: accountOf(r), amount: exactAmounts[i] ?? '', label: labelFor(r, wallets) }))}
          onClose={() => setConfirming(false)}
        />
      )}
      {confirming && exactAmounts && !(source && executesViaNearKit(source)) && (
        <OperationModal
          title="Review split"
          confirmLabel="Split tokens"
          prepare={() =>
            planners.transfer({
              kind: 'split',
              tokenId,
              sourceWalletId: sourceId,
              lines: rows.map((r, i) => ({ accountId: accountOf(r), label: labelFor(r, wallets), amount: exactAmounts[i] ?? '' })),
            })
          }
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  )
}

function labelFor(r: Recipient, wallets: Wallet[]): string {
  if (r.kind === 'wallet') return wallets.find((w) => w.id === r.walletId)?.label ?? r.walletId
  return r.accountId
}
