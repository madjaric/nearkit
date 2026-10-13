/**
 * What /health says about the host's watchdog (deploy/vps/monitor.sh, which writes
 * control/monitor.json on every run): "ok", "degraded", or "unknown" when the status is missing,
 * unreadable or older than ten minutes (the watchdog itself has stopped). Only the verdict is
 * public: which check failed stays on the host and in the owner's alerts.
 */
export type MonitorVerdict = 'ok' | 'degraded' | 'unknown'

const MAX_AGE_SECONDS = 600

export function monitorVerdict(text: string | null, nowSeconds: number): MonitorVerdict {
  if (text === null) return 'unknown'
  let status: unknown
  try {
    status = JSON.parse(text)
  } catch {
    return 'unknown'
  }
  if (typeof status !== 'object' || status === null) return 'unknown'
  const { ok, at } = status as { ok?: unknown; at?: unknown }
  if (typeof ok !== 'boolean' || typeof at !== 'number' || !Number.isFinite(at)) return 'unknown'
  const age = nowSeconds - at
  if (age < -60 || age > MAX_AGE_SECONDS) return 'unknown'
  return ok ? 'ok' : 'degraded'
}

/** The commit the image was built from (deploy/vps/deploy.sh passes it), so a deploy and a rollback can be checked from outside. */
export function buildVersion(raw: string | undefined): string | null {
  const v = raw?.trim() ?? ''
  return /^[0-9a-f]{7,40}$/.test(v) ? v : null
}
