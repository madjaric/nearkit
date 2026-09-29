import { describe, expect, it } from 'vitest'
import { createLogger, redact } from './log'

const TOKEN = '1234567890:AAH-abcdefghijklmnopqrstuvwxyz_0123456'

describe('redaction', () => {
  it('removes a configured secret wherever it appears', () => {
    expect(redact(`https://api.telegram.org/bot${TOKEN}/getMe failed`, [TOKEN])).toBe('https://api.telegram.org/bot[REDACTED]/getMe failed')
  })

  it('removes anything shaped like a bot token even when it was never configured', () => {
    expect(redact(`token ${TOKEN} leaked`, [])).toBe('token [REDACTED] leaked')
  })

  it('ignores empty secrets and leaves ordinary text alone', () => {
    expect(redact('swap 1.5 NEAR at 12:30', ['', '   '])).toBe('swap 1.5 NEAR at 12:30')
  })

  it('removes anything shaped like a NEAR secret key, and keeps public keys readable', () => {
    const secret = 'ed25519:' + '3'.repeat(40) + 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMN'.repeat(1) + '9'.repeat(9)
    const pub = 'ed25519:Anu7LYDfpLtkP7E16LT9imXF694BdQaa9ufVkQiwTQxC'
    expect(redact(`export ${secret} for ${pub}`, [])).toBe(`export [REDACTED] for ${pub}`)
  })
})

describe('logger', () => {
  it('writes one JSON line per entry, redacted, and drops levels below the threshold', () => {
    const lines: string[] = []
    const log = createLogger({ level: 'info', secrets: [TOKEN], sink: (line) => lines.push(line) })
    log.debug('hidden')
    log.info('polling', { url: `https://api.telegram.org/bot${TOKEN}/getUpdates` })
    log.error('failed', { error: new Error(`boom ${TOKEN}`) })
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(line).not.toContain(TOKEN)
    const first = JSON.parse(lines[0] as string) as Record<string, unknown>
    expect(first).toMatchObject({ level: 'info', msg: 'polling', url: 'https://api.telegram.org/bot[REDACTED]/getUpdates' })
    const second = JSON.parse(lines[1] as string) as Record<string, unknown>
    expect(second.error).toBe('Error: boom [REDACTED]')
  })
})
