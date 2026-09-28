import { useEffect, useState, useSyncExternalStore } from 'react'

/** Value that settles `delay` ms after the last change (typing → quote requests). */
export function useDebouncedValue<T>(value: T, delay = 250): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setSettled(value), delay)
    return () => window.clearTimeout(t)
  }, [value, delay])
  return settled
}

/** Current time, re-rendering every `interval` ms. */
export function useNow(interval = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), interval)
    return () => window.clearInterval(t)
  }, [interval])
  return now
}

export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title} · NearKit` : 'NearKit — The trading toolkit for NEAR'
  }, [title])
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const mq = window.matchMedia(query)
      mq.addEventListener('change', notify)
      return () => mq.removeEventListener('change', notify)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}

/** Remembers the previous value of something across renders (for tick direction). */
export function usePrevious<T>(value: T): T | undefined {
  const [state, setState] = useState<{ current: T; previous: T | undefined }>({ current: value, previous: undefined })
  if (!Object.is(state.current, value)) setState({ current: value, previous: state.current })
  return state.previous
}
