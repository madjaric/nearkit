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
import { EmptyState } from '@/components/ui/EmptyState'
import { Tip } from '@/components/ui/Floating'
import { AmountInput, Field, Input, Segmented, Select } from '@/components/ui/Form'
import { InfoTip, Term } from '@/components/ui/Help'
import { ComingSoon, Tag } from '@/components/ui/Indicators'
import { Legend, Line, Lines, Panel, PanelHeader } from '@/components/ui/Panel'
import { useToast } from '@/components/ui/toast-context'
import { GAS_RESERVE_NEAR, NEARKIT_FEE_BPS, NEARKIT_FEE_LABEL, NETWORK_FEE_NEAR_PER_TX } from '@/lib/fees'
import { formatAgo, formatDateTime, formatNumber, formatUsdCompact, parseAmount } from '@/lib/format'
import { useNow } from '@/lib/hooks'
import { fromLocalInput, nextHour, toLocalInput } from '@/lib/time'
import { accountIdError } from '@/lib/validation'
import { useAutomationMutations, useHoldings, usePresets, useSniperConfigs, useWallets } from '@/services/queries'
import type { SniperPriority, SniperTrigger } from '@/types/domain'

const TRIGGER_WORDS: Record<SniperTrigger, string> = { 'liquidity-added': 'when liquidity is added', 'first-trade': 'on the first trade', 'at-time': 'at the set time' }
const PRIORITY_NOTE: Record<SniperPriority, string> = {
  standard: 'Submit once through the default route.',
  fast: 'Submit through a low-latency route and retry quickly.',
  max: 'Submit through every available route at once.',
}

function targetIssue(raw: string): string | null {
  const v = raw.trim()
  if (!v) return 'Enter a token contract or symbol'
  if (v.includes('.')) return accountIdError(v)
  return /^\$?[a-z0-9]{2,16}$/i.test(v) ? null : 'Use a symbol (letters and digits) or a .near contract'
}

