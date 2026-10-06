import { Select } from '@/components/ui/Form'
import { formatAccount } from '@/lib/format'
import { executesViaNearKit } from '@/lib/wallets'
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
  /** List NEARKITS wallets and the connected wallet's accounts under their own headings (two may share a name, such as "Main"). */
  groupBySource?: boolean
}

export function WalletSelect({
  value,
  onChange,
  wallets,
  exclude = [],
  id,
  label,
  size = 'md',
  className,
  describedBy,
  extraOption,
  showAccount = true,
  groupBySource = false,
}: WalletSelectProps) {
  const shown = wallets.filter((w) => !exclude.includes(w.id) || w.id === value)
  const options = (list: Wallet[]) =>
    list.map((w) => (
      <option key={w.id} value={w.id}>
        {showAccount ? `${w.label} · ${formatAccount(w.accountId, 20)}` : w.label}
      </option>
    ))
  const nearkit = shown.filter(executesViaNearKit)
  const others = shown.filter((w) => !executesViaNearKit(w))
  return (
    <Select id={id} aria-label={label} aria-describedby={describedBy} selectSize={size} value={value} onChange={(e) => onChange(e.target.value)} className={className}>
      {groupBySource && nearkit.length > 0 && others.length > 0 ? (
        <>
          <optgroup label="NEARKITS wallets">{options(nearkit)}</optgroup>
          <optgroup label="Connected wallet">{options(others)}</optgroup>
        </>
      ) : (
        options(shown)
      )}
      {extraOption && <option value={extraOption.value}>{extraOption.label}</option>}
    </Select>
  )
}
