import { X } from 'lucide-react'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { useWalletOverlay } from '@/lib/walletOverlay'
import { IconButton } from './Button'

interface DialogBaseProps {
  open: boolean
  onClose: () => void
  /** False while something is in flight: Escape and backdrop clicks are ignored. */
  dismissible?: boolean
  children: ReactNode
  className?: string
  labelledBy?: string
  label?: string
}

/**
 * Native <dialog> in the top layer: focus is trapped, Escape closes, and no
 * ancestor overflow can clip it. Content mounts only while open, so each opening
 * starts from a clean state.
 *
 * While a wallet popup from NEAR Connect is on screen, the dialog steps out of
 * the top layer (non-modal, fixed below the popup) so the wallet stays clickable;
 * a modal dialog would make the popup inert.
 */
function DialogBase({ open, onClose, dismissible = true, children, className, labelledBy, label }: DialogBaseProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const modal = !useWalletOverlay()
  /** A close caused by switching between modal and non-modal, not by the user. */
  const switching = useRef(false)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (!open) {
      if (dialog.open) dialog.close()
      return
    }
    if (dialog.open && dialog.matches(':modal') === modal) return
    if (dialog.open) {
      switching.current = true
      dialog.close()
    }
    if (modal) dialog.showModal()
    else dialog.show()
  }, [open, modal])

  return (
    <>
      {open && !modal && <div aria-hidden="true" className="fixed inset-0 z-40 bg-[oklch(0.08_0.004_115/0.72)]" />}
      <dialog
        ref={ref}
        aria-labelledby={labelledBy}
        aria-label={label}
        onCancel={(event) => {
          event.preventDefault()
          if (dismissible) onClose()
        }}
        onClose={() => {
          if (switching.current) {
            switching.current = false
            return
          }
          if (open) onClose()
        }}
        onClick={(event) => {
          if (event.target === ref.current && dismissible) onClose()
        }}
        className={cn('max-h-none max-w-none overflow-visible bg-transparent p-0 text-fg backdrop:animate-fade', !modal && 'fixed inset-0 z-50', className)}
      >
        {open && children}
      </dialog>
    </>
  )
}

interface ModalProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg'
  dismissible?: boolean
}

const MODAL_WIDTH = { sm: 'sm:w-[400px]', md: 'sm:w-[520px]', lg: 'sm:w-[680px]' }

/** Centered on desktop, a bottom sheet on phones. Reserved for confirmations and focused edits. */
export function Modal({ open, onClose, title, description, children, footer, size = 'md', dismissible = true }: ModalProps) {
  const titleId = useId()
  return (
    <DialogBase open={open} onClose={onClose} dismissible={dismissible} labelledBy={titleId} className="m-0 mt-auto w-full sm:m-auto sm:w-fit">
      <div className={cn('flex max-h-[88dvh] flex-col border border-line bg-panel shadow-pop', 'animate-sheet-up rounded-t-xl sm:animate-rise sm:rounded-xl', MODAL_WIDTH[size])}>
        <header className="flex items-start justify-between gap-4 border-b border-line-soft px-5 pb-4 pt-5">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold leading-6 text-fg">
              {title}
            </h2>
            {description && <p className="mt-0.5 text-sm text-fg-3">{description}</p>}
          </div>
          {dismissible && (
            <IconButton label="Close" size="sm" onClick={onClose} className="-mr-1.5 -mt-0.5">
              <X size={16} />
            </IconButton>
          )}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <footer className="flex flex-col-reverse gap-2 border-t border-line-soft px-5 py-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))] sm:flex-row sm:items-center sm:justify-end">
            {footer}
          </footer>
        )}
      </div>
    </DialogBase>
  )
}

interface SheetProps {
  open: boolean
  onClose: () => void
  side: 'left' | 'right' | 'bottom'
  label: string
  children: ReactNode
  className?: string
}

/** The <dialog> itself is what sits against an edge; the inner surface only draws. */
const SHEET_POSITION: Record<SheetProps['side'], string> = {
  left: 'm-0 h-dvh',
  right: 'my-0 mr-0 ml-auto h-dvh',
  bottom: 'mx-0 mb-0 mt-auto w-full',
}

const SHEET_SURFACE: Record<SheetProps['side'], string> = {
  left: 'h-full w-[min(300px,86vw)] animate-sheet-left border-r',
  right: 'h-full w-[min(440px,100vw)] animate-sheet-right border-l',
  bottom: 'max-h-[92dvh] w-full animate-sheet-up rounded-t-xl border-t',
}

/** Edge-anchored panel: navigation drawer on phones, trade ticket drawer anywhere. */
export function Sheet({ open, onClose, side, label, children, className }: SheetProps) {
  return (
    <DialogBase open={open} onClose={onClose} label={label} className={SHEET_POSITION[side]}>
      <div className={cn('flex flex-col overflow-hidden border-line bg-panel shadow-sheet', SHEET_SURFACE[side], className)}>{children}</div>
    </DialogBase>
  )
}
