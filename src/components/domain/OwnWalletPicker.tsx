import { ChevronDown } from 'lucide-react'
import { formatAccount } from '@/lib/format'

export interface OwnWallet {
  /** The wallet's full account id: what the destination becomes. */
  accountId: string
  name: string
}

/**
 * A shortcut for a send's destination: one of the user's own NearKit wallets, by name. It only
 * fills the field with that wallet's full account id; the address is still checked, reviewed and
 * (when the custody rules ask for it) approved like any other. Nothing is sent from here.
 */
export function OwnWalletPicker({ wallets, value, onPick, exclude }: { wallets: readonly OwnWallet[]; value: string; onPick: (accountId: string) => void; exclude?: string }) {
  const choices = wallets.filter((w) => w.accountId !== exclude)
  if (choices.length === 0) return null
  const picked = choices.some((w) => w.accountId === value.trim()) ? value.trim() : ''
  return (
    <span className="relative inline-flex items-center">
      <select
        aria-label="Pick one of my NearKit wallets as the destination"
        value={picked}
        onChange={(e) => {
          if (e.target.value) onPick(e.target.value)
        }}
        className="keycap max-w-40 cursor-pointer appearance-none truncate py-0 pl-2 pr-5 text-2xs text-fg-3 hover:text-fg focus:text-fg"
      >
        <option value="">My wallets</option>
        {choices.map((w) => (
          <option key={w.accountId} value={w.accountId}>
            {`${w.name} · ${formatAccount(w.accountId, 16)}`}
          </option>
        ))}
      </select>
      <ChevronDown size={11} aria-hidden="true" className="pointer-events-none absolute right-1.5 text-fg-3" />
    </span>
  )
}
