import { TokenSelect } from '@/components/domain/TokenSelect'
import { AmountInput, Field, Segmented, Select } from '@/components/ui/Form'
import { NATIVE_TOKEN_ID } from '@/config/networks'
import { EXPIRY_CHOICES, SLIPPAGE_CHOICES, type ExpiryChoice } from './model'

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
