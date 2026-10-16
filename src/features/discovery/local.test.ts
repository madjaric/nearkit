import { describe, expect, it } from 'vitest'
import { createListStore } from './local'

/** The watchlist and followed wallets kept in the browser. */

function memory(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size
    },
  }
}

describe('list store', () => {
  it('toggles items in and out, keeps them unique and capped, and tells listeners', () => {
    const storage = memory()
    const s = createListStore('k', 2, () => storage)
    let calls = 0
    s.subscribe(() => void (calls += 1))
    s.toggle('a.near')
    s.toggle('b.near')
    s.toggle('c.near')
    expect(s.get()).toEqual(['a.near', 'b.near'])
    s.toggle('a.near')
    expect(s.get()).toEqual(['b.near'])
    expect(s.has('b.near')).toBe(true)
    expect(calls).toBe(4)
    // The same snapshot until it changes (React's external store needs it).
    expect(s.get()).toBe(s.get())
  })

  it('a broken or blocked storage is an empty list, never an error', () => {
    const storage = memory()
    storage.setItem('k', '{not json')
    expect(createListStore('k', 5, () => storage).get()).toEqual([])
    const blocked = createListStore('k', 5, () => {
      throw new Error('denied')
    })
    expect(blocked.get()).toEqual([])
    expect(() => blocked.toggle('x')).not.toThrow()
  })
})
