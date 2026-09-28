import { useState } from 'react'
import { AccountText } from '@/components/domain/Account'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Dialog'
import { Figures } from '@/components/ui/Figures'
import { Tabs, Textarea } from '@/components/ui/Form'
import { tabPanelProps } from '@/components/ui/tabs'
import { cn } from '@/lib/cn'
import { parseRecipients } from '@/lib/recipients'
import { usePresets } from '@/services/queries'
import type { Wallet } from '@/types/domain'

export interface ImportedRow {
  account: string
  pct: number | null
}

interface ImportRecipientsProps {
  open: boolean
  onClose: () => void
  onImport: (rows: ImportedRow[], withPercents: boolean) => void
  wallets: Wallet[]
  sourceId: string
}

const PLACEHOLDER = ['alice.near, 40', 'bob.near, 35', 'carol.near, 25', '', '# or one account per line for an equal split'].join('\n')

export function ImportRecipients({ open, onClose, onImport, wallets, sourceId }: ImportRecipientsProps) {
  return (
    <Modal open={open} onClose={onClose} size="md" title="Import recipients" description="Replaces the current recipient list.">
      <ImportBody onImport={onImport} onClose={onClose} wallets={wallets} sourceId={sourceId} />
    </Modal>
  )
}

function ImportBody({ onImport, onClose, wallets, sourceId }: Omit<ImportRecipientsProps, 'open'>) {
  const { data: presets = [] } = usePresets()
  const [tab, setTab] = useState<'paste' | 'preset'>('paste')
  const [text, setText] = useState('')
  const [presetId, setPresetId] = useState<string | null>(null)
  const parsed = parseRecipients(text)
  const invalid = parsed.lines.filter((l) => l.error)
  const source = wallets.find((w) => w.id === sourceId)
  const preset = presets.find((p) => p.id === presetId)
  const presetWallets = preset ? wallets.filter((w) => preset.walletIds.includes(w.id) && w.id !== sourceId) : []

  return (
    <div className="flex flex-col gap-4">
      <Tabs
        idBase="import"
        label="Import source"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'paste', label: 'Paste list' },
          { value: 'preset', label: 'From preset' },
        ]}
      />
      {tab === 'paste' ? (
        <div {...tabPanelProps('import', 'paste')} className="flex flex-col gap-3 outline-none">
          <Textarea aria-label="Recipient list" placeholder={PLACEHOLDER} value={text} onChange={(e) => setText(e.target.value)} rows={7} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span className="text-fg-2">
              <span className="num text-fg">{parsed.valid.length}</span> valid
            </span>
            <span className={invalid.length ? 'text-neg' : 'text-fg-3'}>
              <span className="num">{invalid.length}</span> skipped
            </span>
            <span className="text-fg-3">{parsed.valid.length ? (parsed.withPercents ? 'Custom percentages' : 'Equal split') : ''}</span>
          </div>
          {invalid.length > 0 && (
            <ul className="max-h-28 overflow-y-auto rounded-sm border border-line-soft bg-well/50 px-3 py-2 text-xs">
              {invalid.map((l) => (
                <li key={l.line} className="flex gap-3 py-0.5">
                  <span className="num w-12 shrink-0 text-fg-4">line {l.line}</span>
                  <span className="num min-w-0 truncate text-fg-3">{l.account}</span>
                  <span className="ml-auto shrink-0 text-neg">{l.error}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={parsed.valid.length === 0}
              onClick={() =>
                onImport(
                  parsed.valid.map((l) => ({ account: l.account, pct: l.pct })),
                  parsed.withPercents,
                )
              }
            >
              Import {parsed.valid.length || ''} {parsed.valid.length === 1 ? 'recipient' : 'recipients'}
            </Button>
          </div>
        </div>
      ) : (
        <div {...tabPanelProps('import', 'preset')} className="flex flex-col gap-3 outline-none">
          <ul className="flex flex-col divide-y divide-line-soft rounded-sm border border-line" role="radiogroup" aria-label="Presets">
            {presets.map((p) => {
              const count = p.walletIds.filter((id) => id !== sourceId).length
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={presetId === p.id}
                    onClick={() => setPresetId(p.id)}
                    className={cn('flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors', presetId === p.id ? 'bg-accent/8' : 'hover:bg-raised/60')}
                  >
                    <span className={cn('grid size-3.5 place-items-center rounded-[2px] border', presetId === p.id ? 'border-accent' : 'border-line-strong')}>
                      {presetId === p.id && <span className="size-1.5 rounded-[1px] bg-accent" />}
                    </span>
                    <span className="keycap text-xs text-fg">{p.name}</span>
                    <span className="flex-1 truncate text-xs text-fg-3">{p.note}</span>
                    <span className="text-xs text-fg-2">
                      <Figures>{`${count} ${count === 1 ? 'wallet' : 'wallets'}`}</Figures>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          {preset && source && preset.walletIds.includes(sourceId) && <p className="text-xs text-fg-3">{source.label} is the source wallet, so it is left out.</p>}
          {presetWallets.length > 0 && (
            <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-3">
              {presetWallets.map((w) => (
                <span key={w.id} className="flex items-center gap-1">
                  <span className="text-fg-2">{w.label}</span> <AccountText id={w.accountId} className="text-fg-4" />
                </span>
              ))}
            </p>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={presetWallets.length === 0}
              onClick={() =>
                onImport(
                  presetWallets.map((w) => ({ account: w.accountId, pct: null })),
                  false,
                )
              }
            >
              Use {presetWallets.length || ''} wallets
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
