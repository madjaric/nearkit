import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Figures } from '@/components/ui/Figures'
import { Checkbox, Field, Input, Segmented } from '@/components/ui/Form'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { useToast } from '@/components/ui/toast-context'
import type { StrategyPreview } from '@/lib/automation/api'
import { MAX_SNIPER_ATTEMPTS, MAX_SNIPER_BUYS, SNIPER_SOURCES, type ConfigIssue, type SniperSettings, type SniperSource, type TokenRef } from '@/lib/automation/config'
import { DEFAULT_SLIPPAGE } from '@/lib/fees'
import { useNow } from '@/lib/hooks'
import { isValidAccountId } from '@/lib/validation'
import { describeError } from '@/services/errors'
import { useTokenLookup, useTokens } from '@/services/queries'
import { ExpiryField, NumberField, SlippageField } from './formParts'
import { useWalletChoice } from './hooks'
import {
  buildSniper,
  buyConfirmation,
  createRefusalOf,
  DEFAULT_MIN_POOL_NEAR,
  issuesByField,
  refusalOf,
  reviewOf,
  SNIPER_SOURCE_LABEL,
  sniperCreatedNote,
  sniperSummary,
  tokenRefOf,
  type Reviewed,
  type SniperDraft,
} from './model'
import { NearKitWalletField, PreviewLines, ReviewModal } from './parts'
import { useStrategyMutations } from './queries'

/**
 * A Sniper: watch one token contract until a route trades it within the liquidity and impact limits,
 * or new pools as Ref DCL and Ref v2 create them (Nearly launches, meme.cooking graduations, others).
 * New snipers only notify. Buying (execute) is a separate, explicit yes: it trades from the NEARKITS
 * wallet without asking again, and the server refuses it without that confirmation.
 */

export const SNIPER_TERMS =
  'NEARKITS checks the token on a schedule, server-side. In notify-only mode it tells you when a route trades it within your limits and buys nothing. In buy mode it buys once from your NEARKITS wallet at the market with your slippage and impact limits: the price is not guaranteed, and a new token can move fast or be unsafe.'

/** What a new-pools sniper watches, as the server does it (server/src/automation/pools.ts, runner.ts). */
export const NEW_POOLS_WATCH =
  'NEARKITS reads new pools as Ref DCL and Ref v2 create them: a Nearly launch creates a DCL pool (counted once Nearly says the launch is done), a meme.cooking graduation a Ref pool. Each new pool of a token against NEAR from your sources must hold your NEAR minimum, trade from your NEARKITS wallet within your price impact, and lose at most 25% on a round trip (buy, then sell back). A pool not routed yet is tried again for up to 5 minutes. Pools made before this sniper are never reported.'

