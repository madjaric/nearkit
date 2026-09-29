import { existsSync, readFileSync } from 'node:fs'

/**
 * A tiny `.env` reader (no dependency, no variable expansion). Values from the
 * host environment win: a deployment's real settings are never overridden by a
 * local file. Callers get key names back, never values, so nothing secret can
 * reach a log by accident.
 */

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = line.slice(eq + 1).trim()
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) value = value.slice(1, -1)
    out[key] = value
  }
  return out
}

/** Loads `path` into `target` for keys `target` doesn't set. Returns the keys it filled. */
export function loadEnvFile(path: string, target: Record<string, string | undefined> = process.env): string[] {
  if (!existsSync(path)) return []
  const parsed = parseEnvFile(readFileSync(path, 'utf8'))
  const filled: string[] = []
  for (const [key, value] of Object.entries(parsed)) {
    if (target[key] !== undefined && target[key] !== '') continue
    target[key] = value
    filled.push(key)
  }
  return filled
}
