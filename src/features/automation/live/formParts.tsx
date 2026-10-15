import type { ReactNode } from 'react'
import { TokenSelect } from '@/components/domain/TokenSelect'
import { Figures } from '@/components/ui/Figures'
import { AmountInput, Field, Segmented, Select } from '@/components/ui/Form'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { NATIVE_TOKEN_ID } from '@/config/networks'
import { EXPIRY_CHOICES, SLIPPAGE_CHOICES, type ExpiryChoice } from './model'

/**
 * The frame every automation form shares, so the four read alike: the panel and its head, the
 * fields on a grid that sets two side by side once the form itself is wide enough (its own width,
 * not the window's: the same form is a full-width page section on a laptop and one column on a
 * phone), then the review key, what blocks it and the terms across the full width.
 */
export function AutomationFormPanel({
  title,
  actions,
  children,
  footer,
  dialog,
}: {
  title: ReactNode
  actions?: ReactNode
  children: ReactNode
  footer: ReactNode
  dialog: ReactNode
}) {
  return (
    <Panel className="@container">
      <PanelHeader title={title} actions={actions} />
      <div className="flex flex-col gap-5 p-4 @2xl:px-5 @2xl:pb-5">
        <div data-form-grid className="grid grid-cols-1 gap-4 *:min-w-0 @xl:grid-cols-2 @xl:gap-x-5">
          {children}
        </div>
        {footer}
      </div>
      {dialog}
    </Panel>
  )
}

/** A field, or a group of them, across both columns of the form's grid: the target, a token, a long list, a notice. */
export function Wide({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-4 @xl:col-span-2">{children}</div>
}

/**
 * Two short figures that stay side by side even in one column (a phone): on the two-column grid
 * the wrapper steps aside (`contents`) and each is a cell of its own.
 */
export function Pair({ children }: { children: ReactNode }) {
  return <div className="grid min-w-0 grid-cols-2 gap-3 *:min-w-0 @xl:contents">{children}</div>
}

/** Fields that belong together in one cell of the grid (a choice and the field it opens), one above the other. */
export function Stack({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-4">{children}</div>
}

/** The review key across the form's full width, then the reason it can't go on (if any) and the terms. */
export function ReviewFooter({ action, failure, issues, terms }: { action: ReactNode; failure: string | null; issues: readonly { message: string }[] | null; terms: string }) {
  return (
    <div className="flex flex-col gap-2 border-t border-line-soft pt-4">
      {action}
      {failure && (
        <p className="text-xs text-neg" role="alert">
          <Figures>{failure}</Figures>
        </p>
      )}
      {issues && issues.length > 0 && (
        <p className="text-xs text-neg">
          <Figures>{`${issues.length} field${issues.length === 1 ? ' needs' : 's need'} a look: ${issues[0]?.message}`}</Figures>
        </p>
      )}
      <p className="max-w-[86ch] text-xs leading-5 text-fg-3">
        <Figures>{terms}</Figures>
      </p>
    </div>
  )
}

/** Form controls the automation forms share. */

export function SlippageField({ value, onChange, error }: { value: number; onChange: (v: number) => void; error?: string }) {
  return (
    <Field label="Slippage" error={error} hint="The least the trade accepts at the moment it runs; the chain enforces the minimum received.">
      {() => (
        <Segmented
          label="Slippage"
          block
          size="sm"
          value={String(value)}
          onChange={(v) => onChange(Number(v))}
          options={SLIPPAGE_CHOICES.map((v) => ({ value: String(v), label: `${v}%` }))}
        />
      )}
    </Field>
  )
}

export function ExpiryField({ value, onChange, error, label = 'Expires' }: { value: ExpiryChoice; onChange: (v: ExpiryChoice) => void; error?: string; label?: string }) {
  return (
    <Field label={label} error={error}>
      {({ id }) => (
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value as ExpiryChoice)}>
          {EXPIRY_CHOICES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>
      )}
    </Field>
  )
}

export function NumberField({
  label,
  value,
  onChange,
  unit,
  error,
  hint,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  unit?: string
  error?: string
  hint?: string
  placeholder?: string
}) {
  return (
    <Field label={label} error={error} hint={hint}>
      {({ id, describedBy, invalid }) => (
        <AmountInput id={id} size="sm" value={value} onValueChange={onChange} unit={unit} placeholder={placeholder} aria-describedby={describedBy} aria-invalid={invalid} />
      )}
    </Field>
  )
}

export function TokenField({ tokenId, onChange, error, walletId }: { tokenId: string; onChange: (id: string) => void; error?: string; walletId?: string }) {
  return (
    <Field label="Token (against NEAR)" error={error}>
      {({ id }) => <TokenSelect id={id} label="Token" value={tokenId || NATIVE_TOKEN_ID} onChange={onChange} exclude={[NATIVE_TOKEN_ID]} walletId={walletId} />}
    </Field>
  )
}