export const NEW_POOLS_TERMS =
  'In notify-only mode it tells you about each new pool that passes and buys nothing. In buy mode it buys your amount of each new token that passes, up to your number of tokens, from your NEARKITS wallet at the market with your slippage: the price is not guaranteed, and a new token can move fast or be unsafe.'

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
    target: 'token',
    sources: ['nearly', 'meme-cooking'],
    minPoolText: DEFAULT_MIN_POOL_NEAR,
    maxBuysText: '1',
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
  const [review, setReview] = useState<Reviewed<SniperSettings> | null>(null)
  const [understood, setUnderstood] = useState(false)
  const now = useNow(15_000)
  const target = useSniperToken(contract)
  const pools = d.target === 'new-pools'

  const built = buildSniper({ ...d, token: target.token }, now)
  const errors = attempted ? { ...issuesByField(serverIssues), ...issuesByField(built.issues) } : issuesByField(serverIssues)
  const set = (patch: Partial<Omit<SniperDraft, 'token'>>) => {
    setServerIssues([])
    setFailure(null)
    setD((x) => ({ ...x, ...patch }))
  }
  const toggleSource = (source: SniperSource, on: boolean) => set({ sources: on ? [...d.sources.filter((x) => x !== source), source] : d.sources.filter((x) => x !== source) })

  const openReview = () => {
    setAttempted(true)
    setFailure(null)
    if (!walletId) return setFailure('Choose a NEARKITS wallet.')
    if (built.issues.length > 0 || (!pools && !target.token)) return
    // The expiry counts from now, the moment it is reviewed. A new review: a new request key.
    const fresh = buildSniper({ ...d, token: target.token }, Date.now()).config
    setUnderstood(false)
    setReview(reviewOf(fresh, walletId))
    preview.reset()
    // A new-pools sniper has nothing to quote until a new pool appears (the server says so): its review is a summary.
    if (fresh.target === 'token') preview.mutate({ walletId, config: { kind: 'sniper', sniper: fresh } })
  }

  const confirm = () => {
    if (!review) return
    const c = review.config
    const execute = c.mode === 'execute'
    // Exactly what was reviewed, with the review's key: a retry or a second click makes nothing twice.
    create.mutate(
      { walletId: review.walletId, config: { kind: 'sniper', sniper: c }, ...(execute ? { confirmExecute: true } : {}), requestKey: review.requestKey },
      {
        onSuccess: (made) => {
          setReview(null)
          setAttempted(false)
          toast.push({ tone: 'accent', ...sniperCreatedNote(c) })
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

  const tokenError = errors['token.id'] ?? errors['token.decimals'] ?? errors['token.symbol'] ?? errors.token
  const reviewed = review?.config ?? null
  return (
    <Panel>
      <PanelHeader title="New sniper" />
      <div className="flex flex-col gap-4 p-4">
        <Field label="Watch" error={errors.target}>
          {() => (
            <Segmented
              label="Watch"
              block
              value={d.target}
              onChange={(t) => set({ target: t })}
              options={[
                { value: 'token', label: 'One token' },
                { value: 'new-pools', label: 'New pools' },
              ]}
            />
          )}
        </Field>

        {pools ? (
          <>
            <p className="text-xs leading-5 text-fg-3">
              <Figures>{NEW_POOLS_WATCH}</Figures>
            </p>
            <fieldset className="flex min-w-0 flex-col gap-2">
              <legend className="legend mb-2">New pools from</legend>
              <ul className="flex flex-col divide-y divide-line-soft rounded-md border border-line" aria-label="Where new pools come from">
                {SNIPER_SOURCES.map((source) => (
                  <li key={source} className="px-3 py-2">
                    <Checkbox
                      checked={d.sources.includes(source)}
                      onChange={(e) => toggleSource(source, e.target.checked)}
                      label={
                        <span className="flex min-w-0 flex-col">
                          <span className="text-sm text-fg">{SNIPER_SOURCE_LABEL[source].label}</span>
                          <span className="text-xs leading-4 text-fg-3">{SNIPER_SOURCE_LABEL[source].hint}</span>
                        </span>
                      }
                    />
                  </li>
                ))}
              </ul>
              {errors.sources && (
                <p className="text-xs leading-4 text-neg" role="alert">
                  <Figures>{errors.sources}</Figures>
                </p>
              )}
            </fieldset>
            <NumberField
              label="Pool holds at least"
              value={d.minPoolText}
              onChange={(minPoolText) => set({ minPoolText })}
              unit="NEAR"
              error={errors.minPoolNear}
              hint={`The least NEAR a new pool must hold on its NEAR side (${DEFAULT_MIN_POOL_NEAR} is a start).`}
            />
          </>
        ) : (
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
        )}
        <NumberField
          label={pools ? 'Each buy' : 'Buy amount'}
          value={d.amountText}
          onChange={(amountText) => set({ amountText })}
          unit="NEAR"
          error={errors.amountNear ?? errors.amount}
          hint={pools ? 'Spent on each new token it buys (in buy mode).' : undefined}
        />
        <div className="grid grid-cols-2 gap-3">
          <NumberField label="Max impact" value={d.maxImpactText} onChange={(maxImpactText) => set({ maxImpactText })} unit="%" error={errors.maxImpactPct} />
          <NumberField
            label="Max attempts"
            value={d.maxAttemptsText}
            onChange={(maxAttemptsText) => set({ maxAttemptsText })}
            error={errors.maxAttempts}
            hint={pools ? `1 to ${MAX_SNIPER_ATTEMPTS} buys not made, then it stops` : `1 to ${MAX_SNIPER_ATTEMPTS}`}
          />
        </div>
        {!pools && (
          <NumberField
            label="Min liquidity"
            value={d.minLiquidityText}
            onChange={(minLiquidityText) => set({ minLiquidityText })}
            unit="USD"
            placeholder="No check"
            error={errors.minLiquidityUsd}
          />
        )}
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
        {pools && d.mode === 'execute' && (
          <NumberField
            label="Tokens to buy"
            value={d.maxBuysText}
            onChange={(maxBuysText) => set({ maxBuysText })}
            error={errors.maxBuys}
            hint={`1 to ${MAX_SNIPER_BUYS}: it completes after buying this many different new tokens.`}
          />
        )}
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
            <Figures>{pools ? NEW_POOLS_TERMS : SNIPER_TERMS}</Figures>
          </p>
        </div>
      </div>
      <ReviewModal
        open={review !== null}
        onClose={() => setReview(null)}
        title={
          reviewed?.target === 'new-pools'
            ? reviewed.mode === 'execute'
              ? 'Confirm a new-pools sniper that buys'
              : 'Review new-pools sniper (notify only)'
            : reviewed?.mode === 'execute'
              ? 'Confirm a sniper that buys'
              : 'Review sniper (notify only)'
        }
        summary={reviewed && <Figures>{sniperSummary(reviewed)}</Figures>}
        preview={
          reviewed?.target === 'token'
            ? {
                pending: preview.isPending,
                error: preview.isError ? refusalOf(preview.error).message : null,
                body: preview.data && reviewed.token ? <PreviewLines preview={preview.data as StrategyPreview} token={reviewed.token} /> : null,
              }
            : null
        }
        extra={reviewed?.mode === 'execute' && <Checkbox checked={understood} onChange={(e) => setUnderstood(e.target.checked)} label={buyConfirmation(reviewed)} />}
        terms={
          reviewed?.target === 'new-pools'
            ? `${NEW_POOLS_TERMS} Nothing is quoted until a new pool appears: each pool is checked on its own fresh quote then.`
            : `${SNIPER_TERMS} A quote error here can simply mean the token doesn’t trade yet.`
        }
        error={failure}
        confirmLabel={reviewed?.mode === 'execute' ? 'Arm sniper to buy' : 'Create sniper'}
        confirmDisabled={reviewed?.mode === 'execute' && !understood}
        confirming={create.isPending}
        onConfirm={confirm}
      />
    </Panel>
  )
}
