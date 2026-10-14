import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Figures } from '@/components/ui/Figures'
import { Field, Input, Segmented, Select } from '@/components/ui/Form'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { useToast } from '@/components/ui/toast-context'
import type { StrategyPreview } from '@/lib/automation/api'
import type { ConfigIssue, DcaConfig } from '@/lib/automation/config'
import { DEFAULT_SLIPPAGE } from '@/lib/fees'
import { formatDateTime } from '@/lib/format'
import { useNow } from '@/lib/hooks'
import { NumberField, SlippageField, TokenField } from './formParts'
import { useTokenChoice, useWalletChoice } from './hooks'
import { buildDca, createRefusalOf, DCA_INTERVALS, describeStrategy, issuesByField, refusalOf, reviewOf, type DcaDraft, type Reviewed } from './model'
import { NearKitWalletField, PreviewLines, ReviewModal } from './parts'
import { useStrategyMutations } from './queries'

/** DCA: buy a fixed amount of NEAR's worth of a token on a schedule, server-side from a NEARKITS wallet. */

export const DCA_TERMS =
  'NEARKITS buys on your schedule, server-side from your NEARKITS wallet, without asking again: each buy is a market swap with your slippage (the minimum received is enforced on chain; the price is not guaranteed). A buy the wallet can’t pay for waits and says so.'

export function DcaForm({ onCreated }: { onCreated: (id: string) => void }) {
  const toast = useToast()
  const { preview, create } = useStrategyMutations()
  const [walletId, setWalletId] = useWalletChoice()
  const { tokenId, setTokenId, token } = useTokenChoice()
  const [d, setD] = useState<Omit<DcaDraft, 'token'>>({
    amountText: '1',
    everySec: 86_400,
    startText: '',
    endBy: 'never',
    maxRunsText: '30',
    endText: '',
    slippagePct: DEFAULT_SLIPPAGE,
  })
  const [attempted, setAttempted] = useState(false)
  const [serverIssues, setServerIssues] = useState<ConfigIssue[]>([])
  const [failure, setFailure] = useState<string | null>(null)
  const [review, setReview] = useState<Reviewed<DcaConfig> | null>(null)
  const now = useNow(15_000)

  const built = buildDca({ ...d, token }, now)
  const errors = attempted ? { ...issuesByField(serverIssues), ...issuesByField(built.issues) } : issuesByField(serverIssues)
  const set = (patch: Partial<Omit<DcaDraft, 'token'>>) => {
    setServerIssues([])
    setFailure(null)
    setD((x) => ({ ...x, ...patch }))
  }

  const openReview = () => {
    setAttempted(true)
    setFailure(null)
    if (!walletId) return setFailure('Choose a NEARKITS wallet.')
    if (built.issues.length > 0) return
    // "Now" is the moment it is reviewed. A new review: a new request key.
    const fresh = buildDca({ ...d, token }, Date.now()).config
    setReview(reviewOf(fresh, walletId))
    preview.reset()
    preview.mutate({ walletId, config: { kind: 'dca', dca: fresh } })
  }

  const confirm = () => {
    if (!review) return
    const plan = review.config
    // Exactly what was reviewed, with the review's key: a retry or a second click makes nothing twice.
    create.mutate(
      { walletId: review.walletId, config: { kind: 'dca', dca: plan }, requestKey: review.requestKey },
      {
        onSuccess: (made) => {
          setReview(null)
          setAttempted(false)
          toast.push({
            tone: 'accent',
            title: 'DCA plan created',
            detail: `First buy ${plan.startAt <= Date.now() + 60_000 ? 'at the next check' : formatDateTime(plan.startAt)}.`,
          })
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
      <PanelHeader title="New DCA plan" />
      <div className="flex flex-col gap-4 p-4">
        <TokenField
          tokenId={tokenId}
          onChange={(id) => {
            setServerIssues([])
            setTokenId(id)
          }}
          error={errors['token.id'] ?? errors['token.decimals'] ?? errors['token.symbol'] ?? errors.token}
        />
        <NumberField label="Each buy" value={d.amountText} onChange={(amountText) => set({ amountText })} unit="NEAR" error={errors.amountNear ?? errors.amount} />
        <Field label="Interval" error={errors.everySec}>
          {({ id }) => (
            <Select id={id} value={String(d.everySec)} onChange={(e) => set({ everySec: Number(e.target.value) })}>
              {DCA_INTERVALS.map((i) => (
                <option key={i.value} value={i.value}>
                  {i.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Start" error={errors.startAt} hint="Empty: the first buy at the next check. Your browser’s time zone.">
          {({ id, describedBy, invalid }) => (
            <Input id={id} type="datetime-local" value={d.startText} onChange={(e) => set({ startText: e.target.value })} aria-describedby={describedBy} aria-invalid={invalid} />
          )}
        </Field>
        <Field label="Ends" error={errors.endAt ?? errors.maxRuns}>
          {() => (
            <Segmented
              label="Ends"
              block
              size="sm"
              value={d.endBy}
              onChange={(endBy) => set({ endBy })}
              options={[
                { value: 'never', label: 'When stopped' },
                { value: 'runs', label: 'After N buys' },
                { value: 'date', label: 'On a date' },
              ]}
            />
          )}
        </Field>
        {d.endBy === 'runs' && <NumberField label="Number of buys" value={d.maxRunsText} onChange={(maxRunsText) => set({ maxRunsText })} error={errors.maxRuns} />}
        {d.endBy === 'date' && (
          <Field label="End" error={errors.endAt}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} type="datetime-local" value={d.endText} onChange={(e) => set({ endText: e.target.value })} aria-describedby={describedBy} aria-invalid={invalid} />
            )}
          </Field>
        )}
        <NearKitWalletField value={walletId} onChange={setWalletId} />
        <SlippageField value={d.slippagePct} onChange={(slippagePct) => set({ slippagePct })} error={errors.slippagePct} />

        <div className="flex flex-col gap-2 border-t border-line-soft pt-3">
          <Button size="lg" block variant="primary" onClick={openReview}>
            Review plan
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
            <Figures>{DCA_TERMS}</Figures>
          </p>
        </div>
      </div>
      <ReviewModal
        open={review !== null}
        onClose={() => setReview(null)}
        title="Review DCA plan"
        summary={
          review && (
            <Figures>{`${describeStrategy({ config: { kind: 'dca', dca: review.config } })}, starting ${formatDateTime(review.config.startAt)}${review.config.endAt ? `, until ${formatDateTime(review.config.endAt)}` : ''}. Slippage ${review.config.slippagePct}%.`}</Figures>
          )
        }
        preview={
          review
            ? {
                pending: preview.isPending,
                error: preview.isError ? refusalOf(preview.error).message : null,
                body: preview.data ? <PreviewLines preview={preview.data as StrategyPreview} token={review.config.token} /> : null,
              }
            : null
        }
        terms={DCA_TERMS}
        error={failure}
        confirmLabel="Create plan"
        confirming={create.isPending}
        onConfirm={confirm}
      />
    </Panel>
  )
}
