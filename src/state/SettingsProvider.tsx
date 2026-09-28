import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { DEFAULT_SETTINGS, SettingsContext, type Settings } from './contexts'

/** Session-only preferences (Phase 1 keeps no persistence). */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const update = useCallback((patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })), [])
  const reset = useCallback(() => setSettings(DEFAULT_SETTINGS), [])
  const api = useMemo(() => ({ settings, update, reset }), [settings, update, reset])
  return <SettingsContext.Provider value={api}>{children}</SettingsContext.Provider>
}
