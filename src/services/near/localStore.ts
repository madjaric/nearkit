/**
 * Tiny JSON persistence over localStorage. Every access is guarded: storage can
 * be blocked (private mode, disabled site data) and the app must still work.
 * Only public data lives here: account IDs, labels, token contracts, cached
 * metadata and NearKit's own transaction records. Never keys or secrets.
 */

export function readJson<T>(key: string, validate: (value: unknown) => value is T): T | null {
  try {
    const text = localStorage.getItem(key)
    if (text === null) return null
    const value: unknown = JSON.parse(text)
    return validate(value) ? value : null
  } catch {
    return null
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage full or blocked: the value lives for this page only.
  }
}

export function removeKey(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // nothing to remove
  }
}
