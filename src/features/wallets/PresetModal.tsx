import { useState } from 'react'
import { AccountText } from '@/components/domain/Account'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Dialog'
import { Figures } from '@/components/ui/Figures'
import { Checkbox, Field, Input } from '@/components/ui/Form'
import { Tag } from '@/components/ui/Indicators'
import { formatAmount } from '@/lib/format'
import { canExecute, executesViaNearKit } from '@/lib/wallets'
import { usePresetMutations } from '@/services/queries'
import type { WalletPreset, WalletSnapshot } from '@/types/domain'

interface PresetModalProps {
  /** Preset being edited, or null to create one. */
  preset: WalletPreset | null
  open: boolean
  onClose: () => void
  wallets: WalletSnapshot[]
  onSaved: (preset: WalletPreset, created: boolean) => void
}

export function PresetModal({ preset, open, onClose, wallets, onSaved }: PresetModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={preset ? `Edit ${preset.name}` : 'Create preset'}
      description="A preset is a saved group of wallets for multi-wallet tools."
    >
      <PresetForm key={preset?.id ?? 'new'} preset={preset} onClose={onClose} wallets={wallets} onSaved={onSaved} />
    </Modal>
  )
}

function PresetForm({ preset, onClose, wallets, onSaved }: Omit<PresetModalProps, 'open'>) {
  const { create, update } = usePresetMutations()
  const [name, setName] = useState(preset?.name ?? '')
  const [note, setNote] = useState(preset?.note ?? '')
  // A preset trades together: only wallets that can trade go in. A saved one holding a watch-only
  // wallet (from before) loses it here, and says so.
  const executable = wallets.filter(canExecute)
  const [ids, setIds] = useState<string[]>(() => (preset?.walletIds ?? []).filter((id) => executable.some((w) => w.id === id)))
  const dropped = (preset?.walletIds ?? []).filter((id) => wallets.some((w) => w.id === id && !canExecute(w)))
  const [touched, setTouched] = useState(false)
  const mutation = preset ? update : create
  const nameError = touched && !name.trim() ? 'Give the preset a name' : null
  const walletError = touched && ids.length === 0 ? 'Select at least one wallet' : null
  const serverError = mutation.error instanceof Error ? mutation.error.message : null
  const allOn = executable.length > 0 && ids.length === executable.length
  const totalNear = wallets.filter((w) => ids.includes(w.id)).reduce((s, w) => s + w.nearBalance, 0)

  const submit = () => {
    setTouched(true)
    if (!name.trim() || ids.length === 0) return
    const input = { name, note, walletIds: ids }
    const done = (saved: WalletPreset) => onSaved(saved, !preset)
    if (preset) update.mutate({ id: preset.id, input }, { onSuccess: done })
    else create.mutate(input, { onSuccess: done })
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_1.4fr]">
        <Field label="Name" error={nameError ?? (serverError?.toLowerCase().includes('name') ? serverError : undefined)} hint="Stored uppercase, 24 characters max">
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              value={name}
              maxLength={24}
              onChange={(e) => setName(e.target.value)}
              placeholder="SCALPERS"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              autoFocus
              className="uppercase"
            />
          )}
        </Field>
        <Field label="Note">{({ id }) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What this group is for" />}</Field>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 flex w-full items-center justify-between">
          <span className="legend">Wallets · {ids.length} selected</span>
          <Checkbox
            checked={allOn}
            indeterminate={ids.length > 0 && !allOn}
            onChange={() => setIds(allOn ? [] : executable.map((w) => w.id))}
            label="All"
            labelClassName="text-xs"
          />
        </legend>
        <ul className="grid max-h-64 grid-cols-1 overflow-y-auto rounded-sm border border-line sm:grid-cols-2">
          {wallets.map((w) => (
            <li key={w.id} className="border-b border-line-soft px-3 py-2 last:border-b-0 sm:[&:nth-last-child(2)]:border-b-0">
              <Checkbox
                checked={ids.includes(w.id)}
                disabled={!canExecute(w)}
                onChange={() => setIds((list) => (list.includes(w.id) ? list.filter((x) => x !== w.id) : [...list, w.id]))}
                label={
                  <span className="flex flex-col">
                    <span className="flex items-center gap-1.5 text-sm text-fg">
                      {w.label}
                      {!canExecute(w) && (
                        <Tag tone="soon" title="Watch-only wallets can't trade, so they can't be in a preset.">
                          Watch only
                        </Tag>
                      )}
                      {executesViaNearKit(w) && <Tag title="A NearKit wallet: its trades are confirmed in Telegram.">NearKit</Tag>}
                    </span>
                    <span className="flex gap-2 text-[11px] text-fg-4">
                      <AccountText id={w.accountId} />
                      <span className="num">{formatAmount(w.nearBalance, 2)} NEAR</span>
                    </span>
                  </span>
                }
              />
            </li>
          ))}
        </ul>
        {walletError && <p className="text-xs text-neg">{walletError}</p>}
        {dropped.length > 0 && (
          <p className="text-xs text-warn">
            {dropped.length === 1 ? '1 watch-only wallet was' : `${dropped.length} watch-only wallets were`} in this preset. Watch-only wallets can’t trade, so saving removes{' '}
            {dropped.length === 1 ? 'it' : 'them'}.
          </p>
        )}
        <p className="text-xs text-fg-3">
          <Figures>{`${formatAmount(totalNear, 2)} NEAR across the selection`}</Figures>
        </p>
      </fieldset>

      {serverError && !serverError.toLowerCase().includes('name') && <p className="text-sm text-neg">{serverError}</p>}

      <div className="flex flex-col-reverse gap-2 border-t border-line-soft pt-4 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={mutation.isPending}>
          {preset ? 'Save changes' : 'Create preset'}
        </Button>
      </div>
    </form>
  )
}
