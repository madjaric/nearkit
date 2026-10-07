import { AccountText } from '@/components/domain/Account'
import { WalletSelect } from '@/components/domain/WalletSelect'
import { Input } from '@/components/ui/Form'
import { cn } from '@/lib/cn'
import { choiceOf, EXTERNAL_RECIPIENT, recipientAccount, targetOf, type RecipientTarget } from '@/lib/recipientTarget'
import type { Wallet } from '@/types/domain'

/**
 * A recipient row's picker, the same in Split and Batch Send: the user's wallets, then "External
 * account…", which shows an input for the account. `exclude` (takenBy): the source wallet and the
 * wallets other rows already send to. `compact`: the phone layout, the select on its own line with
 * each wallet's account in its option.
 */
export function RecipientSelect({
  index,
  target,
  onChange,
  wallets,
  exclude,
  invalid = false,
  compact = false,
}: {
  /** The row's place (0 for the first): its labels say "Recipient 1". */
  index: number
  target: RecipientTarget
  onChange: (target: RecipientTarget) => void
  wallets: Wallet[]
  exclude: string[]
  invalid?: boolean
  compact?: boolean
}) {
  return (
    <div className={cn('flex min-w-0 gap-2', compact ? 'flex-col' : 'items-start')}>
      <WalletSelect
        size="sm"
        label={`Recipient ${index + 1}`}
        value={choiceOf(target)}
        onChange={(v) => onChange(targetOf(v))}
        wallets={wallets}
        exclude={exclude}
        extraOption={{ value: EXTERNAL_RECIPIENT, label: 'External account…' }}
        showAccount={compact}
        className={compact ? 'w-full' : 'w-44 shrink-0'}
      />
      {target.kind === 'account' ? (
        <Input
          inputSize="sm"
          mono
          aria-label={`Recipient ${index + 1} account ID`}
          placeholder="account.near"
          value={target.accountId}
          aria-invalid={invalid}
          onChange={(e) => onChange({ kind: 'account', accountId: e.target.value })}
          // Stacked (compact), flex-1 would size its height from 0 and squash the field; it takes the full width instead.
          className={compact ? 'w-full' : 'min-w-0 flex-1'}
        />
      ) : (
        !compact && <AccountText id={recipientAccount(target, wallets)} className="pt-1.5 text-xs text-fg-3" />
      )}
    </div>
  )
}
