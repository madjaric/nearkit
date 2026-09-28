import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import { AccountText } from '@/components/domain/Account'
import { SimulationNote, StatusLamp } from '@/components/domain/Status'
import { SlippageControl } from '@/components/domain/TradeControls'
import { Figures } from '@/components/ui/Figures'
import { slippageIssue } from '@/lib/slippage'
import { Page, PageHeader, RequireWallet } from '@/components/page/Page'
import { useRuleWording } from '@/lib/modeCopy'
import { Button, IconButton } from '@/components/ui/Button'
import { ChipInput } from '@/components/ui/ChipInput'
import { EmptyState } from '@/components/ui/EmptyState'
import { AmountInput, Field, Input, Segmented } from '@/components/ui/Form'
import { InfoTip } from '@/components/ui/Help'
import { Tag } from '@/components/ui/Indicators'
import { Legend, Line, Lines, Panel, PanelHeader } from '@/components/ui/Panel'
import { useToast } from '@/components/ui/toast-context'
import { NEARKIT_FEE_LABEL } from '@/lib/fees'
import { formatAgo, formatNumber, formatUsdCompact, parseAmount } from '@/lib/format'
import { useNow } from '@/lib/hooks'
import { accountIdError, isValidAccountId } from '@/lib/validation'
import { useAutomationMutations, useCopyRules } from '@/services/queries'
import type { CopyRule, CopySide } from '@/types/domain'

const SIDE_WORDS: Record<CopySide, string> = { buy: 'buys', sell: 'sells', both: 'buys and sells' }

function normalizeToken(raw: string): string | null {
  const v = raw.trim()
  if (!v) return null
  if (v.includes('.')) return isValidAccountId(v.toLowerCase()) ? v.toLowerCase() : null
  return /^\$?[a-z0-9]{2,16}$/i.test(v) ? v.replace(/^\$/, '').toUpperCase() : null
}

function describe(rule: Pick<CopyRule, 'copy' | 'sizing' | 'maxTradeNear'>): string {
  const size = rule.sizing.mode === 'fixed' ? `${formatNumber(rule.sizing.amountNear, 0, 4)} NEAR per trade` : `${formatNumber(rule.sizing.pct, 0, 2)}% of their size`
  return `Mirror ${SIDE_WORDS[rule.copy]} · ${size} · max ${formatNumber(rule.maxTradeNear, 0, 4)} NEAR`
}

