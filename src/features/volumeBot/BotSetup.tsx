import { useMemo, useState, type ReactNode } from 'react'
import { TokenSelect } from '@/components/domain/TokenSelect'
import { Button } from '@/components/ui/Button'
import { Figures } from '@/components/ui/Figures'
import { AmountInput, Checkbox, Field, Segmented, Select, Switch } from '@/components/ui/Form'
import { Tag } from '@/components/ui/Indicators'
import { Legend, Panel, PanelHeader } from '@/components/ui/Panel'
import { useToast } from '@/components/ui/toast-context'
import { NATIVE_TOKEN_ID } from '@/config/networks'
import { cn } from '@/lib/cn'
import { formatAccount, formatAmount } from '@/lib/format'
import type { BotConfigIssue, BotSummary } from '@/lib/volumeBot/api'
import { defaultBotConfig, MAX_BOT_WALLETS, validateBotConfig } from '@/lib/volumeBot/config'
import { BOT_STRATEGIES, type BotConfig, type BotStrategy, type HourWindow, type SizingMode } from '@/lib/volumeBot/types'
import { useDefaultTradeToken } from '@/features/trade/useDefaultToken'
import { LinkRequestError } from '@/services/telegramLink'
import { useHoldings, useNearKitWallets, useTokens } from '@/services/queries'
import { applyText, fieldsFor, GUARDIAN_FIELDS, RISK_FIELDS, SCHEDULE_FIELDS, SIZING_LABEL, sizingFields, sizingModes, strategyFields, textOf, type NumField } from './fields'
import { issuesByField, STRATEGY } from './model'
import { useVolumeBotMutations } from './queries'

/**
 * A Volume Bot's configuration: token, strategy, the NEARKITS wallets it trades from, and every
 * limit. Saving never starts it; the server checks the wallets are the user's own and reads the
 * token from chain. Each refusal is shown on its field.
 */

const HOURS = Array.from({ length: 24 }, (_, h) => h)

function NumInput({ field, text, onText, error }: { field: NumField; text: string; onText: (v: string) => void; error?: string }) {
  return (
    <Field label={field.label} hint={field.hint} error={error}>
      {({ id, describedBy, invalid }) => (
        <AmountInput
          id={id}
          size="sm"
          value={text}
          onValueChange={onText}
          unit={field.unit}
          placeholder={field.optional ? 'No limit' : undefined}
          aria-describedby={describedBy}
          aria-invalid={invalid}
        />
      )}
    </Field>
  )
}

function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <Legend>{title}</Legend>
      {children}
    </div>
  )
}

function WindowPicker({ value, onChange }: { value: HourWindow; onChange: (w: HourWindow) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="From (UTC)">
        {({ id }) => (
          <Select id={id} selectSize="sm" value={value.from} onChange={(e) => onChange({ ...value, from: Number(e.target.value) })}>
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, '0')}:00
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Until (UTC)">
        {({ id }) => (
          <Select id={id} selectSize="sm" value={value.to} onChange={(e) => onChange({ ...value, to: Number(e.target.value) })}>
            {HOURS.map((h) => h + 1).map((h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, '0')}:00
              </option>
            ))}
          </Select>
        )}
      </Field>
    </div>
  )
}

