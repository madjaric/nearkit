import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { cn } from '@/lib/cn'
import { Popover, type Placement } from './Floating'

export type MenuEntry =
  | { kind?: 'item'; label: ReactNode; icon?: ReactNode; onSelect: () => void; tone?: 'danger'; disabled?: boolean; hint?: ReactNode }
  | { kind: 'divider' }
  | { kind: 'heading'; label: ReactNode }

interface TriggerProps {
  ref: Ref<HTMLButtonElement>
  onClick: () => void
  'aria-haspopup': 'menu'
  'aria-expanded': boolean
  'aria-controls': string
}

interface MenuProps {
  trigger: (props: TriggerProps) => ReactNode
  entries: MenuEntry[]
  label: string
  placement?: Placement
  className?: string
  header?: ReactNode
}

/** Dropdown menu with arrow-key navigation; focus returns to the trigger on close. */
export function Menu({ trigger, entries, label, placement = 'bottom-end', className, header }: MenuProps) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  const close = (restoreFocus = true) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }

  useEffect(() => {
    if (open) itemRefs.current.find((el) => el && !el.disabled)?.focus()
  }, [open])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = itemRefs.current.filter((el): el is HTMLButtonElement => Boolean(el && !el.disabled))
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      items[(index + 1) % items.length]?.focus()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      items[(index - 1 + items.length) % items.length]?.focus()
    } else if (event.key === 'Home') {
      event.preventDefault()
      items[0]?.focus()
    } else if (event.key === 'End') {
      event.preventDefault()
      items[items.length - 1]?.focus()
    } else if (event.key === 'Tab') {
      close(false)
    }
  }

  // Focus order counts only actionable items; dividers and headings are skipped.
  const focusIndex: number[] = []
  let count = 0
  for (const entry of entries) focusIndex.push(entry.kind === 'divider' || entry.kind === 'heading' ? -1 : count++)

  return (
    <>
      {trigger({
        ref: triggerRef,
        onClick: () => setOpen((o) => !o),
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': id,
      })}
      <Popover anchorRef={triggerRef} open={open} onClose={() => close()} placement={placement} role="presentation" className={cn('min-w-52 py-1', className)}>
        {header}
        <div id={id} role="menu" aria-label={label} onKeyDown={onKeyDown}>
          {entries.map((entry, i) => {
            if (entry.kind === 'divider') return <div key={`d${i}`} role="separator" className="my-1 h-px bg-line-soft" />
            if (entry.kind === 'heading')
              return (
                <div key={`h${i}`} className="legend px-3 pb-1 pt-2">
                  {entry.label}
                </div>
              )
            const at = focusIndex[i] ?? i
            return (
              <button
                key={`i${i}`}
                ref={(el) => {
                  itemRefs.current[at] = el
                }}
                type="button"
                role="menuitem"
                disabled={entry.disabled}
                onClick={() => {
                  close()
                  entry.onSelect()
                }}
                className={cn(
                  'flex h-8 w-full items-center gap-2.5 px-3 text-left text-sm outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                  entry.tone === 'danger'
                    ? 'text-neg hover:bg-neg/10 focus-visible:bg-neg/10'
                    : 'text-fg-2 hover:bg-hover hover:text-fg focus-visible:bg-hover focus-visible:text-fg',
                )}
              >
                {entry.icon && <span className="grid size-4 place-items-center text-fg-3">{entry.icon}</span>}
                <span className="flex-1 truncate">{entry.label}</span>
                {entry.hint && <span className="text-xs text-fg-4">{entry.hint}</span>}
              </button>
            )
          })}
        </div>
      </Popover>
    </>
  )
}