function CopyTrade() {
  const toast = useToast()
  const wording = useRuleWording()
  const now = useNow(60_000)
  const rules = useCopyRules()
  const { createCopy, deleteCopy } = useAutomationMutations()
  const [target, setTarget] = useState('')
  const [copy, setCopy] = useState<CopySide>('both')
  const [sizingMode, setSizingMode] = useState<'fixed' | 'percent'>('fixed')
  const [fixedText, setFixedText] = useState('2')
  const [pctText, setPctText] = useState('25')
  const [maxText, setMaxText] = useState('10')
  const [slippage, setSlippage] = useState(3)
  const [minText, setMinText] = useState('')
  const [mcapText, setMcapText] = useState('')
  const [blacklist, setBlacklist] = useState<string[]>([])
  const [touched, setTouched] = useState(false)

  const targetError = target || touched ? accountIdError(target.trim()) : null
  const fixed = parseAmount(fixedText) ?? 0
  const pct = parseAmount(pctText) ?? 0
  const max = parseAmount(maxText) ?? 0
  const min = minText ? parseAmount(minText) : null
  const mcap = mcapText ? parseAmount(mcapText) : null
  const sizing = sizingMode === 'fixed' ? { mode: 'fixed' as const, amountNear: fixed } : { mode: 'percent' as const, pct }

  let blocker: string | null = null
  if (accountIdError(target.trim())) blocker = 'Enter a target wallet'
  else if (sizingMode === 'fixed' ? !(fixed > 0) : !(pct > 0 && pct <= 100)) blocker = 'Set a trade size'
  else if (!(max > 0)) blocker = 'Set a maximum trade'
  else if (sizingMode === 'fixed' && fixed > max) blocker = 'Fixed size is above the maximum'
  else if (min !== null && min > max) blocker = 'Minimum is above the maximum'
  else if (slippageIssue(slippage)?.level === 'error') blocker = 'Check slippage'

  const submit = () => {
    setTouched(true)
    if (blocker) return
    createCopy.mutate(
      { target: target.trim(), copy, sizing, maxTradeNear: max, slippagePct: slippage, minTradeNear: min, maxMarketCapUsd: mcap, blacklist },
      {
        onSuccess: () => {
          toast.push({ tone: 'accent', title: `Copy rule saved for ${target.trim()}`, detail: `${wording.saved} No wallet is monitored.` })
          setTarget('')
          setTouched(false)
        },
        onError: (e) => toast.push({ tone: 'neg', title: 'Rule not saved', detail: e instanceof Error ? e.message : '' }),
      },
    )
  }

  return (
    <>
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_380px]">
        <Panel>
          <PanelHeader title="New copy rule" actions={<InfoTip term="copyTrade" />} />
          <div className="flex flex-col gap-4 p-4">
            <Field label="Target wallet" error={targetError ?? undefined} hint="The NEAR account whose trades you want to mirror">
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  mono
                  placeholder="trader.near"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  onBlur={() => setTouched(true)}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  spellCheck={false}
                  autoComplete="off"
                />
              )}
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="legend">Copy</span>
              <Segmented
                label="Copy"
                block
                value={copy}
                onChange={setCopy}
                options={[
                  { value: 'buy', label: 'Buy', tone: 'buy' },
                  { value: 'sell', label: 'Sell', tone: 'sell' },
                  { value: 'both', label: 'Both' },
                ]}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="legend">Sizing</span>
              <Segmented
                label="Sizing"
                block
                value={sizingMode}
                onChange={setSizingMode}
                options={[
                  { value: 'fixed', label: 'Fixed NEAR' },
                  { value: 'percent', label: 'Percentage' },
                ]}
              />
              {sizingMode === 'fixed' ? (
                <AmountInput aria-label="Fixed size per trade" value={fixedText} onValueChange={setFixedText} unit="NEAR / trade" placeholder="0" />
              ) : (
                <AmountInput
                  aria-label="Percentage of the target's trade"
                  value={pctText}
                  onValueChange={setPctText}
                  unit="% of their size"
                  placeholder="0"
                  aria-invalid={pct > 100}
                />
              )}
            </div>
            <Field label="Maximum trade">{({ id }) => <AmountInput id={id} value={maxText} onValueChange={setMaxText} unit="NEAR" placeholder="0" />}</Field>
            <SlippageControl value={slippage} onChange={setSlippage} />

            <Legend className="pt-1">Filters · optional</Legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Minimum trade">{({ id }) => <AmountInput id={id} value={minText} onValueChange={setMinText} unit="NEAR" placeholder="None" />}</Field>
              <Field label="Maximum market cap">{({ id }) => <AmountInput id={id} value={mcapText} onValueChange={setMcapText} unit="USD" placeholder="None" />}</Field>
            </div>
            <Field label="Token blacklist" hint="Never copy trades in these tokens. Enter a symbol or contract, then press Enter.">
              {({ id }) => (
                <ChipInput id={id} label="Token blacklist" value={blacklist} onChange={setBlacklist} placeholder="SHITZU, token.example.near" normalize={normalizeToken} />
              )}
            </Field>
          </div>
        </Panel>

        <Panel className="lg:sticky lg:top-16">
          <PanelHeader title="Rule" />
          <div className="flex flex-col gap-4 p-4">
            <p className="text-md leading-6 text-fg">
              Mirror <span className="font-semibold">{SIDE_WORDS[copy]}</span> from{' '}
              {target.trim() ? <span className="num text-accent">{target.trim()}</span> : <span className="text-fg-3">the target wallet</span>}
            </p>
            <Lines>
              <Line label="Size">{sizingMode === 'fixed' ? `${formatNumber(fixed, 0, 4)} NEAR per trade` : `${formatNumber(pct, 0, 2)}% of their trade`}</Line>
              <Line label="Maximum">{max > 0 ? `${formatNumber(max, 0, 4)} NEAR` : '—'}</Line>
              <Line label="Minimum">{min ? `${formatNumber(min, 0, 4)} NEAR` : 'None'}</Line>
              <Line label="Max market cap">{mcap ? formatUsdCompact(mcap) : 'None'}</Line>
              <Line label="Blacklist">{blacklist.length ? `${blacklist.length} tokens` : 'None'}</Line>
              <Line label="Slippage">{formatNumber(slippage, 0, 2)}%</Line>
              <Line label={`NearKit fee (${NEARKIT_FEE_LABEL})`}>per copied trade</Line>
            </Lines>
            <div className="flex flex-col gap-2">
              <Button size="lg" block variant="primary" disabled={blocker !== null && touched} loading={createCopy.isPending} onClick={submit}>
                Create copy rule
              </Button>
              {touched && blocker && <p className="text-xs text-neg">{blocker}</p>}
              <SimulationNote
                demo="Rules are saved in standby. No wallet is monitored."
                real="Rules are saved as drafts in this browser. No wallet is monitored and nothing is copied: that needs a keeper service NearKit doesn't run yet."
              />
            </div>
          </div>
        </Panel>
      </div>

      <Panel>
        <PanelHeader title="Copy rules" meta={rules.data?.length} />
        {rules.data && rules.data.length === 0 ? (
          <EmptyState title="No copy rules yet">Add a target wallet above. Saved rules wait here in standby until monitoring goes live.</EmptyState>
        ) : (
          <ul className="divide-y divide-line-soft">
            {(rules.data ?? []).map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <AccountText id={r.target} className="text-sm text-fg" />
                  <p className="text-xs text-fg-3">{describe(r)}</p>
                  {r.blacklist.length > 0 && (
                    <p className="mt-1 flex flex-wrap gap-1">
                      {r.blacklist.map((b) => (
                        <Tag key={b}>{b}</Tag>
                      ))}
                    </p>
                  )}
                </div>
                <span className="text-xs text-fg-3">
                  <Figures>{`Saved ${formatAgo(r.createdAt, now)}`}</Figures>
                </span>
                <StatusLamp status={r.status} />
                <IconButton
                  label={`Delete rule for ${r.target}`}
                  size="sm"
                  tone="danger"
                  onClick={() => deleteCopy.mutate(r.id, { onSuccess: () => toast.push({ title: 'Copy rule deleted' }) })}
                >
                  <Trash2 size={14} />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  )
}

export default function CopyTradePage() {
  return (
    <Page>
      <PageHeader
        title="Copy Trade"
        status={<Tag tone="neutral">Monitoring not live</Tag>}
        description="Mirror another wallet's trades with your own sizing, limits and filters."
      />
      <RequireWallet feature="Copy Trade">
        <CopyTrade />
      </RequireWallet>
    </Page>
  )
}
