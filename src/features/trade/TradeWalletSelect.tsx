import { Select } from '@/components/ui/Form'
import type { Wallet } from '@/types/domain'

/** The ticket's wallet picker: NearKit wallets and the connected wallet's accounts, labelled as such. */
export function TradeWalletSelect({
  value,
  onChange,
  nearkit,
  browser,
  label,
  className,
}: {
  value: string
  onChange: (walletId: string) => void
  nearkit: readonly Wallet[]
  browser: readonly Wallet[]
  label: string
  className?: string
}) {
  return (
    <Select selectSize="sm" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={className}>
      {nearkit.length > 0 && (
        <optgroup label="NEARKITS wallets">
          {nearkit.map((w) => (
            <option key={w.id} value={w.id}>
              {w.label}
            </option>
          ))}
        </optgroup>
      )}
      {browser.length > 0 &&
        (nearkit.length > 0 ? (
          <optgroup label="Connected wallet">
            {browser.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
              </option>
            ))}
          </optgroup>
        ) : (
          browser.map((w) => (
            <option key={w.id} value={w.id}>
              {w.label}
            </option>
          ))
        ))}
    </Select>
  )
}
