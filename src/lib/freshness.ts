/**
 * When a live reading counts as stale: older than 20 s. The app still knows it (the header's NEAR
 * price dims and says so to assistive tech) without printing an age or a "stale" mark.
 */
export const STALE_MS = 20_000

export const isStale = (at: number | undefined, now: number): boolean => at !== undefined && now - at > STALE_MS
