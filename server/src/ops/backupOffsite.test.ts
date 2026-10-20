import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * The off-site copy's retention (deploy/vps/backup-offsite.sh), run as the VPS runs it, against a local Git
 * repository that answers as GitHub does: it refuses to delete the repository's default branch (the first
 * backup pushed, when the repository was created). Every backup is kept for 48 hours, then the midnight one
 * of each day for 30 days. The default branch is never asked for; a deletion git refuses is named, with
 * git's reason; and the copy itself never fails over retention.
 */

const SCRIPT = fileURLToPath(new URL('../../../deploy/vps/backup-offsite.sh', import.meta.url))
const HOUR = 3_600_000
const DAY = 24 * HOUR

/** A backup's branch for a moment: b-YYYYMMDDTHHMMSSZ. */
const branchAt = (ms: number) =>
  `b-${new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')}`
/** A day's date (some days back) at a time of day, UTC. */
const dayAt = (daysBack: number, h: number, m: number, s: number) => {
  const d = new Date(Date.now() - daysBack * DAY)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m, s)
}

// Plays age: writes its header, then the input (the script checks every file that leaves is age ciphertext).
const FAKE_AGE = `#!/usr/bin/env bash
while [ $# -gt 1 ]; do case $1 in -o) out=$2; shift 2 ;; -R) shift 2 ;; *) shift ;; esac; done
{ printf 'age-encryption.org/v1\\n'; cat "$1"; } > "$out"
`
// Answers as GitHub does: the default branch can't be deleted; a branch named in ./refuse can't either.
const UPDATE_HOOK = `#!/bin/sh
ref=$1 new=$3
case $new in *[!0]*) exit 0 ;; esac
if [ "$ref" = "$(git symbolic-ref HEAD)" ]; then echo "refusing to delete the current branch: $ref" >&2; exit 1; fi
if [ -s refuse ] && [ "$ref" = "refs/heads/$(cat refuse)" ]; then echo "protected for the test" >&2; exit 1; fi
exit 0
`

let root: string
const stampMs = Date.now() - 60_000
const STAMP = branchAt(stampMs).slice(2)
const b = {
  fresh: branchAt(stampMs),
  recent: branchAt(Date.now() - 3 * HOUR),
  // An hourly copy past 48 hours (never one at midnight).
  oldHourly: branchAt(Date.now() - 50 * HOUR - (new Date(Date.now() - 50 * HOUR).getUTCHours() === 0 ? HOUR : 0)),
  midnight5: branchAt(dayAt(5, 0, 1, 35)),
  midnight31: branchAt(dayAt(31, 0, 1, 35)),
  // The first backup, at 23:02, eight days back: past retention, and the repository's default branch.
  first: branchAt(dayAt(8, 23, 2, 7)),
}

const bash = (script: string, env: Record<string, string> = {}) => spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nearkit-offsite-'))
  for (const d of ['backups', 'secrets', 'fakebin']) mkdirSync(join(root, d))
  for (const f of [`nearkit-${STAMP}.dump`, `nearkit_signer-${STAMP}.dump`, `openbao-${STAMP}.snap`]) writeFileSync(join(root, 'backups', f), `backup ${f}\n`)
  writeFileSync(join(root, 'secrets', 'backup_deploy_key'), 'not a real key\n')
  writeFileSync(join(root, 'github_known_hosts'), 'example.invalid ssh-ed25519 AAAA\n')
  writeFileSync(join(root, 'backup-recipients.txt'), 'age1testrecipientnotarealkey\n')
  writeFileSync(join(root, '.env'), 'NEARKIT_APP_TAG=test\n')
  writeFileSync(
    join(root, 'backup-offsite.env'),
    [
      `BACKUP_REMOTE=${join(root, 'remote.git')}`,
      `BACKUP_SSH_KEY=${join(root, 'secrets', 'backup_deploy_key')}`,
      `BACKUP_KNOWN_HOSTS=${join(root, 'github_known_hosts')}`,
      `BACKUP_RECIPIENTS=${join(root, 'backup-recipients.txt')}`,
      '',
    ].join('\n'),
  )
  writeFileSync(join(root, 'fakebin', 'age'), FAKE_AGE)
  chmodSync(join(root, 'fakebin', 'age'), 0o755)
  // The off-site repository as it is: earlier backups, the first one its default branch.
  const seeded = bash(
    `set -e; cd "$ROOT"; git init -q --bare remote.git; git init -q seed; cd seed
     git -c user.name=t -c user.email=t@t.invalid commit -q --allow-empty -m seed
     for br in $BRANCHES; do git push -q ../remote.git HEAD:refs/heads/$br; done
     git -C ../remote.git symbolic-ref HEAD refs/heads/$FIRST`,
    { ROOT: root, BRANCHES: [b.recent, b.oldHourly, b.midnight5, b.midnight31, b.first].join(' '), FIRST: b.first },
  )
  expect(seeded.status, seeded.stderr).toBe(0)
  writeFileSync(join(root, 'remote.git', 'hooks', 'update'), UPDATE_HOOK)
  chmodSync(join(root, 'remote.git', 'hooks', 'update'), 0o755)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function offsite() {
  const run = spawnSync('bash', [SCRIPT, STAMP], {
    encoding: 'utf8',
    env: { ...process.env, NEARKIT_BACKUP_ROOT: root, PATH: `${join(root, 'fakebin')}${delimiter}${process.env.PATH ?? ''}` },
  })
  return { status: run.status, out: run.stdout, err: run.stderr }
}
const branches = () => bash(`git -C "$ROOT/remote.git" for-each-ref --format='%(refname:short)' refs/heads`, { ROOT: root }).stdout.split('\n').filter(Boolean).sort()

describe.skipIf(process.platform === 'win32')('the off-site copy’s retention', { timeout: 30_000 }, () => {
  it('deletes what the rule lets go, keeps the rest, and never asks for the default branch: no failure reported', () => {
    const run = offsite()
    expect(run.status, run.err).toBe(0)
    expect(run.out).toContain(`off-site copy ${b.fresh}`)
    expect(existsSync(join(root, 'backups', '.offsite.ok'))).toBe(true)
    // The new copy, the last 48 hours, a midnight copy within 30 days, and the default branch stay.
    expect(branches()).toEqual([b.fresh, b.recent, b.midnight5, b.first].sort())
    expect(run.err).not.toMatch(/retention/)
    expect(bash(`git -C "$ROOT/remote.git" ls-tree --name-only ${b.fresh}`, { ROOT: root }).stdout).toContain('MANIFEST')
  })

  it('a deletion git refuses is reported by name with git’s reason; the others go, and the copy still succeeds', () => {
    writeFileSync(join(root, 'remote.git', 'refuse'), b.oldHourly)
    const run = offsite()
    expect(run.status, run.err).toBe(0)
    expect(existsSync(join(root, 'backups', '.offsite.ok'))).toBe(true)
    expect(branches()).toEqual([b.fresh, b.recent, b.oldHourly, b.midnight5, b.first].sort())
    expect(run.err).toContain(`off-site retention: kept 1 of 2 old branch(es) that couldn't be deleted (${b.oldHourly})`)
    expect(run.err).toContain('protected for the test')
  })
})
