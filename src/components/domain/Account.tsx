import { CopyButton } from '@/components/ui/Copy'
import { cn } from '@/lib/cn'
import { formatAccount } from '@/lib/format'
import type { Wallet } from '@/types/domain'

/**
 * NEAR account in mono; implicit (hex) accounts are shortened with the full ID on hover.
 * `full` prints every character, wrapping instead of shortening: reviews use it so
 * two accounts that shorten alike can never look the same before signing.
 */
export function AccountText({ id, className, full = false }: { id: string; className?: string; full?: boolean }) {
  if (full) return <span className={cn('num break-all', className)}>{id}</span>
  return (
    <span className={cn('num truncate', className)} title={id}>
      {formatAccount(id)}
    </span>
  )
}

/** Wallet label with its account underneath (or inline when `inline`). */
export function WalletName({
  wallet,
  inline = false,
  copy = false,
  className,
}: {
  wallet: Pick<Wallet, 'label' | 'accountId' | 'isMain'>
  inline?: boolean
  copy?: boolean
  className?: string
}) {
  return (
    <span className={cn('flex min-w-0', inline ? 'items-center gap-2' : 'flex-col', className)}>
      <span className="flex items-center gap-1.5 text-sm font-medium text-fg">
        {wallet.label}
        {wallet.isMain && <span className="rounded-xs bg-raised px-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-fg-3">Main</span>}
      </span>
      <span className="flex min-w-0 items-center gap-0.5">
        <AccountText id={wallet.accountId} className="text-xs text-fg-3" />
        {copy && <CopyButton value={wallet.accountId} label="Copy account ID" className="size-5" />}
      </span>
    </span>
  )
}
