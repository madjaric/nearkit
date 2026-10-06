import { describe, expect, it } from 'vitest'
import { heldExportLine, untilText } from './heldExport'

const H = 60 * 60_000
const at = (t: number) => `T+${t / H}h`
const base = { releaseAt: 24 * H, expiresAt: 48 * H, confirmedAt: null, cancelledBy: null }

describe('how long until a held export is released', () => {
  it('in hours and minutes, then minutes, never a negative time', () => {
    expect(untilText(24 * H - 60_000)).toBe('in 23 h 59 min')
    expect(untilText(2 * H)).toBe('in 2 h 0 min')
    expect(untilText(5 * 60_000 + 30_000)).toBe('in 5 min')
    expect(untilText(20_000)).toBe('in less than a minute')
    expect(untilText(0)).toBe('now')
    expect(untilText(-5_000)).toBe('now')
  })
})

describe('what the Recover page says about a held export', () => {
  it('held: when NEARKITS releases it on its own, and that Telegram can release it sooner or cancel it', () => {
    const line = heldExportLine({ ...base, status: 'held' }, 60_000, at)
    expect(line.label).toBe('Held')
    expect(line.text).toContain('until T+24h (in 23 h 59 min)')
    expect(line.text).toContain('Release it now')
    expect(line.text).toContain('Cancel export')
  })

  it('ready: released in Telegram, or its hold is over; collect it by its time', () => {
    expect(heldExportLine({ ...base, status: 'ready', confirmedAt: 5 * H }, 5 * H, at)).toMatchObject({ label: 'Ready', text: expect.stringContaining('Released in Telegram') })
    const over = heldExportLine({ ...base, status: 'ready' }, 25 * H, at)
    expect(over.text).toContain('Its hold is over')
    expect(over.text).toContain('until T+48h')
  })

  it('over: cancelled (where), expired or collected, and nothing more will be released', () => {
    expect(heldExportLine({ ...base, status: 'cancelled', cancelledBy: 'telegram' }, 0, at)).toMatchObject({
      label: 'Cancelled',
      text: 'Cancelled in Telegram. Nothing was released.',
    })
    expect(heldExportLine({ ...base, status: 'cancelled', cancelledBy: 'web' }, 0, at).text).toBe('Cancelled on NEARKITS web. Nothing was released.')
    expect(heldExportLine({ ...base, status: 'cancelled', cancelledBy: 'app' }, 0, at).text).toBe(
      'Cancelled: NEARKITS couldn’t tell this wallet’s Telegram account. Nothing was released.',
    )
    expect(heldExportLine({ ...base, status: 'expired' }, 0, at)).toMatchObject({ label: 'Expired', text: 'It expired before the key was collected. Nothing was released.' })
    expect(heldExportLine({ ...base, status: 'collected' }, 0, at).label).toBe('Collected')
  })
})
