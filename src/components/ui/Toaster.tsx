import { X } from 'lucide-react'
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Figures } from './Figures'
import { Led, type LedTone } from './Indicators'
import { ToastContext, type ToastInput, type ToastTone } from './toast-context'

interface ToastItem extends ToastInput {
  id: number
}

const LED_FOR: Record<ToastTone, LedTone> = { neutral: 'idle', accent: 'on', neg: 'neg', warn: 'warn' }

/** Status messages printed like an instrument's event log, bottom-right (above the tab bar on phones). */
export function Toaster({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const seq = useRef(0)

  const dismiss = useCallback((id: number) => setItems((list) => list.filter((t) => t.id !== id)), [])

  const push = useCallback(
    (toast: ToastInput) => {
      seq.current += 1
      const id = seq.current
      setItems((list) => [...list.slice(-3), { ...toast, id }])
      const duration = toast.duration ?? 5200
      if (duration > 0) window.setTimeout(() => dismiss(id), duration)
    },
    [dismiss],
  )

  const api = useMemo(() => ({ push }), [push])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        aria-relevant="additions"
        className="pointer-events-none fixed inset-x-3 bottom-[calc(4.25rem+env(safe-area-inset-bottom))] z-[90] flex flex-col items-end gap-2 lg:inset-x-auto lg:bottom-5 lg:right-5"
      >
        {items.map((toast) => (
          <div
            key={toast.id}
            role={toast.tone === 'neg' ? 'alert' : 'status'}
            className="pointer-events-auto flex w-full max-w-[380px] animate-rise items-start gap-3 rounded-md border border-line bg-raised px-3.5 py-3 shadow-pop"
          >
            <Led tone={LED_FOR[toast.tone ?? 'neutral']} size={8} className="mt-1.5" />
            <div className="min-w-0 flex-1">
              <p className={cn('text-sm font-medium', toast.tone === 'neg' ? 'text-neg' : 'text-fg')}>
                <Figures>{toast.title}</Figures>
              </p>
              {toast.detail && (
                <p className="mt-0.5 text-xs leading-[1.45] text-fg-3">
                  <Figures>{toast.detail}</Figures>
                </p>
              )}
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismiss(toast.id)}
              className="-mr-1 -mt-0.5 grid size-6 shrink-0 place-items-center rounded-xs text-fg-4 hover:bg-hover hover:text-fg-2"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
