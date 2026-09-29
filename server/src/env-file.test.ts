import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadEnvFile, parseEnvFile } from './env-file'

describe('env file', () => {
  it('reads KEY=VALUE lines, skipping comments, blanks and malformed lines', () => {
    const parsed = parseEnvFile(['# comment', '', 'A=1', '  B = two words  ', 'C="quoted # not a comment"', "D='single'", 'not a pair', 'lower=x', 'E='].join('\r\n'))
    expect(parsed).toEqual({ A: '1', B: 'two words', C: 'quoted # not a comment', D: 'single', lower: 'x', E: '' })
  })

  it('fills only keys the environment does not already set, and reports keys, never values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nk-env-'))
    const file = join(dir, '.env.local')
    writeFileSync(file, 'TOKEN=from-file\nOTHER=file\n')
    const target: Record<string, string | undefined> = { OTHER: 'from-host' }
    const loaded = loadEnvFile(file, target)
    expect(loaded).toEqual(['TOKEN'])
    expect(target).toEqual({ TOKEN: 'from-file', OTHER: 'from-host' })
  })

  it('treats a missing file as empty', () => {
    expect(loadEnvFile(join(tmpdir(), 'nk-missing-dir', '.env.local'), {})).toEqual([])
  })
})

describe('secrets mounted as files', () => {
  it('fills only the allowed secrets from NAME_FILE, never overriding a set value', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const { loadSecretFiles } = await import('./env-file')
    const dir = mkdtempSync(join(tmpdir(), 'nearkit-secrets-'))
    try {
      writeFileSync(join(dir, 'token'), 'from-file\n')
      writeFileSync(join(dir, 'other'), 'nope')
      const env: Record<string, string | undefined> = {
        TELEGRAM_BOT_TOKEN_FILE: join(dir, 'token'),
        NEARKIT_DATABASE_URL: 'already-set',
        NEARKIT_DATABASE_URL_FILE: join(dir, 'token'),
        SOMETHING_ELSE_FILE: join(dir, 'other'),
      }
      expect(loadSecretFiles(env)).toEqual(['TELEGRAM_BOT_TOKEN'])
      expect(env.TELEGRAM_BOT_TOKEN).toBe('from-file')
      expect(env.NEARKIT_DATABASE_URL).toBe('already-set')
      expect(env.SOMETHING_ELSE).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a missing secret file stops the process and names the variable', async () => {
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const { loadSecretFiles } = await import('./env-file')
    const env: Record<string, string | undefined> = { NEARKIT_SIGNER_AUTH_KEY_FILE: join(tmpdir(), 'nearkit-no-such-dir', 'auth') }
    expect(() => loadSecretFiles(env)).toThrow(/^NEARKIT_SIGNER_AUTH_KEY_FILE: cannot read the file \(ENOENT\)$/)
    expect(env.NEARKIT_SIGNER_AUTH_KEY).toBeUndefined()
  })
})
