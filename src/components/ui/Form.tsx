import { Check, ChevronDown, Minus } from 'lucide-react'
import { useEffect, useId, useRef, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type Ref, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'
import { Figures } from './Figures'
import { fitFigure } from './fitFigure'

// ─── field wrapper ──────────────────────────────────────────────────────────

interface FieldProps {
  label: ReactNode
  /** Right side of the label row: balance, helper action, info tip. */
  aside?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  warning?: ReactNode
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode
  className?: string
  labelHidden?: boolean
}

/** Label, control, then one line of hint / warning / error. The id wiring is handled here. */
export function Field({ label, aside, hint, error, warning, children, className, labelHidden = false }: FieldProps) {
  const id = useId()
  const messageId = `${id}-msg`
  const message = error ?? warning ?? hint
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className={cn('flex min-h-4 items-center justify-between gap-3', labelHidden && 'sr-only')}>
        <label htmlFor={id} className="legend">
          {label}
        </label>
        {aside && <div className="flex items-center gap-2 text-xs text-fg-3">{aside}</div>}
      </div>
      {children({ id, describedBy: message ? messageId : undefined, invalid: Boolean(error) })}
      {message && (
        <p id={messageId} className={cn('text-xs leading-4', error ? 'text-neg' : warning ? 'text-warn' : 'text-fg-3')} role={error ? 'alert' : undefined}>
          <Figures>{message}</Figures>
        </p>
      )}
    </div>
  )
}

// ─── inputs ─────────────────────────────────────────────────────────────────

export const controlBase =
  'w-full rounded-md border border-line-strong bg-well text-fg transition-[border-color,box-shadow] duration-150 placeholder:text-fg-3 hover:border-fg-4 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 aria-[invalid=true]:border-neg aria-[invalid=true]:focus:ring-neg/20 disabled:cursor-not-allowed disabled:opacity-50'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean
  inputSize?: 'sm' | 'md'
  ref?: Ref<HTMLInputElement>
}

export function Input({ className, mono = false, inputSize = 'md', ref, ...rest }: InputProps) {
  return (
    <input ref={ref} className={cn(controlBase, inputSize === 'sm' ? 'h-9 px-3 text-sm' : 'h-10 px-3.5 text-base', mono && 'num placeholder:font-sans', className)} {...rest} />
  )
}

export function Textarea({ className, ref, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea ref={ref} className={cn(controlBase, 'num min-h-32 resize-y px-3 py-2.5 text-sm leading-6', className)} {...rest} />
}

interface AmountInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'size'> {
  value: string
  onValueChange: (value: string) => void
  unit?: ReactNode
  /** A control inside the field, at its right edge (a token chip). */
  trailing?: ReactNode
  size?: 'sm' | 'md' | 'lg'
  ref?: Ref<HTMLInputElement>
}

/** Numeric entry with its unit printed inside the field. Accepts digits and one decimal point. */
export function AmountInput({ value, onValueChange, unit, trailing, size = 'md', className, ref, style, ...rest }: AmountInputProps) {
  return (
    <div
      className={cn(
        'flex items-center rounded-md border border-line-strong bg-well transition-[border-color,box-shadow] duration-150 hover:border-fg-4',
        'focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20 has-[input[aria-invalid=true]]:border-neg has-[input[aria-invalid=true]]:focus-within:ring-neg/20',
        size === 'lg' ? 'h-16' : size === 'sm' ? 'h-9' : 'h-11',
        className,
      )}
    >
      <div className="@container h-full min-w-0 flex-1">
        <input
          ref={ref}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => {
            const next = e.target.value.replace(',', '.')
            if (next === '' || /^\d*\.?\d*$/.test(next)) onValueChange(next)
          }}
          className={cn(
            'num h-full w-full min-w-0 bg-transparent px-3.5 text-fg placeholder:text-fg-4 focus:outline-none',
            size === 'lg' ? 'text-3xl' : size === 'sm' ? 'text-sm' : 'text-lg',
          )}
          style={size === 'lg' ? { fontSize: fitFigure((value || rest.placeholder || '').length), ...style } : style}
          {...rest}
        />
      </div>
      {unit && <span className={cn('shrink-0 pr-3.5 font-semibold tracking-[0.04em] text-fg-3', size === 'lg' ? 'text-sm' : 'text-xs')}>{unit}</span>}
      {trailing && <div className="flex shrink-0 items-center pr-3">{trailing}</div>}
    </div>
  )
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  selectSize?: 'sm' | 'md'
  ref?: Ref<HTMLSelectElement>
}

export function Select({ className, selectSize = 'md', children, ref, ...rest }: SelectProps) {
  return (
    <div className={cn('relative', className)}>
      <select ref={ref} className={cn(controlBase, 'appearance-none pr-8', selectSize === 'sm' ? 'h-9 pl-3 text-sm' : 'h-10 pl-3.5 text-base')} {...rest}>
        {children}
      </select>
      <ChevronDown size={14} aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-3" />
    </div>
  )
}

// ─── choice controls ────────────────────────────────────────────────────────

interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  label?: ReactNode
  indeterminate?: boolean
  labelClassName?: string
}

