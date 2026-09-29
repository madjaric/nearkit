import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Db } from './sqlite'

describe('Db (SQLite via sql.js)', () => {
  it('runs statements with named and positional parameters', async () => {
    const db = await Db.open(null)
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
    expect(db.run('INSERT INTO t (id, name) VALUES (?, ?)', [1, 'a'])).toBe(1)
    db.run('INSERT INTO t (id, name) VALUES (:id, :name)', { ':id': 2, ':name': 'b' })
    expect(db.all<{ id: number; name: string }>('SELECT * FROM t ORDER BY id')).toEqual([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ])
    expect(db.get<{ name: string }>('SELECT name FROM t WHERE id = ?', [2])?.name).toBe('b')
    expect(db.get('SELECT name FROM t WHERE id = ?', [9])).toBeUndefined()
    db.close()
  })

  it('rolls a transaction back when it throws, and keeps it all-or-nothing', async () => {
    const db = await Db.open(null)
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    expect(() =>
      db.tx(() => {
        db.run('INSERT INTO t (id) VALUES (1)')
        db.run('INSERT INTO t (id) VALUES (1)') // duplicate key
      }),
    ).toThrow()
    expect(db.all('SELECT * FROM t')).toEqual([])
    db.tx(() => {
      db.run('INSERT INTO t (id) VALUES (1)')
      db.tx(() => db.run('INSERT INTO t (id) VALUES (2)')) // nested joins the outer one
    })
    expect(db.all('SELECT id FROM t')).toHaveLength(2)
    db.close()
  })

  it('enforces foreign keys', async () => {
    const db = await Db.open(null)
    db.exec('CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (pid INTEGER NOT NULL REFERENCES p(id) ON DELETE CASCADE)')
    expect(() => db.run('INSERT INTO c (pid) VALUES (5)')).toThrow(/FOREIGN KEY/)
    db.close()
  })

  it('persists committed writes to disk atomically and reopens them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nk-db-'))
    const path = join(dir, 'sub', 'test.sqlite')
    const db = await Db.open(path)
    db.exec('CREATE TABLE t (v TEXT)')
    db.tx(() => db.run("INSERT INTO t (v) VALUES ('kept')"))
    expect(existsSync(path)).toBe(true)
    expect(readdirSync(join(dir, 'sub'))).toEqual(['test.sqlite']) // no temp file left behind
    // Foreign keys stay on after a save (sql.js reopens the database when exporting).
    db.exec('CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (pid INTEGER REFERENCES p(id))')
    expect(() => db.run('INSERT INTO c (pid) VALUES (1)')).toThrow(/FOREIGN KEY/)
    db.close()
    const again = await Db.open(path)
    expect(again.all('SELECT v FROM t')).toEqual([{ v: 'kept' }])
    again.close()
  })
})
