import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import { SimulationNote, StatusLamp } from '@/components/domain/Status'
import { TokenGlyph } from '@/components/domain/TokenGlyph'
import { TokenSelect } from '@/components/domain/TokenSelect'
import { WalletSelect } from '@/components/domain/WalletSelect'
import { Page, PageHeader, RequireWallet } from '@/components/page/Page'
import { useRuleWording } from '@/lib/modeCopy'
import { Button, IconButton } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Figures } from '@/components/ui/Figures'
import { AmountInput, Checkbox, Field, Input, Segmented } from '@/components/ui/Form'
import { InfoTip } from '@/components/ui/Help'
import { Tag } from '@/components/ui/Indicators'
import { Line, Lines, Panel, PanelHeader } from '@/components/ui/Panel'
import { Table, Td, Th, Tr } from '@/components/ui/Table'
import { useToast } from '@/components/ui/toast-context'
import { FREQUENCIES, frequencyOf, nextRun, runCount } from '@/features/automation/dca'
import { NEARKIT_FEE_BPS, NEARKIT_FEE_LABEL } from '@/lib/fees'
import { formatAmount, formatDateTime, formatNumber, formatUntil, parseAmount } from '@/lib/format'
import { useNow } from '@/lib/hooks'
import { fromLocalInput, MS, nextHour, toLocalInput } from '@/lib/time'
import { NATIVE_TOKEN_ID } from '@/config/networks'
import { useDefaultTradeToken } from '@/features/trade/useDefaultToken'
import { useAutomationMutations, useBalance, useDcaPlans, useSession, useTokens, useWallets } from '@/services/queries'
import { useInComingSoon } from '@/state/contexts'
import type { DcaFrequency } from '@/types/domain'

