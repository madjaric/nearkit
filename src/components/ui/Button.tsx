import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { cn } from '@/lib/cn'
import { buttonClass, type ButtonSize, type ButtonVariant } from './buttonClass'

export type { ButtonSize, ButtonVariant } from './buttonClass'

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
    <button ref={ref} type={type} disabled={disabled || loading} aria-busy={loading || undefined} className={buttonClass({ variant, size, block, className })} {...rest}>
      {loading ? <Working /> : icon}
      {children}
      {!loading && iconRight}
    </button>
  )
}

/** Small "working" indicator used inside keys instead of a spinner. */
export function Working({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn('inline-flex items-center gap-[3px]', className)}>
      <span className="size-1 animate-ghost rounded-full bg-current" />
      <span className="size-1 animate-ghost rounded-full bg-current [animation-delay:150ms]" />
      <span className="size-1 animate-ghost rounded-full bg-current [animation-delay:300ms]" />
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
        'inline-grid shrink-0 place-items-center rounded-md text-fg-3 transition-colors duration-150 hover:bg-raised disabled:cursor-not-allowed disabled:opacity-40',
        tone === 'danger' ? 'hover:text-neg' : 'hover:text-fg',
        size === 'sm' ? 'size-8' : 'size-9',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}
