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
