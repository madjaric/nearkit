import { describe, expect, it } from 'vitest'
import { buildVersion, monitorVerdict } from './monitorStatus'

/**
 * What /health says about the host's watchdog (deploy/vps/monitor.sh writes control/monitor.json each
 * run): only a verdict, never which check failed. A status that's missing, unreadable or older than
 * ten minutes is "unknown" (the watchdog itself has stopped), never "ok".
 */

const NOW = 1_791_850_000

describe('the watchdog verdict on /health', () => {
  it('ok, degraded', () => {
    expect(monitorVerdict(JSON.stringify({ ok: true, at: NOW - 60, failing: 0 }), NOW)).toBe('ok')
    expect(monitorVerdict(JSON.stringify({ ok: false, at: NOW - 60, failing: 2 }), NOW)).toBe('degraded')
  })

  it('unknown when the watchdog stopped writing, or wrote something unreadable', () => {
    expect(monitorVerdict(JSON.stringify({ ok: true, at: NOW - 601 }), NOW)).toBe('unknown')
    expect(monitorVerdict(JSON.stringify({ ok: true, at: NOW + 3600 }), NOW)).toBe('unknown')
    expect(monitorVerdict('not json', NOW)).toBe('unknown')
    expect(monitorVerdict(JSON.stringify({ ok: 'yes', at: NOW }), NOW)).toBe('unknown')
    expect(monitorVerdict(JSON.stringify({ ok: true }), NOW)).toBe('unknown')
    expect(monitorVerdict(null, NOW)).toBe('unknown')
  })
})

describe('the build named on /health', () => {
  it('a commit id from the image, or nothing', () => {
    expect(buildVersion('769632367325')).toBe('769632367325')
    expect(buildVersion(' 769632367325864ccb5d0504687f98844f4da97c\n')).toBe('769632367325864ccb5d0504687f98844f4da97c')
    expect(buildVersion(undefined)).toBeNull()
    expect(buildVersion('')).toBeNull()
    expect(buildVersion('latest; rm -rf /')).toBeNull()
  })
})
