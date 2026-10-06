import { ChevronDown } from 'lucide-react'
import { formatAccount } from '@/lib/format'

export interface OwnWallet {
  /** The wallet's full account id: what the destination becomes. */
  accountId: string
  name: string
}

/**
 * A shortcut for a send's destination: one of the user's own NearKit wallets, by name. It only
 * fills the field with that wallet's full account id; the address is still checked and reviewed.
 * A wallet under the same owner needs no approval (the signer checks it); one with another owner is
 * approved like any other address. Nothing is sent from here.
 */
export function OwnWalletPicker({ wallets, value, onPick, exclude }: { wallets: readonly OwnWallet[]; value: string; onPick: (accountId: string) => void; exclude?: string }) {
  const choices = wallets.filter((w) => w.accountId !== exclude)
  if (choices.length === 0) return null
  const picked = choices.some((w) => w.accountId === value.trim()) ? value.trim() : ''
  return (
    <span className="relative inline-flex items-center">
      <select
        aria-label="Pick one of my NEARKITS wallets as the destination"
        value={picked}
        onChange={(e) => {
          if (e.target.value) onPick(e.target.value)
        }}
        // A native select (keyboard and screen readers as usual), drawn dark: its own surface and
        // readable text, and options that don't inherit a dim color onto the dropdown's surface.
        className="h-7 max-w-48 cursor-pointer appearance-none truncate rounded-sm border border-line-strong bg-well py-0 pl-2 pr-6 text-xs text-fg-2 transition-colors hover:border-fg-4 hover:text-fg focus:border-accent focus:text-fg focus:outline-none focus:ring-2 focus:ring-accent/20 [&>option]:bg-raised [&>option]:text-fg"
      >
        <option value="">My wallets</option>
        {choices.map((w) => (
          <option key={w.accountId} value={w.accountId}>
            {`${w.name} · ${formatAccount(w.accountId, 16)}`}
          </option>
        ))}
      </select>
      <ChevronDown size={12} aria-hidden="true" className="pointer-events-none absolute right-2 text-fg-2" />
    </span>
  )
}
