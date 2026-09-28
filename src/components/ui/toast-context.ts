import { createContext, useContext, type ReactNode } from 'react'

export type ToastTone = 'neutral' | 'accent' | 'neg' | 'warn'

export interface ToastInput {
  title: ReactNode
  detail?: ReactNode
  tone?: ToastTone
  /** Milliseconds before auto-dismiss; 0 keeps it until closed. */
  duration?: number
}

export interface ToastApi {
  push: (toast: ToastInput) => void
}

export const ToastContext = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const api = useContext(ToastContext)
  if (!api) throw new Error('useToast must be used inside <Toaster>')
  return api
}