export function BotSetup({ editing, onSaved, onCancel }: { editing?: { bot: BotSummary; config: BotConfig } | null; onSaved: (bot: BotSummary) => void; onCancel?: () => void }) {
  const toast = useToast()
  const { save } = useVolumeBotMutations()
  const { data: tokens = [] } = useTokens()
  const { data: holdings = [] } = useHoldings()
  const { data: list } = useNearKitWallets()
  const wallets = list?.wallets ?? []
  const defaultToken = useDefaultTradeToken()

  const [config, setConfig] = useState<BotConfig>(() => editing?.config ?? defaultBotConfig('market-maker', { id: '', symbol: '', decimals: 0 }, []))
  const [text, setText] = useState<Record<string, string>>(() => textOf(config))
  const [attempted, setAttempted] = useState(false)
  const [serverIssues, setServerIssues] = useState<BotConfigIssue[]>([])
  const [failure, setFailure] = useState<string | null>(null)

  // Until one is chosen, the token the trade tools open on.
  const tokenId = config.tokenId || (defaultToken === NATIVE_TOKEN_ID ? '' : defaultToken)
  const token = tokens.find((t) => t.id === tokenId)
  const symbol = token?.symbol ?? config.tokenSymbol
  const merged = useMemo(
    () => applyText({ ...config, tokenId, tokenSymbol: symbol, tokenDecimals: token?.decimals ?? config.tokenDecimals }, fieldsFor(config), text),
    [config, tokenId, text, symbol, token],
  )
  const issues = validateBotConfig(merged)
  const errors = attempted ? { ...issuesByField(serverIssues), ...issuesByField(issues) } : issuesByField(serverIssues)

  const update = (patch: Partial<BotConfig>) => {
    setServerIssues([])
    setConfig((c) => ({ ...c, ...patch }))
  }
  const setStrategy = (strategy: BotStrategy) => {
    // A strategy's own starting point; the token and wallets stay.
    const next = defaultBotConfig(strategy, { id: config.tokenId, symbol: config.tokenSymbol, decimals: config.tokenDecimals }, config.walletIds)
    setConfig(next)
    setText(textOf(next))
    setServerIssues([])
  }
  const onText = (path: string) => (v: string) => {
    setServerIssues((s) => s.filter((i) => i.field !== path))
    setText((t) => ({ ...t, [path]: v }))
  }
  const toggleWallet = (id: string, on: boolean) => update({ walletIds: on ? [...config.walletIds, id] : config.walletIds.filter((w) => w !== id) })
  const balanceOf = (accountId: string, tokenId: string) => holdings.find((h) => h.walletId === accountId && h.tokenId === tokenId)?.amount ?? null

  const num = (f: NumField) => <NumInput key={f.path} field={f} text={text[f.path] ?? ''} onText={onText(f.path)} error={errors[f.path]} />

  const submit = () => {
    setAttempted(true)
    setFailure(null)
    if (issues.length > 0) return
    save.mutate(
      { config: merged, botId: editing?.bot.id },
      {
        onSuccess: (bot) => {
          toast.push({ tone: 'accent', title: editing ? 'Volume Bot updated' : 'Volume Bot saved', detail: 'Nothing trades until you start it.' })
          onSaved(bot)
        },
        onError: (e) => {
          if (e instanceof LinkRequestError && e.code === 'config' && Array.isArray(e.detail?.issues)) setServerIssues(e.detail.issues as BotConfigIssue[])
          setFailure(e instanceof Error ? e.message : 'The bot wasn’t saved. Try again in a moment.')
        },
      },
    )
  }

  const blocker = attempted && issues.length > 0 ? `${issues.length} field${issues.length === 1 ? ' needs' : 's need'} a look: ${issues[0]?.message}` : null

  return (
    <Panel>
      <PanelHeader title={editing ? `Edit ${editing.bot.symbol} bot` : 'New Volume Bot'} actions={<Tag tone="neutral">Saved stopped</Tag>} />
      <div className="grid grid-cols-1 gap-6 p-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-6">
          <Section title="Market">
            <Field label="Token (traded against NEAR)" error={errors.tokenId}>
              {({ id }) => (
                <TokenSelect id={id} label="Token" size="md" value={tokenId || NATIVE_TOKEN_ID} onChange={(next) => update({ tokenId: next })} exclude={[NATIVE_TOKEN_ID]} />
              )}
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="legend">Strategy</span>
              <Segmented
                label="Strategy"
                block
                value={config.strategy}
                onChange={setStrategy}
                options={BOT_STRATEGIES.map((s) => ({ value: s, label: STRATEGY[s].label.replace(' (TWAP)', '') }))}
              />
              <p className="text-xs leading-5 text-fg-3">{STRATEGY[config.strategy].blurb}</p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{strategyFields(config.strategy, symbol).map(num)}</div>
          </Section>

          <Section title="Wallets">
            {wallets.length === 0 ? (
              <p className="text-sm text-fg-3">No NEARKITS wallet yet. Create one on Wallets & Presets; the bot trades only from NEARKITS wallets.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-line-soft rounded-md border border-line" aria-label="Wallets the bot trades from">
                {wallets.map((w) => {
                  const near = balanceOf(w.accountId, NATIVE_TOKEN_ID)
                  const held = tokenId ? balanceOf(w.accountId, tokenId) : null
                  const checked = config.walletIds.includes(w.id)
                  return (
                    <li key={w.id} className="flex items-center justify-between gap-3 px-3 py-2">
                      <Checkbox
                        checked={checked}
                        disabled={w.frozen || (!checked && config.walletIds.length >= MAX_BOT_WALLETS)}
                        onChange={(e) => toggleWallet(w.id, e.target.checked)}
                        label={
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate text-sm text-fg">{w.name}</span>
                            <span className="num truncate text-xs text-fg-3">{formatAccount(w.accountId, 22)}</span>
                          </span>
                        }
                      />
                      <span className="num shrink-0 text-right text-xs text-fg-2">
                        {w.frozen ? (
                          <Tag tone="warn">Frozen</Tag>
                        ) : (
                          <>
                            <span className="block">{near === null ? '—' : `${formatAmount(near, 2)} NEAR`}</span>
                            {tokenId && <span className="block text-fg-3">{held === null ? '—' : `${formatAmount(held, 2)} ${symbol}`}</span>}
                          </>
                        )}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
            {errors.walletIds && (
              <p className="text-xs text-neg" role="alert">
                {errors.walletIds}
              </p>
            )}
            <p className="text-xs leading-5 text-fg-3">
              <Figures>{`Only your own active NEARKITS wallets: never watch-only, connected or frozen ones. At most ${MAX_BOT_WALLETS}. Each trade comes from one wallet and settles there.`}</Figures>
            </p>
          </Section>

          <Section title="Trade size">
            <Segmented<SizingMode>
              label="Trade size"
              block
              size="sm"
              value={sizingModes(config.strategy).includes(config.sizing.mode) ? config.sizing.mode : (sizingModes(config.strategy)[0] as SizingMode)}
              onChange={(mode) => update({ sizing: { ...config.sizing, mode } })}
              options={sizingModes(config.strategy).map((m) => ({ value: m, label: SIZING_LABEL[m] }))}
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{sizingFields(config).map(num)}</div>
            <Switch
              checked={config.sizing.adaptiveImpact}
              onChange={(adaptiveImpact) => update({ sizing: { ...config.sizing, adaptiveImpact } })}
              label="Shrink a trade whose price impact is over the limit"
              description="Instead of skipping it, the bot tries a smaller size."
            />
          </Section>
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <Section title="Schedule">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{SCHEDULE_FIELDS.map(num)}</div>
            <Switch
              checked={config.schedule.activeHours !== null}
              onChange={(on) => update({ schedule: { ...config.schedule, activeHours: on ? { from: 8, to: 20 } : null } })}
              label="Trade only during set hours"
              description="Outside them the bot waits; it never trades to fill a quota."
            />
            {config.schedule.activeHours && (
              <WindowPicker value={config.schedule.activeHours} onChange={(activeHours) => update({ schedule: { ...config.schedule, activeHours } })} />
            )}
            {errors['schedule.activeHours'] && <p className="text-xs text-neg">{errors['schedule.activeHours']}</p>}
          </Section>

          <Section title="Risk limits">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{RISK_FIELDS.map(num)}</div>
          </Section>

          <details className="group rounded-md border border-line-soft">
            <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-sm text-fg-2 hover:text-fg">
              Guardian thresholds
              <span className="text-xs text-fg-3 group-open:hidden">Pauses the bot with the exact reason</span>
            </summary>
            <div className="grid grid-cols-1 gap-3 border-t border-line-soft p-3 sm:grid-cols-2">{GUARDIAN_FIELDS.map(num)}</div>
          </details>
        </div>
      </div>

      <div className="flex flex-col gap-2 border-t border-line-soft p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 text-xs leading-5 text-fg-3">
          {failure ? (
            <p className="text-neg" role="alert">
              <Figures>{failure}</Figures>
            </p>
          ) : blocker ? (
            <p className="text-neg">
              <Figures>{blocker}</Figures>
            </p>
          ) : (
            <p>Saved stopped. Every trade it makes pays the same NEARKITS fee as a manual one, on Rhea’s route.</p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          {onCancel && (
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            {editing ? 'Save changes' : 'Save bot'}
          </Button>
        </div>
      </div>
    </Panel>
  )
}