function Sniper() {
  const toast = useToast()
  const wording = useRuleWording()
  const now = useNow(60_000)
  const { data: presets = [], isPending: presetsLoading } = usePresets()
  const { data: holdings = [] } = useHoldings()
  const { data: wallets = [] } = useWallets()
  const configs = useSniperConfigs()
  const { createSniper, deleteSniper } = useAutomationMutations()
  const [target, setTarget] = useState('')
  const [presetId, setPresetId] = useState('preset-snipers')
  const [amountText, setAmountText] = useState('0.5')
  const [slippage, setSlippage] = useState(5)
  const [trigger, setTrigger] = useState<SniperTrigger>('liquidity-added')
  const [atText, setAtText] = useState(() => toLocalInput(nextHour(Date.now()) + 3_600_000))
  const [priority, setPriority] = useState<SniperPriority>('fast')
  const [gas, setGas] = useState('100')
  const [retries, setRetries] = useState('2')
  const [mcapText, setMcapText] = useState('')
  const [liqText, setLiqText] = useState('')
  const [tpText, setTpText] = useState('')
  const [slText, setSlText] = useState('')
  const [touched, setTouched] = useState(false)

  const preset = presets.find((p) => p.id === presetId)
  const presetWallets = wallets.filter((w) => preset?.walletIds.includes(w.id))
  const amount = parseAmount(amountText) ?? 0
  const near = (walletId: string) => holdings.find((h) => h.walletId === walletId && h.tokenId === 'near')?.amount ?? 0
  const short = presetWallets.filter((w) => near(w.id) - GAS_RESERVE_NEAR < amount)
  const funded = presetWallets.length - short.length
  const total = amount * funded
  const at = trigger === 'at-time' ? fromLocalInput(atText) : null
  const tIssue = targetIssue(target)

  let blocker: string | null = null
  if (tIssue) blocker = 'Enter a target token'
  else if (!preset) blocker = 'Choose a wallet preset'
  else if (!(amount > 0)) blocker = 'Set a buy amount'
  else if (funded === 0) blocker = 'No wallet in this preset can cover the amount'
  else if (trigger === 'at-time' && (at === null || at <= now)) blocker = 'Pick a launch time in the future'
  else if (slippageIssue(slippage)?.level === 'error') blocker = 'Check slippage'

  const save = () => {
    setTouched(true)
    if (blocker) return
    createSniper.mutate(
      {
        target: target.trim(),
        presetId,
        amountNearPerWallet: amount,
        slippagePct: slippage,
        trigger,
        triggerAt: at,
        priority,
        gasTgas: Number(gas),
        retries: Number(retries),
        maxMarketCapUsd: mcapText ? parseAmount(mcapText) : null,
        minLiquidityUsd: liqText ? parseAmount(liqText) : null,
        takeProfitPct: tpText ? parseAmount(tpText) : null,
        stopLossPct: slText ? parseAmount(slText) : null,
      },
      {
        onSuccess: () => {
          toast.push({ tone: 'accent', title: `Sniper config saved for ${target.trim()}`, detail: `${wording.saved} Not armed: nothing watches launches.` })
          setTouched(false)
        },
        onError: (e) => toast.push({ tone: 'neg', title: 'Config not saved', detail: e instanceof Error ? e.message : '' }),
      },
    )
  }

  return (
    <>
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_380px]">
        <Panel>
          <PanelHeader title="Sniper setup" actions={<InfoTip term="sniper" />} />
          <div className="flex flex-col gap-4 p-4">
            <Legend>Target</Legend>
            <Field label="Token contract or symbol" error={touched || target ? (tIssue ?? undefined) : undefined}>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  mono
                  placeholder="launch.token.near"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  spellCheck={false}
                  autoComplete="off"
                />
              )}
            </Field>

            <Legend>Wallets</Legend>
            <Field
              label={<Term term="preset">Wallet preset</Term>}
              hint={
                preset
                  ? `${presetWallets.length} wallets · ${formatNumber(
                      presetWallets.reduce((s, w) => s + near(w.id), 0),
                      2,
                      2,
                    )} NEAR available`
                  : undefined
              }
            >
              {({ id, describedBy }) => (
                <Select id={id} value={presetId} onChange={(e) => setPresetId(e.target.value)} aria-describedby={describedBy}>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.walletIds.length} wallets
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <Legend>Buy</Legend>
            <Field
              label="Amount per wallet"
              warning={
                short.length > 0 && amount > 0
                  ? `${short.length} of ${presetWallets.length} wallets can't cover ${formatNumber(amount, 0, 4)} NEAR plus gas and will be skipped`
                  : undefined
              }
            >
              {({ id, describedBy }) => (
                <AmountInput id={id} size="lg" value={amountText} onValueChange={setAmountText} unit="NEAR" placeholder="0.00" aria-describedby={describedBy} />
              )}
            </Field>
            <SlippageControl value={slippage} onChange={setSlippage} />

            <Legend>Trigger</Legend>
            <Segmented
              label="Trigger"
              block
              value={trigger}
              onChange={setTrigger}
              options={[
                { value: 'liquidity-added', label: 'Liquidity added' },
                { value: 'first-trade', label: 'First trade' },
                { value: 'at-time', label: 'At a time' },
              ]}
            />
            {trigger === 'at-time' && (
              <Field label="Launch time">{({ id }) => <Input id={id} type="datetime-local" mono value={atText} onChange={(e) => setAtText(e.target.value)} />}</Field>
            )}

            <Legend>Execution</Legend>
            <div className="flex flex-col gap-1.5">
              <span className="legend flex items-center gap-1.5">
                Priority <InfoTip term="priority" />
              </span>
              <Segmented
                label="Execution priority"
                block
                value={priority}
                onChange={setPriority}
                options={[
                  { value: 'standard', label: 'Standard' },
                  { value: 'fast', label: 'Fast' },
                  { value: 'max', label: 'Max' },
                ]}
              />
              <p className="text-xs text-fg-3">{PRIORITY_NOTE[priority]}</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Gas attached">
                {({ id }) => (
                  <Select id={id} value={gas} onChange={(e) => setGas(e.target.value)}>
                    {['30', '100', '200', '300'].map((g) => (
                      <option key={g} value={g}>
                        {g} Tgas
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Retries">
                {({ id }) => (
                  <Select id={id} value={retries} onChange={(e) => setRetries(e.target.value)}>
                    {['0', '1', '2', '3', '5'].map((r) => (
                      <option key={r} value={r}>
                        {r === '0' ? 'No retries' : `${r} retries`}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>

            <Legend>Limits · optional</Legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Max entry market cap">{({ id }) => <AmountInput id={id} value={mcapText} onValueChange={setMcapText} unit="USD" placeholder="None" />}</Field>
              <Field label="Min liquidity">{({ id }) => <AmountInput id={id} value={liqText} onValueChange={setLiqText} unit="USD" placeholder="None" />}</Field>
              <Field label="Auto take profit">{({ id }) => <AmountInput id={id} value={tpText} onValueChange={setTpText} unit="%" placeholder="None" />}</Field>
              <Field label="Auto stop loss">{({ id }) => <AmountInput id={id} value={slText} onValueChange={setSlText} unit="%" placeholder="None" />}</Field>
            </div>
          </div>
        </Panel>

        <Panel className="lg:sticky lg:top-16">
          <PanelHeader title="Plan" actions={<Tag tone="neutral">Not armed</Tag>} />
          <div className="flex flex-col gap-4 p-4">
            <p className="text-md leading-6 text-fg">
              Buy <span className="num text-accent">{amount > 0 ? formatNumber(amount, 0, 4) : '—'}</span> NEAR × <span className="num">{funded}</span> wallets of{' '}
              {target.trim() ? <span className="num font-semibold">{target.trim()}</span> : <span className="text-fg-3">the target</span>} {TRIGGER_WORDS[trigger]}
            </p>
            <Lines>
              <Line label="Preset">{preset ? preset.name : '—'}</Line>
              <Line label="Total" emphasis>
                {formatNumber(total, 2, 4)} NEAR
              </Line>
              <Line label={`NearKit fee (${NEARKIT_FEE_LABEL})`}>{formatNumber((total * NEARKIT_FEE_BPS) / 10_000, 2, 4)} NEAR</Line>
              <Line label={<Term term="networkFee">Network fee (est.)</Term>}>{formatNumber(funded * NETWORK_FEE_NEAR_PER_TX, 4, 4)} NEAR</Line>
              <Line label="Trigger">{trigger === 'at-time' && at ? formatDateTime(at) : TRIGGER_WORDS[trigger]}</Line>
              <Line label="Priority">
                {priority} · {gas} Tgas · {retries} retries
              </Line>
              {(mcapText || liqText) && (
                <Line label="Limits">
                  {[mcapText && `mcap ≤ ${formatUsdCompact(parseAmount(mcapText) ?? 0)}`, liqText && `liq ≥ ${formatUsdCompact(parseAmount(liqText) ?? 0)}`]
                    .filter(Boolean)
                    .join(' · ')}
                </Line>
              )}
            </Lines>
            <div className="flex flex-col gap-2">
              <Button size="lg" block variant="primary" disabled={presetsLoading || (touched && blocker !== null)} loading={createSniper.isPending} onClick={save}>
                Save config
              </Button>
              {touched && blocker && <p className="text-xs text-neg">{blocker}</p>}
              <Tip content="Arming needs a service that watches launches and signs for you. NearKit doesn't run one yet." className="w-full">
                <span className="flex w-full items-center gap-2">
                  <Button size="md" variant="secondary" disabled className="min-w-0 flex-1">
                    Arm sniper
                  </Button>
                  <ComingSoon />
                </span>
              </Tip>
              <SimulationNote
                demo="Configs are saved, never armed. No launch is watched and nothing is bought."
                real="Configs are saved as drafts in this browser, never armed. No launch is watched and nothing is bought."
              />
            </div>
          </div>
        </Panel>
      </div>

      <Panel>
        <PanelHeader title="Saved configs" meta={configs.data?.length} />
        {configs.data && configs.data.length === 0 ? (
          <EmptyState title="No sniper configs yet">Save a setup above. Configs wait here, unarmed, until the execution module is live.</EmptyState>
        ) : (
          <ul className="divide-y divide-line-soft">
            {(configs.data ?? []).map((c) => {
              const p = presets.find((x) => x.id === c.presetId)
              return (
                <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <AccountText id={c.target} className="text-sm text-fg" />
                    <p className="text-xs text-fg-3">
                      {formatNumber(c.amountNearPerWallet, 0, 4)} NEAR × {p?.walletIds.length ?? 0} wallets ({p?.name ?? 'preset removed'}) · {TRIGGER_WORDS[c.trigger]} ·{' '}
                      {c.priority}
                    </p>
                  </div>
                  <span className="text-xs text-fg-3">
                    <Figures>{`Saved ${formatAgo(c.createdAt, now)}`}</Figures>
                  </span>
                  <StatusLamp status={c.status} />
                  <IconButton
                    label={`Delete config for ${c.target}`}
                    size="sm"
                    tone="danger"
                    onClick={() => deleteSniper.mutate(c.id, { onSuccess: () => toast.push({ title: 'Sniper config deleted' }) })}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </li>
              )
            })}
          </ul>
        )}
      </Panel>
    </>
  )
}

export default function SniperPage() {
  return (
    <Page>
      <PageHeader
        title="Sniper"
        status={<Tag tone="neutral">Execution module not live</Tag>}
        description="Prepare a launch entry across a wallet preset: target, size, trigger and execution settings."
      />
      <RequireWallet feature="Sniper">
        <Sniper />
      </RequireWallet>
    </Page>
  )
}
