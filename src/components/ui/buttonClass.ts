import { cn } from '@/lib/cn'

export type ButtonVariant = 'primary' | 'sell' | 'secondary' | 'ghost' | 'danger' | 'outline' | 'quiet-buy' | 'quiet-sell'
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink hover:bg-accent-hi active:bg-accent disabled:bg-raised disabled:text-fg-3',
  sell: 'bg-neg-solid text-neg-ink hover:bg-neg-hi active:bg-neg-solid disabled:bg-raised disabled:text-fg-3',
  secondary: 'border border-line bg-panel text-fg hover:border-line-strong hover:bg-raised disabled:opacity-40',
  outline: 'border border-accent/45 text-accent hover:border-accent hover:bg-accent/8 disabled:opacity-40',
  ghost: 'text-fg-2 hover:bg-raised hover:text-fg disabled:opacity-40',
  danger: 'border border-line text-neg hover:border-neg/60 hover:bg-neg/10 disabled:opacity-40',
  // Row-level trade keys: bordered on the panel; Buy carries the accent, Sell lights red only on hover.
  'quiet-buy': 'border border-line bg-panel text-accent hover:border-accent/50 hover:bg-accent/10 disabled:opacity-40',
  'quiet-sell': 'border border-line bg-panel text-fg hover:border-neg/50 hover:bg-neg/10 hover:text-neg focus-visible:text-neg disabled:opacity-40',
}

const SIZE: Record<ButtonSize, string> = {
  xs: 'h-7 gap-1 px-2.5 text-2xs',
  sm: 'h-8 gap-1.5 px-3 text-xs',
  md: 'h-9 gap-2 px-4 text-xs',
  lg: 'h-10 gap-2 px-5 text-sm',
  xl: 'h-13 gap-2 px-6 text-sm',
}

/** The one key shape, for a `<button>` (Button) or a link that acts as one. */
export function buttonClass({
  variant = 'secondary',
  size = 'md',
  block = false,
  className,
}: { variant?: ButtonVariant; size?: ButtonSize; block?: boolean; className?: string } = {}) {
  return cn(
    'keycap relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-md transition-colors duration-150',
    'disabled:cursor-not-allowed',
    VARIANT[variant],
    SIZE[size],
    block && 'w-full',
    className,
  )
}
