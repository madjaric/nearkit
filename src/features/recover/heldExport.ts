import type { HeldExport } from '@/services/recovery'

/**
 * A held key export in words, for the Recover page: NEARKITS holds every export (24 hours by
 * default) and tells the wallet's Telegram account, which can release it sooner or cancel it.
 */

/** "in 23 h 59 min", "in 5 min", "in less than a minute", or "now". */
export function untilText(ms: number): string {
  if (ms <= 0) return 'now'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'in less than a minute'
  if (minutes < 60) return `in ${minutes} min`
  return `in ${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

/** A time as the reader's clock shows it, with the date: an export is held for a day. */
export const localTime = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export type HeldExportFacts = Pick<HeldExport, 'status' | 'releaseAt' | 'expiresAt' | 'confirmedAt' | 'cancelledBy'>

const CANCELLED_BY: Record<string, string> = {
  telegram: 'Cancelled in Telegram.',
  web: 'Cancelled on NEARKITS web.',
  app: 'Cancelled: NEARKITS couldn’t tell this wallet’s Telegram account.',
}

export function heldExportLine(
  e: HeldExportFacts,
  now: number,
  when: (t: number) => string = localTime,
): { label: string; tone: 'warn' | 'accent' | 'neg' | 'neutral'; text: string } {
  switch (e.status) {
    case 'held':
      return {
        label: 'Held',
        tone: 'warn',
        text: `NEARKITS holds it until ${when(e.releaseAt)} (${untilText(e.releaseAt - now)}). This wallet’s Telegram account was told: tap ✅ Release it now there to get it sooner, or ❌ Cancel export if it wasn’t you.`,
      }
    case 'ready':
      return {
        label: 'Ready',
        tone: 'accent',
        text: `${e.confirmedAt !== null ? 'Released in Telegram.' : 'Its hold is over.'} Collect it on this page until ${when(e.expiresAt)}.`,
      }
    case 'cancelled':
      return { label: 'Cancelled', tone: 'neutral', text: `${CANCELLED_BY[e.cancelledBy ?? ''] ?? 'Cancelled.'} Nothing was released.` }
    case 'expired':
      return { label: 'Expired', tone: 'neutral', text: 'It expired before the key was collected. Nothing was released.' }
    case 'collected':
      return { label: 'Collected', tone: 'neg', text: 'The key was already collected. If it wasn’t on this page, check Telegram and move your funds.' }
  }
}
