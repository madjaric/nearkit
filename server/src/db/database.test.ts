import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isUniqueViolation, numberPlaceholders, type Database } from './database'
import { SqliteDatabase } from './sqlite'
import { ENGINE_TIMEOUT_MS, openTestDatabase, TEST_ENGINES } from './testing'

/** A bare database (no NearKit schema) with one scratch table. */
async function scratch(engine: (typeof TEST_ENGINES)[number]): Promise<Database> {
  const db = await openTestDatabase(engine)
  await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, big BIGINT)')
  return db
}

describe('placeholders', () => {
  it('numbers ? for Postgres, leaving quoted text, identifiers and comments alone', () => {
    expect(numberPlaceholders('SELECT * FROM t WHERE a = ? AND b IN (?, ?)')).toBe('SELECT * FROM t WHERE a = $1 AND b IN ($2, $3)')
    expect(numberPlaceholders('SELECT \'?\' AS q, "a?b" FROM t WHERE c = ? -- why?\nAND d = ?')).toBe('SELECT \'?\' AS q, "a?b" FROM t WHERE c = $1 -- why?\nAND d = $2')
    expect(numberPlaceholders("SELECT 'it''s ?' WHERE x = ?")).toBe("SELECT 'it''s ?' WHERE x = $1")
  })
})

describe.each(TEST_ENGINES)(
  'database on %s',
  (engine) => {
    it('runs statements and reads rows back with their types', async () => {
      const db = await scratch(engine)
      expect(await db.run('INSERT INTO t (id, name, big) VALUES (?, ?, ?)', [1, 'a', 1_790_000_000_000])).toBe(1)
      expect(await db.run('INSERT INTO t (id, name, big) VALUES (?, ?, ?)', [2, 'b', null])).toBe(1)
      expect(await db.all<{ id: number; name: string; big: number | null }>('SELECT id, name, big FROM t ORDER BY id')).toEqual([
        { id: 1, name: 'a', big: 1_790_000_000_000 },
        { id: 2, name: 'b', big: null },
      ])
      expect((await db.get<{ name: string }>('SELECT name FROM t WHERE id = ?', [2]))?.name).toBe('b')
      expect(await db.get('SELECT name FROM t WHERE id = ?', [9])).toBeUndefined()
      expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM t'))?.n).toBe(2)
      expect(await db.run('UPDATE t SET name = ? WHERE id = ?', ['c', 9])).toBe(0)
      expect((await db.get<{ id: number }>("INSERT INTO t (id, name) VALUES (3, 'x') RETURNING id"))?.id).toBe(3)
    })

    it('reports a unique violation the same way on every engine', async () => {
      const db = await scratch(engine)
      await db.run("INSERT INTO t (id, name) VALUES (1, 'a')")
      const e = await db.run("INSERT INTO t (id, name) VALUES (2, 'a')").catch((x: unknown) => x)
      expect(isUniqueViolation(e)).toBe(true)
      expect(isUniqueViolation(new Error('something else'))).toBe(false)
      expect(await db.run("INSERT INTO t (id, name) VALUES (2, 'a') ON CONFLICT DO NOTHING")).toBe(0)
    })

    it('rolls a transaction back when it throws, and keeps it all-or-nothing', async () => {
      const db = await scratch(engine)
      await expect(
        db.tx(async () => {
          await db.run("INSERT INTO t (id, name) VALUES (1, 'a')")
          await db.run("INSERT INTO t (id, name) VALUES (2, 'a')") // duplicate name
        }),
      ).rejects.toThrow()
      expect(await db.all('SELECT * FROM t')).toEqual([])
      await db.tx(async () => {
        await db.run("INSERT INTO t (id, name) VALUES (1, 'a')")
        // Nested: joins the outer transaction, even through another function.
        const nested = () => db.tx(() => db.run("INSERT INTO t (id, name) VALUES (2, 'b')"))
        await nested()
      })
      expect(await db.all('SELECT id FROM t')).toHaveLength(2)
    })

    it('isolates a transaction: statements outside it wait, and see nothing half-done', async () => {
      const db = await scratch(engine)
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      const inside = db.tx(async () => {
        await db.run("INSERT INTO t (id, name) VALUES (1, 'a')")
        await gate
        await db.run("INSERT INTO t (id, name) VALUES (2, 'b')")
      })
      // Let the transaction start before reading.
      await new Promise((r) => setTimeout(r, 20))
      const outside = db.all<{ id: number }>('SELECT id FROM t ORDER BY id')
      release()
      await inside
      const seen = (await outside).map((r) => r.id)
      // Either before (nothing) or after (both), never between.
      expect([[], [1, 2]]).toContainEqual(seen)
    })

    it('two transactions racing for the same row: exactly one wins a compare-and-set', async () => {
      const db = await scratch(engine)
      await db.run("INSERT INTO t (id, name) VALUES (1, 'free')")
      const claim = (who: string) => db.tx(async () => (await db.run("UPDATE t SET name = ? WHERE id = 1 AND name = 'free'", [who])) === 1)
      const results = await Promise.all([claim('a'), claim('b'), claim('c')])
      expect(results.filter(Boolean)).toHaveLength(1)
    })
  },
  ENGINE_TIMEOUT_MS,
)

describe('SQLite specifics', () => {
  it('enforces foreign keys', async () => {
    const db = await SqliteDatabase.open(null)
    await db.exec('CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (pid INTEGER NOT NULL REFERENCES p(id) ON DELETE CASCADE)')
    await expect(db.run('INSERT INTO c (pid) VALUES (5)')).rejects.toThrow(/FOREIGN KEY/)
    await db.close()
  })

  it('persists committed writes to disk atomically and reopens them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nk-db-'))
    const path = join(dir, 'sub', 'test.sqlite')
    const db = await SqliteDatabase.open(path)
    await db.exec('CREATE TABLE t (v TEXT)')
    await db.tx(() => db.run("INSERT INTO t (v) VALUES ('kept')"))
    expect(existsSync(path)).toBe(true)
    expect(readdirSync(join(dir, 'sub'))).toEqual(['test.sqlite']) // no temp file left behind
    // Foreign keys stay on after a save (sql.js reopens the database when exporting).
    await db.exec('CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (pid INTEGER REFERENCES p(id))')
    await expect(db.run('INSERT INTO c (pid) VALUES (1)')).rejects.toThrow(/FOREIGN KEY/)
    await db.close()
    const again = await SqliteDatabase.open(path)
    expect(await again.all('SELECT v FROM t')).toEqual([{ v: 'kept' }])
    await again.close()
  })
})
