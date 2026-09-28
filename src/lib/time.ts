const pad = (n: number) => String(n).padStart(2, '0')

/** Timestamp → value for <input type="datetime-local"> in local time. */
export function toLocalInput(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fromLocalInput(value: string): number | null {
  if (!value) return null
  const t = new Date(value).getTime()
  return Number.isFinite(t) ? t : null
}

/** Next full hour from `t`. */
export function nextHour(t: number): number {
  const d = new Date(t)
  d.setMinutes(0, 0, 0)
  return d.getTime() + 3_600_000
}

export const MS = { hour: 3_600_000, day: 86_400_000, week: 604_800_000 } as const
