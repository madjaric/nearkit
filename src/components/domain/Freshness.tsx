import { cn } from '@/lib/cn'
import { useNow } from '@/lib/hooks'

const STALE_MS = 20_000

/**
 * Age of a reading. Fresh values print their age quietly; past 20 s the reading
 * is marked stale, the way an instrument flags a held trace.
 */
export function Freshness({ at, className, prefix = '' }: { at: number | undefined; className?: string; prefix?: string }) {
  const now = useNow(1000)
  if (!at) return null
  const age = Math.max(0, now - at)
  const stale = age > STALE_MS
  return (
    <span className={cn('whitespace-nowrap text-[11px]', stale ? 'text-warn' : 'num text-fg-4', className)} title={`Updated ${Math.round(age / 1000)} s ago`}>
      {stale ? 'stale' : `${prefix}${Math.max(1, Math.round(age / 1000))}s`}
    </span>
  )
}
