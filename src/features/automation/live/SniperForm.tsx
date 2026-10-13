import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Figures } from '@/components/ui/Figures'
import { Checkbox, Field, Input, Segmented } from '@/components/ui/Form'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { useToast } from '@/components/ui/toast-context'
import type { StrategyPreview } from '@/lib/automation/api'
import { MAX_SNIPER_ATTEMPTS, type ConfigIssue, type SniperSettings, type TokenRef } from '@/lib/automation/config'
import { DEFAULT_SLIPPAGE } from '@/lib/fees'
import { useNow } from '@/lib/hooks'
import { isValidAccountId } from '@/lib/validation'
import { describeError } from '@/services/errors'
import { useTokenLookup, useTokens } from '@/services/queries'
import { ExpiryField, NumberField, SlippageField } from './formParts'
import { useWalletChoice } from './hooks'
import { buildSniper, describeStrategy, issuesByField, refusalOf, tokenRefOf, type SniperDraft } from './model'
import { NearKitWalletField, PreviewLines, ReviewModal } from './parts'
import { useStrategyMutations } from './queries'

/**
 * A Sniper: watch one token contract until a route trades it within the liquidity and impact limits.
 * New snipers only notify. Buying (execute) is a separate, explicit yes: it trades from the NEARKITS
 * wallet without asking again, and the server refuses it without that confirmation.
 */

export const SNIPER_TERMS =
  'NEARKITS checks the token on a schedule, server-side. In notify-only mode it tells you when a route trades it within your limits and buys nothing. In buy mode it buys once from your NEARKITS wallet at the market with your slippage and impact limits: the price is not guaranteed, and a new token can move fast or be unsafe.'

/** The token to watch: a listed one, or any contract read from chain. */
function useSniperToken(contract: string): { token: TokenRef | null; pending: boolean; error: string | null } {
  const { data: tokens = [] } = useTokens()
  const id = contract.trim().toLowerCase()
  const valid = id !== '' && isValidAccountId(id)
  const listed = valid ? tokenRefOf(tokens.find((t) => t.contract === id)) : null
  const lookup = useTokenLookup(valid && !listed ? id : null)
  if (!valid) return { token: null, pending: false, error: id ? 'Enter a token contract, e.g. token.example.near' : null }
  if (listed) return { token: listed, pending: false, error: null }
  if (lookup.isPending) return { token: null, pending: true, error: null }
  if (lookup.isError) return { token: null, pending: false, error: describeError(lookup.error).message }
  return { token: tokenRefOf(lookup.data) ?? (lookup.data ? { id, symbol: lookup.data.symbol, decimals: lookup.data.decimals } : null), pending: false, error: null }
}

