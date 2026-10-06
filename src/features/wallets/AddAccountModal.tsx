import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Dialog'
import { Field, Input } from '@/components/ui/Form'
import { accountIdError } from '@/lib/validation'
import { describeError } from '@/services/errors'
import { useAccountMutations, useCapabilities } from '@/services/queries'
import type { Wallet } from '@/types/domain'

interface AddAccountModalProps {
  open: boolean
  onClose: () => void
  onAdded: (wallet: Wallet) => void
}

/**
 * Adds an account to the account book by ID. It is watch-only: NearKit shows its
 * balances and it can receive, but it signs only when that account is connected
 * in a wallet. No key is ever entered here.
 */
export function AddAccountModal({ open, onClose, onAdded }: AddAccountModalProps) {
  return (
    <Modal open={open} onClose={onClose} size="sm" title="Add an account" description="Watch any NEAR account by its ID. No keys, nothing to sign.">
      <AddAccountForm onClose={onClose} onAdded={onAdded} />
    </Modal>
  )
}

function AddAccountForm({ onClose, onAdded }: Omit<AddAccountModalProps, 'open'>) {
  const caps = useCapabilities()
  const { add } = useAccountMutations()
  const [accountId, setAccountId] = useState('')
  const [label, setLabel] = useState('')
  const [touched, setTouched] = useState(false)
  const localError = touched ? accountIdError(accountId) : null
  const serverError = add.error ? describeError(add.error).message : null

  const submit = () => {
    setTouched(true)
    if (accountIdError(accountId)) return
    add.mutate({ accountId: accountId.trim(), label: label.trim() || undefined }, { onSuccess: onAdded })
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <Field label="Account ID" error={localError ?? serverError ?? undefined} hint={`An existing ${caps.networkLabel.toLowerCase()} account`}>
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            mono
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            placeholder={caps.network === 'mainnet' ? 'name.near' : 'name.testnet'}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="none"
            aria-describedby={describedBy}
            aria-invalid={invalid}
            autoFocus
          />
        )}
      </Field>
      <Field label="Label" hint="Optional, shown instead of the account ID">
        {({ id }) => <Input id={id} value={label} maxLength={24} onChange={(e) => setLabel(e.target.value)} placeholder="Cold storage" />}
      </Field>
      <p className="text-xs text-fg-3">
        Watch-only accounts show balances and can receive in Split and Batch send. To send from one, connect it in your wallet; NEARKITS asks when it is needed.
      </p>
      <div className="flex flex-col-reverse gap-2 border-t border-line-soft pt-4 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={add.isPending}>
          Add account
        </Button>
      </div>
    </form>
  )
}
