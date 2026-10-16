import { useSyncExternalStore } from 'react'

/**
 * Launch Radar's watchlist and Top Wallets' followed wallets, kept in this browser (a NEARKITS session
 * adds Telegram alerts for followed wallets on top: queries.ts). A blocked or full storage never breaks
 * the page: the list simply isn't kept.
 */

const EMPTY: readonly string[] = Object.freeze([])

export interface ListStore {
  get(): readonly string[]
  has(item: string): boolean
  toggle(item: string): void
  set(items: readonly string[]): void
  subscribe(listener: () => void): () => void
}

export function createListStore(key: string, max: number, storage: () => Storage | null = () => (typeof localStorage === 'undefined' ? null : localStorage)): ListStore {
  const listeners = new Set<() => void>()
  let cache: { raw: string | null; list: readonly string[] } | null = null
  const read = (): readonly string[] => {
    let raw: string | null = null
    try {
      raw = storage()?.getItem(key) ?? null
    } catch {
      raw = null
    }
    if (cache && cache.raw === raw) return cache.list
    let list: readonly string[] = EMPTY
    try {
      const parsed: unknown = raw ? JSON.parse(raw) : []
      if (Array.isArray(parsed)) list = Object.freeze([...new Set(parsed.filter((x): x is string => typeof x === 'string' && x.length <= 128))].slice(0, max))
    } catch {
      list = EMPTY
    }
    cache = { raw, list }
    return list
  }
  const write = (items: readonly string[]) => {
    try {
      storage()?.setItem(key, JSON.stringify([...new Set(items)].slice(0, max)))
    } catch {
      // Not kept (private mode, full storage): the page works without it.
    }
    for (const l of listeners) l()
  }
  const onStorage = (e: StorageEvent) => {
    if (e.key === key) for (const l of listeners) l()
  }
  return {
    get: read,
    has: (item) => read().includes(item),
    toggle: (item) => {
      const list = read()
      write(list.includes(item) ? list.filter((x) => x !== item) : [...list, item])
    },
    set: write,
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1 && typeof window !== 'undefined') window.addEventListener('storage', onStorage)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
      }
    },
  }
}

export const watchlist = createListStore('nearkit:discovery:watchlist', 200)
export const followed = createListStore('nearkit:discovery:followed', 50)

export function useList(store: ListStore): readonly string[] {
  return useSyncExternalStore(store.subscribe, store.get, () => EMPTY)
}
