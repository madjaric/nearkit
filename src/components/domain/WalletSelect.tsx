import { Select } from '@/components/ui/Form'
import { formatAccount } from '@/lib/format'
import type { Wallet } from '@/types/domain'

interface WalletSelectProps {
  value: string
  onChange: (id: string) => void
  wallets: Wallet[]
  exclude?: string[]
  id?: string
  label?: string
  size?: 'sm' | 'md'
  className?: string
  describedBy?: string
  /** Extra trailing option (e.g. "External account…"). */
  extraOption?: { value: string; label: string }
  /** Print the account after the label (off where the account is shown alongside). */
  showAccount?: boolean
}

export function WalletSelect({ value, onChange, wallets, exclude = [], id, label, size = 'md', className, describedBy, extraOption, showAccount = true }: WalletSelectProps) {
  return (
    <Select id={id} aria-label={label} aria-describedby={describedBy} selectSize={size} value={value} onChange={(e) => onChange(e.target.value)} className={className}>
      {wallets
        .filter((w) => !exclude.includes(w.id) || w.id === value)
        .map((w) => (
          <option key={w.id} value={w.id}>
            {showAccount ? `${w.label} · ${formatAccount(w.accountId, 20)}` : w.label}
          </option>
        ))}
      {extraOption && <option value={extraOption.value}>{extraOption.label}</option>}
    </Select>
  )
}