function Dca() {
  const toast = useToast()
  const soon = useInComingSoon()
  const wording = useRuleWording()
  const now = useNow(30_000)
  const { data: tokens = [] } = useTokens()
  const { data: wallets = [] } = useWallets()
  const plans = useDcaPlans()
  const { createDca, deleteDca } = useAutomationMutations()
  const defaultToken = useDefaultTradeToken()
  const [pickedToken, setTokenId] = useState<string | null>(null)
  const tokenId = pickedToken ?? defaultToken
  const [amountText, setAmountText] = useState('1')
  const [frequency, setFrequency] = useState<DcaFrequency>('4h')
  const [startText, setStartText] = useState(() => toLocalInput(nextHour(Date.now())))
  const [hasEnd, setHasEnd] = useState(false)
  const [endText, setEndText] = useState(() => toLocalInput(nextHour(Date.now()) + 30 * MS.day))
  const { data: session } = useSession()
  const [pickedWallet, setWalletId] = useState<string | null>(null)
  const walletId = pickedWallet ?? session?.walletId ?? wallets[0]?.id ?? ''

  const symbol = tokens.find((t) => t.id === tokenId)?.symbol ?? ''
  const freq = frequencyOf(frequency)
  const amount = parseAmount(amountText) ?? 0
  const start = fromLocalInput(startText)
  const end = hasEnd ? fromLocalInput(endText) : null
  const runs = start !== null ? runCount(start, end, freq.ms) : null
  const total = runs !== null ? runs * amount : null
  const nearBalance = useBalance(walletId, NATIVE_TOKEN_ID)
  const preview = start !== null ? Array.from({ length: 4 }, (_, i) => start + i * freq.ms).filter((t) => end === null || t <= end) : []

  let blocker: string | null = null
  if (!(amount > 0)) blocker = 'Enter a buy amount'
  else if (amount > nearBalance) blocker = 'Amount exceeds the wallet balance'
  else if (start === null) blocker = 'Pick a start date'
  else if (hasEnd && (end === null || end <= start)) blocker = 'End date must be after the start'
  const coverage =
    total !== null && total > nearBalance
      ? `The plan needs ${formatNumber(total, 2, 2)} NEAR in total; the wallet holds ${formatAmount(nearBalance, 2)}. Later runs would be skipped without a top-up.`
      : null

  return (
    <>
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_380px]">
        <Panel>
          <PanelHeader title="New DCA plan" actions={<InfoTip term="dca" />} />
          <div className="flex flex-col gap-4 p-4">
            <Field label="Token">{({ id }) => <TokenSelect id={id} label="Token" value={tokenId} onChange={setTokenId} exclude={[NATIVE_TOKEN_ID]} />}</Field>
            <Field
              label="Buy amount per run"
              aside={<span>Wallet holds {formatAmount(nearBalance, 2)} NEAR</span>}
              error={amount > nearBalance ? 'More than the wallet holds' : undefined}
            >
              {({ id, describedBy, invalid }) => (
                <AmountInput
                  id={id}
                  size="lg"
                  value={amountText}
                  onValueChange={setAmountText}
                  unit="NEAR"
                  placeholder="0.00"
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                />
              )}
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="legend">Every</span>
              <Segmented label="Frequency" block value={frequency} onChange={setFrequency} options={FREQUENCIES.map((f) => ({ value: f.value, label: f.value.toUpperCase() }))} />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Start">{({ id }) => <Input id={id} type="datetime-local" value={startText} onChange={(e) => setStartText(e.target.value)} mono />}</Field>
              <div className="flex flex-col gap-1.5">
                <Checkbox checked={hasEnd} onChange={(e) => setHasEnd(e.target.checked)} label="End date" labelClassName="legend normal-case" />
                <Input
                  type="datetime-local"
                  aria-label="End date"
                  value={endText}
                  onChange={(e) => setEndText(e.target.value)}
                  disabled={!hasEnd}
                  mono
                  aria-invalid={hasEnd && end !== null && start !== null && end <= start}
                />
              </div>
            </div>
            <Field label="Buy from">{({ id }) => <WalletSelect id={id} value={walletId} onChange={setWalletId} wallets={wallets} />}</Field>
          </div>
        </Panel>

        <Panel className="lg:sticky lg:top-16">
          <PanelHeader title="Schedule" />
          <div className="flex flex-col gap-4 p-4">
            <p className="text-md leading-6 text-fg">
              Buy <span className="num text-accent">{amount > 0 ? formatNumber(amount, 0, 4) : '—'}</span> NEAR of <span className="font-semibold">{symbol}</span>
              <br />
              {freq.words}
            </p>
            <Lines>
              <Line label="Starts">{start !== null ? formatDateTime(start) : '—'}</Line>
              <Line label="Ends">{hasEnd ? (end !== null ? formatDateTime(end) : '—') : 'Until stopped'}</Line>
              <Line label="Runs">{runs !== null ? runs : 'Open-ended'}</Line>
              <Line label="Total NEAR">{total !== null ? `${formatNumber(total, 2, 2)} NEAR` : `${formatNumber(amount, 2, 4)} NEAR per run`}</Line>
              <Line label={`NearKit fee (${NEARKIT_FEE_LABEL})`}>
                {formatNumber(((total ?? amount) * NEARKIT_FEE_BPS) / 10_000, 2, 4)} NEAR{total === null ? ' / run' : ''}
              </Line>
            </Lines>
            {preview.length > 0 && (
              <div className="border-t border-line-soft pt-3">
                <span className="legend">Next runs</span>
                <ol className="mt-2 flex flex-col gap-1">
                  {preview.map((t, i) => (
                    <li key={t} className="flex items-center justify-between text-xs">
                      <span className="num text-fg-4">#{i + 1}</span>
                      <span className="num text-fg-2">{formatDateTime(t)}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
            {coverage && <p className="text-xs text-warn">{coverage}</p>}
            <div className="flex flex-col gap-2">
              <Button
                size="lg"
                block
                variant="primary"
                disabled={blocker !== null}
                loading={createDca.isPending}
                onClick={() =>
                  start !== null &&
                  createDca.mutate(
                    { tokenId, amountNear: amount, frequency, startAt: start, endAt: end, walletId },
                    {
                      onSuccess: () =>
                        toast.push({
                          tone: 'accent',
                          title: `DCA plan saved: ${formatNumber(amount, 0, 4)} NEAR of ${symbol} ${freq.words}`,
                          detail: `${wording.saved} Nothing is scheduled or bought.`,
                        }),
                      onError: (e) => toast.push({ tone: 'neg', title: 'Plan not saved', detail: e instanceof Error ? e.message : '' }),
                    },
                  )
                }
              >
                Create DCA
              </Button>
              {blocker && !soon && <p className="text-xs text-fg-3">{blocker}</p>}
              <SimulationNote
                demo="Plans are saved in standby. Nothing is scheduled or bought."
                real="Plans are saved as drafts in this browser. Nothing is scheduled or bought: that needs a keeper service NearKit doesn't run yet."
              />
            </div>
          </div>
        </Panel>
      </div>

      <Panel>
        <PanelHeader title="Plans" meta={plans.data?.length} />
        {plans.data && plans.data.length === 0 ? (
          <EmptyState title="No DCA plans">Create a plan above; it appears here in standby.</EmptyState>
        ) : (
          <Table label="DCA plans" minWidth={780}>
            <thead>
              <tr>
                <Th>Token</Th>
                <Th align="right">Per run</Th>
                <Th>Every</Th>
                <Th>Next run</Th>
                <Th>Ends</Th>
                <Th>Wallet</Th>
                <Th>Status</Th>
                <Th align="right">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {(plans.data ?? []).map((p) => {
                const token = tokens.find((t) => t.id === p.tokenId)
                const next = nextRun(p.startAt, frequencyOf(p.frequency).ms, now, p.endAt)
                return (
                  <Tr key={p.id}>
                    <Td>
                      <span className="flex items-center gap-2">
                        <TokenGlyph symbol={token?.symbol ?? '?'} tokenId={p.tokenId} size={20} />
                        <span className="text-fg">{token?.symbol}</span>
                      </span>
                    </Td>
                    <Td align="right" mono className="text-fg">
                      {formatNumber(p.amountNear, 2, 4)} NEAR
                    </Td>
                    <Td className="text-fg-2">
                      <Figures>{frequencyOf(p.frequency).label}</Figures>
                    </Td>
                    <Td className="text-xs text-fg-2">
                      <Figures>{next ? `${formatDateTime(next)} · ${formatUntil(next, now)}` : 'Ended'}</Figures>
                    </Td>
                    <Td className="text-xs text-fg-3">
                      <Figures>{p.endAt ? formatDateTime(p.endAt) : 'Until stopped'}</Figures>
                    </Td>
                    <Td className="text-fg-2">{wallets.find((w) => w.id === p.walletId)?.label}</Td>
                    <Td>
                      <StatusLamp status={p.status} />
                    </Td>
                    <Td align="right">
                      <IconButton
                        label={`Delete ${token?.symbol ?? ''} plan`}
                        size="sm"
                        tone="danger"
                        onClick={() => deleteDca.mutate(p.id, { onSuccess: () => toast.push({ title: 'DCA plan deleted' }) })}
                      >
                        <Trash2 size={14} />
                      </IconButton>
                    </Td>
                  </Tr>
                )
              })}
            </tbody>
          </Table>
        )}
      </Panel>
    </>
  )
}

export default function DcaPage() {
  return (
    <Page>
      <PageHeader title="DCA" status={<Tag tone="neutral">Scheduler not live</Tag>} description="Buy a fixed amount on a fixed schedule instead of all at once." />
      <RequireWallet feature="DCA">
        <Dca />
      </RequireWallet>
    </Page>
  )
}
