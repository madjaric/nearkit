import { X } from 'lucide-react'
import { useState, type KeyboardEvent } from 'react'
import { cn } from '@/lib/cn'

interface ChipInputProps {
  value: string[]
  onChange: (value: string[]) => void
  placeholder?: string
  label: string
  id?: string
  /** Normalize or reject an entry; return null to reject. */
  normalize?: (raw: string) => string | null
}

/** Free-form list entry: Enter or comma adds a chip, Backspace on empty removes the last. */
export function ChipInput({ value, onChange, placeholder, label, id, normalize = (s) => s.trim() || null }: ChipInputProps) {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  const commit = () => {
    const next = normalize(draft)
    if (next === null) {
      if (draft.trim()) setError(`“${draft.trim()}” isn't a token symbol or contract`)
      return
    }
    if (value.includes(next)) {
      setError(`${next} is already listed`)
      return
    }
    onChange([...value, next])
    setDraft('')
    setError(null)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1))
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={cn(
          'flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border bg-well px-2 py-1.5 transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20',
          error ? 'border-neg' : 'border-line-strong hover:border-fg-4',
        )}
      >
        {value.map((chip) => (
          <span key={chip} className="num inline-flex h-6 items-center gap-1 rounded-xs border border-line bg-raised pl-2 pr-1 text-xs text-fg-2">
            {chip}
            <button
              type="button"
              aria-label={`Remove ${chip}`}
              onClick={() => onChange(value.filter((c) => c !== chip))}
              className="grid size-4 place-items-center rounded-[2px] text-fg-4 hover:bg-hover hover:text-fg"
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          id={id}
          aria-label={label}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            setError(null)
          }}
          onKeyDown={onKeyDown}
          onBlur={() => draft && commit()}
          placeholder={value.length ? '' : placeholder}
          className="num min-w-24 flex-1 bg-transparent text-sm text-fg placeholder:font-sans placeholder:text-fg-3 focus:outline-none"
        />
      </div>
      {error && <p className="text-xs text-neg">{error}</p>}
    </div>
  )
}
