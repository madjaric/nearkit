import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { cn } from '@/lib/cn'

export type ButtonVariant = 'primary' | 'sell' | 'secondary' | 'ghost' | 'danger' | 'outline' | 'quiet-buy' | 'quiet-sell'
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg'

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink hover:bg-accent-hi active:bg-accent disabled:bg-raised disabled:text-fg-3',
  sell: 'bg-neg-solid text-neg-ink hover:bg-neg-hi active:bg-neg-solid disabled:bg-raised disabled:text-fg-3',
  secondary: 'border border-line bg-raised text-fg hover:border-line-strong hover:bg-hover disabled:opacity-40',
  outline: 'border border-accent/45 text-accent hover:border-accent hover:bg-accent/8 disabled:opacity-40',
  ghost: 'text-fg-2 hover:bg-raised hover:text-fg disabled:opacity-40',
  danger: 'border border-line text-neg hover:border-neg/60 hover:bg-neg/10 disabled:opacity-40',
  // Row-level trade keys: quiet at rest so the one lit color keeps its meaning.
  'quiet-buy': 'border border-line text-fg-2 hover:border-accent/60 hover:text-accent focus-visible:text-accent disabled:opacity-40',
  'quiet-sell': 'border border-line text-fg-2 hover:border-neg/60 hover:text-neg focus-visible:text-neg disabled:opacity-40',
}

const SIZE: Record<ButtonSize, string> = {
  xs: 'h-6 gap-1 px-2 text-2xs',
  sm: 'h-7 gap-1.5 px-2.5 text-xs',
  md: 'h-8 gap-2 px-3 text-xs',
  lg: 'h-10 gap-2 px-4 text-xs',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  icon?: ReactNode
  iconRight?: ReactNode
  block?: boolean
  ref?: Ref<HTMLButtonElement>
}

/** Every button is a key: uppercase, tracked, one shape across the app. */
export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  iconRight,
  block = false,
  className,
  children,
  disabled,
  type = 'button',
  ref,
  ...rest
}: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'keycap relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-sm transition-colors duration-150',
        'disabled:cursor-not-allowed',
        VARIANT[variant],
        SIZE[size],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Working /> : icon}
      {children}
      {!loading && iconRight}
    </button>
  )
}

/** Small square "working" indicator used inside keys instead of a spinner. */
export function Working({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn('inline-flex items-center gap-[3px]', className)}>
      <span className="size-1 animate-ghost rounded-[1px] bg-current" />
      <span className="size-1 animate-ghost rounded-[1px] bg-current [animation-delay:150ms]" />
      <span className="size-1 animate-ghost rounded-[1px] bg-current [animation-delay:300ms]" />
    </span>
  )
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  size?: 'sm' | 'md'
  tone?: 'default' | 'danger'
  ref?: Ref<HTMLButtonElement>
}

export function IconButton({ label, size = 'md', tone = 'default', className, children, type = 'button', ref, ...rest }: IconButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        'inline-grid shrink-0 place-items-center rounded-sm text-fg-3 transition-colors duration-150 hover:bg-raised disabled:cursor-not-allowed disabled:opacity-40',
        tone === 'danger' ? 'hover:text-neg' : 'hover:text-fg',
        size === 'sm' ? 'size-7' : 'size-8',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}
