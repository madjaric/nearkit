export type ClassValue = string | number | bigint | boolean | null | undefined

/** Join class names, dropping falsy parts. Callers keep variants non-conflicting. */
export function cn(...parts: ClassValue[]): string {
  let out = ''
  for (const part of parts) {
    if (!part) continue
    out = out ? `${out} ${part}` : String(part)
  }
  return out
}
