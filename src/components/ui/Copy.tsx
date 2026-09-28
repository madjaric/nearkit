import { Check, Copy as CopyIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { cn } from '@/lib/cn'

/** Copies a value; the icon confirms for a moment. Clipboard failures stay silent but harmless. */
export function CopyButton({ value, label = 'Copy', className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1400)
    return () => window.clearTimeout(t)
  }, [copied])
  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      onClick={async (event) => {
        event.stopPropagation()
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
        } catch {
          setCopied(false)
        }
      }}
      className={cn('inline-grid size-6 shrink-0 place-items-center rounded-xs text-fg-4 transition-colors hover:bg-raised hover:text-fg-2', className)}
    >
      {copied ? <Check size={13} className="text-accent" /> : <CopyIcon size={13} />}
    </button>
  )
}