/** Square check that lights up like a panel lamp when selected. */
export function Checkbox({ label, indeterminate = false, className, labelClassName, ...rest }: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate
  }, [indeterminate])
  return (
    <label className={cn('inline-flex select-none items-center gap-2', rest.disabled ? 'cursor-not-allowed' : 'cursor-pointer', className)}>
      <input ref={ref} type="checkbox" className="peer sr-only" {...rest} />
      <span
        aria-hidden="true"
        className={cn(
          'grid size-4 shrink-0 place-items-center rounded-xs border border-line-strong bg-well text-transparent transition-colors duration-100',
          'peer-hover:border-fg-4 peer-checked:border-accent peer-checked:bg-accent peer-checked:text-accent-ink',
          'peer-indeterminate:border-accent peer-indeterminate:bg-accent/25 peer-indeterminate:text-accent',
          'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent peer-disabled:opacity-40',
        )}
      >
        {indeterminate ? <Minus size={11} strokeWidth={3} /> : <Check size={11} strokeWidth={3} />}
      </span>
      {label && <span className={cn('text-sm text-fg-2', labelClassName)}>{label}</span>}
    </label>
  )
}

interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
  id?: string
  /** Accessible name when the visible label describes the state rather than the setting. */
  ariaLabel?: string
}

export function Switch({ checked, onChange, label, description, disabled, ariaLabel }: SwitchProps) {
  const id = useId()
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm text-fg">
          {label}
        </label>
        {description && <p className="mt-0.5 text-xs text-fg-3">{description}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors duration-150 disabled:opacity-40',
          checked ? 'border-accent bg-accent' : 'border-line-strong bg-well',
        )}
      >
        <span
          aria-hidden="true"
          className={cn('absolute top-[3px] size-3 rounded-full transition-[left,background-color] duration-150', checked ? 'left-[19px] bg-accent-ink' : 'left-[3px] bg-fg-3')}
        />
      </button>
    </div>
  )
}

// ─── segmented control ──────────────────────────────────────────────────────

export interface SegmentOption<T extends string> {
  value: T
  label: ReactNode
  tone?: 'default' | 'buy' | 'sell'
  disabled?: boolean
}

interface SegmentedProps<T extends string> {
  value: T
  onChange: (value: T) => void
  options: SegmentOption<T>[]
  label: string
  size?: 'sm' | 'md' | 'lg'
  block?: boolean
  className?: string
}

const TONE_ON = {
  default: 'bg-raised text-fg shadow-[inset_0_0_0_1px_var(--color-line-strong)]',
  buy: 'bg-accent text-accent-ink',
  sell: 'bg-neg-solid text-neg-ink',
}

/** Radio group drawn as panel keys. Arrow keys move the selection. */
export function Segmented<T extends string>({ value, onChange, options, label, size = 'md', block = false, className }: SegmentedProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const enabled = options.filter((o) => !o.disabled)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const current = enabled.findIndex((o) => o.value === value)
    let next = current
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (current + 1) % enabled.length
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (current - 1 + enabled.length) % enabled.length
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = enabled.length - 1
    const option = enabled[next]
    if (!option) return
    onChange(option.value)
    refs.current[options.indexOf(option)]?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn('gap-1 rounded-md border border-line bg-well p-1', block ? 'grid w-full auto-cols-fr grid-flow-col' : 'inline-flex', className)}
    >
      {options.map((option, index) => {
        const checked = option.value === value
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={option.disabled}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cn(
              'keycap truncate rounded-sm transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-40',
              block ? 'min-w-0 px-1' : size === 'sm' ? 'px-2.5' : 'px-3',
              size === 'sm' ? 'h-7 text-2xs' : size === 'lg' ? 'h-10 text-sm' : 'h-8 text-xs',
              checked ? TONE_ON[option.tone ?? 'default'] : 'text-fg-3 hover:bg-raised/60 hover:text-fg-2',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

// ─── tabs ───────────────────────────────────────────────────────────────────

interface TabsProps<T extends string> {
  value: T
  onChange: (value: T) => void
  tabs: { value: T; label: ReactNode; count?: number }[]
  label: string
  idBase: string
  className?: string
}

/** Tab strip. Panels use `tabPanelProps(idBase, value)` for aria wiring. */
export function Tabs<T extends string>({ value, onChange, tabs, label, idBase, className }: TabsProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    event.preventDefault()
    const i = tabs.findIndex((t) => t.value === value)
    const next = event.key === 'ArrowRight' ? (i + 1) % tabs.length : (i - 1 + tabs.length) % tabs.length
    const tab = tabs[next]
    if (tab) {
      onChange(tab.value)
      refs.current[next]?.focus()
    }
  }
  return (
    <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className={cn('flex items-end gap-5 border-b border-line', className)}>
      {tabs.map((tab, index) => {
        const selected = tab.value === value
        return (
          <button
            key={tab.value}
            ref={(el) => {
              refs.current[index] = el
            }}
            id={`${idBase}-tab-${tab.value}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`${idBase}-panel-${tab.value}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.value)}
            className={cn(
              'keycap relative -mb-px flex h-10 items-center gap-2 border-b-2 text-xs transition-colors duration-100',
              selected ? 'border-accent text-fg' : 'border-transparent text-fg-3 hover:text-fg-2',
            )}
          >
            {tab.label}
            {tab.count !== undefined && (
              <>
                {' '}
                <span className={cn('num text-2xs', selected ? 'text-fg-2' : 'text-fg-4')}>{tab.count}</span>
              </>
            )}
          </button>
        )
      })}
    </div>
  )
}
