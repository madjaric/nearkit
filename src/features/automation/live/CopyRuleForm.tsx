import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { ChipInput } from '@/components/ui/ChipInput'
import { Figures } from '@/components/ui/Figures'
import { Field, Input, Segmented } from '@/components/ui/Form'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { useToast } from '@/components/ui/toast-context'
import { MAX_COPY_EXCLUDES, type ConfigIssue, type CopyConfig } from '@/lib/automation/config'
import { DEFAULT_SLIPPAGE } from '@/lib/fees'
import { isValidAccountId } from '@/lib/validation'
import { NumberField, SlippageField } from './formParts'
import { useWalletChoice } from './hooks'
import { buildCopy, createRefusalOf, describeStrategy, issuesByField, reviewOf, type CopyDraft, type Reviewed } from './model'
import { NearKitWalletField, ReviewModal } from './parts'
import { useStrategyMutations } from './queries'

/**
 * A Copy Trade rule: follow one NEAR account and copy its NEAR swaps (Rhea, Ref, DCL) from a NEARKITS
 * wallet, within the rule's limits. A copied sell exits only what the rule bought. NEARKITS wallets
 * can't be followed (the server refuses: copies of copies would loop).
 */

export const COPY_TERMS =
  'NEARKITS reads the followed account’s final transactions and copies its swaps through Rhea, Ref and DCL within your limits, server-side from your NEARKITS wallet, without asking again (a token-for-token swap is copied as NEAR trades: a sell of what this rule holds of the first token, a buy of the second). A copy trades after theirs, at the market with your slippage: its price is not theirs and is not guaranteed. Sells exit only what this rule bought.'

const normalizeContract = (raw: string): string | null => {
  const v = raw.trim().toLowerCase()
  return v && isValidAccountId(v) ? v : null
}