export function SniperForm({ onCreated }: { onCreated: (id: string) => void }) {
  const toast = useToast()
  const { preview, create } = useStrategyMutations()
  const [walletId, setWalletId] = useWalletChoice()
  const [contract, setContract] = useState('')
  const [d, setD] = useState<Omit<SniperDraft, 'token'>>({
    amountText: '1',
    slippagePct: DEFAULT_SLIPPAGE,
    maxImpactText: '10',
    minLiquidityText: '',
    maxAttemptsText: '3',
    expiry: '24h',
    mode: 'notify',
  })
  const [attempted, setAttempted] = useState(false)
  const [serverIssues, setServerIssues] = useState<ConfigIssue[]>([])
  const [failure, setFailure] = useState<string | null>(null)
  const [review, setReview] = useState<SniperSettings | null>(null)
  const [understood, setUnderstood] = useState(false)
  const now = useNow(15_000)
  const target = useSniperToken(contract)

  const built = buildSniper({ ...d, token: target.token }, now)
  const errors = attempted ? { ...issuesByField(serverIssues), ...issuesByField(built.issues) } : issuesByField(serverIssues)
  const set = (patch: Partial<Omit<SniperDraft, 'token'>>) => {
    setServerIssues([])
    setFailure(null)
    setD((x) => ({ ...x, ...patch }))
  }

  const openReview = () => {
    setAttempted(true)
    setFailure(null)
    if (!walletId) return setFailure('Choose a NEARKITS wallet.')
    if (built.issues.length > 0 || !target.token) return
    const fresh = buildSniper({ ...d, token: target.token }, Date.now()).config
    setUnderstood(false)
    setReview(fresh)
    preview.reset()
    preview.mutate({ walletId, config: { kind: 'sniper', sniper: fresh } })
  }

  const confirm = () => {
    if (!review) return
    const execute = review.mode === 'execute'
    create.mutate(
      { walletId, config: { kind: 'sniper', sniper: review }, ...(execute ? { confirmExecute: true } : {}) },
      {
        onSuccess: (made) => {
          setReview(null)
          setAttempted(false)
          toast.push({
            tone: 'accent',
            title: execute ? 'Sniper armed to buy' : 'Sniper watching (notify only)',
            detail: execute ? 'It buys once when the token trades within your limits.' : 'It buys nothing: it tells you when the token trades.',
          })
          if (made[0]) onCreated(made[0].id)
        },
        onError: (e) => {
          const r = refusalOf(e)
          setFailure(r.message)
          if (r.issues.length > 0) {
            setServerIssues(r.issues)
            setReview(null)
          }
        },
      },
    )
  }

  const tokenError = errors['token.id'] ?? errors['token.decimals'] ?? errors['token.symbol'] ?? errors.token
  return (
    <Panel>
      <PanelHeader title="New sniper" />
      <div className="flex flex-col gap-4 p-4">
        <Field
          label="Token contract"
          error={attempted ? (target.error ?? tokenError) : (target.error ?? undefined)}
          hint={
            target.pending
              ? 'Reading the token from chain…'
              : target.token
                ? `${target.token.symbol} · ${target.token.decimals} decimals`
                : 'The token to buy once it trades against NEAR.'
          }
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              mono
              value={contract}
              onChange={(e) => {
                setServerIssues([])
                setContract(e.target.value)
              }}
              placeholder="token.example.near"
              autoComplete="off"
              spellCheck={false}
              aria-describedby={describedBy}
              aria-invalid={invalid}
            />
          )}
        </Field>
        <NumberField label="Buy amount" value={d.amountText} onChange={(amountText) => set({ amountText })} unit="NEAR" error={errors.amountNear ?? errors.amount} />
        <div className="grid grid-cols-2 gap-3">
          <NumberField label="Max impact" value={d.maxImpactText} onChange={(maxImpactText) => set({ maxImpactText })} unit="%" error={errors.maxImpactPct} />
          <NumberField
            label="Max attempts"
            value={d.maxAttemptsText}
            onChange={(maxAttemptsText) => set({ maxAttemptsText })}
            error={errors.maxAttempts}
            hint={`1 to ${MAX_SNIPER_ATTEMPTS}`}
          />
        </div>
        <NumberField
          label="Min liquidity"
          value={d.minLiquidityText}
          onChange={(minLiquidityText) => set({ minLiquidityText })}
          unit="USD"
          placeholder="No check"
          error={errors.minLiquidityUsd}
        />
        <Field label="Mode" error={errors.mode}>
          {() => (
            <Segmented
              label="Mode"
              block
              value={d.mode}
              onChange={(mode) => set({ mode })}
              options={[
                { value: 'notify', label: 'Notify only' },
                { value: 'execute', label: 'Buy', tone: 'buy' },
              ]}
            />
          )}
        </Field>
        {d.mode === 'execute' && (
          <p className="text-xs leading-5 text-warn">Buy mode trades from your NEARKITS wallet without asking again. You confirm it explicitly on the next step.</p>
        )}
        <NearKitWalletField value={walletId} onChange={setWalletId} />
        <SlippageField value={d.slippagePct} onChange={(slippagePct) => set({ slippagePct })} error={errors.slippagePct} />
        <ExpiryField value={d.expiry} onChange={(expiry) => set({ expiry })} error={errors.expiresAt} />

        <div className="flex flex-col gap-2 border-t border-line-soft pt-3">
          <Button size="lg" block variant="primary" onClick={openReview}>
            Review sniper
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
            <Figures>{SNIPER_TERMS}</Figures>
          </p>
        </div>
      </div>
      <ReviewModal
        open={review !== null}
        onClose={() => setReview(null)}
        title={review?.mode === 'execute' ? 'Confirm a sniper that buys' : 'Review sniper (notify only)'}
        summary={
          review && (
            <Figures>{`${describeStrategy({ config: { kind: 'sniper', sniper: review } })}. Up to ${review.maxAttempts} attempts; slippage ${review.slippagePct}%.`}</Figures>
          )
        }
        preview={
          review
            ? {
                pending: preview.isPending,
                error: preview.isError ? refusalOf(preview.error).message : null,
                body: preview.data ? <PreviewLines preview={preview.data as StrategyPreview} token={review.token} /> : null,
              }
            : null
        }
        extra={
          review?.mode === 'execute' && (
            <Checkbox
              checked={understood}
              onChange={(e) => setUnderstood(e.target.checked)}
              label={`I confirm: buy ${review.amountNear} NEAR of ${review.token.symbol} from my NEARKITS wallet when it trades within these limits, without asking me again.`}
            />
          )
        }
        terms={`${SNIPER_TERMS} A quote error here can simply mean the token doesn’t trade yet.`}
        error={failure}
        confirmLabel={review?.mode === 'execute' ? 'Arm sniper to buy' : 'Create sniper'}
        confirmDisabled={review?.mode === 'execute' && !understood}
        confirming={create.isPending}
        onConfirm={confirm}
      />
    </Panel>
  )
}