export function CopyRuleForm({ onCreated }: { onCreated: (id: string) => void }) {
  const toast = useToast()
  const { create } = useStrategyMutations()
  const [walletId, setWalletId] = useWalletChoice()
  const [d, setD] = useState<CopyDraft>({
    target: '',
    copy: 'both',
    sizing: 'fixed',
    fixedText: '1',
    pctText: '25',
    maxTradeText: '5',
    minTradeText: '',
    maxExposureText: '20',
    slippagePct: DEFAULT_SLIPPAGE,
    minLiquidityText: '',
    exclude: [],
  })
  const [attempted, setAttempted] = useState(false)
  const [serverIssues, setServerIssues] = useState<ConfigIssue[]>([])
  const [failure, setFailure] = useState<string | null>(null)
  const [review, setReview] = useState<Reviewed<CopyConfig> | null>(null)

  const built = buildCopy(d)
  const errors = attempted ? { ...issuesByField(serverIssues), ...issuesByField(built.issues) } : issuesByField(serverIssues)
  const set = (patch: Partial<CopyDraft>) => {
    setServerIssues([])
    setFailure(null)
    setD((x) => ({ ...x, ...patch }))
  }

  const openReview = () => {
    setAttempted(true)
    setFailure(null)
    if (!walletId) return setFailure('Choose a NEARKITS wallet.')
    // A new review: a new request key.
    if (built.issues.length === 0) setReview(reviewOf(built.config, walletId))
  }

  const confirm = () => {
    if (!review) return
    // Exactly what was reviewed, with the review's key: a retry or a second click makes nothing twice.
    create.mutate(
      { walletId: review.walletId, config: { kind: 'copy', copy: review.config }, requestKey: review.requestKey },
      {
        onSuccess: (made) => {
          setReview(null)
          setAttempted(false)
          toast.push({ tone: 'accent', title: 'Copy Trade rule created', detail: 'It copies trades the account makes from now on.' })
          if (made[0]) onCreated(made[0].id)
        },
        onError: (e) => {
          const r = createRefusalOf(e)
          setFailure(r.message)
          if (r.reviewAgain) {
            setServerIssues(r.issues)
            setReview(null)
          }
        },
      },
    )
  }

  return (
    <Panel>
      <PanelHeader title="New Copy Trade rule" />
      <div className="flex flex-col gap-4 p-4">
        <Field label="Account to follow" error={errors.target} hint="A NEAR account. NEARKITS wallets can’t be followed.">
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              mono
              value={d.target}
              onChange={(e) => set({ target: e.target.value })}
              placeholder="trader.near"
              autoComplete="off"
              spellCheck={false}
              aria-describedby={describedBy}
              aria-invalid={invalid}
            />
          )}
        </Field>
        <Field label="Copy" error={errors.copy}>
          {() => (
            <Segmented
              label="Copy"
              block
              value={d.copy}
              onChange={(copy) => set({ copy })}
              options={[
                { value: 'buy', label: 'Buys' },
                { value: 'sell', label: 'Sells' },
                { value: 'both', label: 'Both' },
              ]}
            />
          )}
        </Field>
        <Field label="Buy size" error={errors.sizing}>
          {() => (
            <Segmented
              label="Buy size"
              block
              size="sm"
              value={d.sizing}
              onChange={(sizing) => set({ sizing })}
              options={[
                { value: 'fixed', label: 'Fixed NEAR' },
                { value: 'percent', label: '% of their size' },
              ]}
            />
          )}
        </Field>
        {d.sizing === 'fixed' ? (
          <NumberField label="Each copied buy" value={d.fixedText} onChange={(fixedText) => set({ fixedText })} unit="NEAR" />
        ) : (
          <NumberField label="Share of what they spent" value={d.pctText} onChange={(pctText) => set({ pctText })} unit="%" />
        )}
        <div className="grid grid-cols-2 gap-3">
          <NumberField label="Max trade" value={d.maxTradeText} onChange={(maxTradeText) => set({ maxTradeText })} unit="NEAR" error={errors.maxTradeNear ?? errors.amount} />
          <NumberField label="Min trade" value={d.minTradeText} onChange={(minTradeText) => set({ minTradeText })} unit="NEAR" placeholder="None" error={errors.minTradeNear} />
        </div>
        <NumberField
          label="Max exposure"
          value={d.maxExposureText}
          onChange={(maxExposureText) => set({ maxExposureText })}
          unit="NEAR"
          error={errors.maxExposureNear}
          hint="The most NEAR this rule may have in copied buys not yet sold back."
        />
        <NumberField
          label="Min liquidity"
          value={d.minLiquidityText}
          onChange={(minLiquidityText) => set({ minLiquidityText })}
          unit="USD"
          placeholder="No check"
          error={errors.minLiquidityUsd}
          hint="Skip tokens with less market liquidity, or none known."
        />
        <Field label="Never copy these tokens" error={errors.exclude} hint={`Token contracts, up to ${MAX_COPY_EXCLUDES}.`}>
          {({ id }) => (
            <ChipInput
              id={id}
              label="Excluded token contracts"
              value={d.exclude}
              onChange={(exclude) => set({ exclude })}
              placeholder="token.example.near"
              normalize={normalizeContract}
            />
          )}
        </Field>
        <NearKitWalletField value={walletId} onChange={setWalletId} />
        <SlippageField value={d.slippagePct} onChange={(slippagePct) => set({ slippagePct })} error={errors.slippagePct} />

        <div className="flex flex-col gap-2 border-t border-line-soft pt-3">
          <Button size="lg" block variant="primary" onClick={openReview}>
            Review rule
          </Button>
          {failure && !review && (
            <p className="text-xs text-neg" role="alert">
              <Figures>{failure}</Figures>
            </p>
          )}
          {attempted && built.issues.length > 0 && (
            <p className="text-xs text-neg">
              <Figures>{`${built.issues.length} field${built.issues.length === 1 ? ' needs' : 's need'} a look: ${built.issues[0]?.message}`}</Figures>
            </p>
          )}
          <p className="text-xs leading-5 text-fg-3">
            <Figures>{COPY_TERMS}</Figures>
          </p>
        </div>
      </div>
      <ReviewModal
        open={review !== null}
        onClose={() => setReview(null)}
        title="Review Copy Trade rule"
        summary={
          review && (
            <Figures>{`Follow ${review.config.target}. ${describeStrategy({ config: { kind: 'copy', copy: review.config } })}; at most ${review.config.maxExposureNear} NEAR held in copied buys; slippage ${review.config.slippagePct}%.`}</Figures>
          )
        }
        preview={null}
        terms={`${COPY_TERMS} Nothing is quoted until the account trades.`}
        error={failure}
        confirmLabel="Create rule"
        confirming={create.isPending}
        onConfirm={confirm}
      />
    </Panel>
  )
}
