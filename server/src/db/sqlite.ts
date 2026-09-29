import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import initSqlJs, { type BindParams, type Database, type SqlJsStatic } from 'sql.js'

/**
 * SQLite through sql.js (WebAssembly: no native build, same engine everywhere).
 * The database lives in memory and is written to disk after every committed
 * write: to a temporary file first, then renamed over the old one, so a crash
 * leaves either the previous or the new state, never half of one. The process
 * is single-threaded and every statement is synchronous, so a transaction can
 * never interleave with another.
 */

let engine: Promise<SqlJsStatic> | null = null

function sqlEngine(): Promise<SqlJsStatic> {
  if (!engine) {
    const wasmDir = dirname(createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.js'))
    engine = initSqlJs({ locateFile: (file: string) => join(wasmDir, file) })
  }
  return engine
}

export type Params = BindParams

export class Db {
  private depth = 0
  private dirty = false

  private constructor(
    private db: Database,
    private readonly path: string | null,
  ) {
    this.pragmas()
  }

  /** `path` null keeps the database in memory only (tests). */
  static async open(path: string | null): Promise<Db> {
    const SQL = await sqlEngine()
    const bytes = path && existsSync(path) ? readFileSync(path) : null
    return new Db(bytes ? new SQL.Database(bytes) : new SQL.Database(), path)
  }

  private pragmas() {
    this.db.run('PRAGMA foreign_keys = ON')
  }

  /** Runs one statement; returns the number of rows it changed. */
  run(sql: string, params?: Params): number {
    this.db.run(sql, params)
    const changes = this.db.getRowsModified()
    this.written()
    return changes
  }

  /** Runs several statements (no parameters): schema changes. */
  exec(sql: string): void {
    this.db.exec(sql)
    this.written()
  }

  all<T = Record<string, unknown>>(sql: string, params?: Params): T[] {
    const stmt = this.db.prepare(sql)
    try {
      if (params) stmt.bind(params)
      const rows: T[] = []
      while (stmt.step()) rows.push(stmt.getAsObject() as T)
      return rows
    } finally {
      stmt.free()
    }
  }

  get<T = Record<string, unknown>>(sql: string, params?: Params): T | undefined {
    return this.all<T>(sql, params)[0]
  }

  /**
   * All-or-nothing: commits when `fn` returns, rolls back when it throws. Nested
   * calls join the outer transaction. `fn` must be synchronous.
   */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth += 1
      try {
        return fn()
      } finally {
        this.depth -= 1
      }
    }
    this.db.run('BEGIN IMMEDIATE')
    this.depth = 1
    try {
      const result = fn()
      if (result instanceof Promise) throw new Error('Db.tx callbacks must be synchronous')
      this.db.run('COMMIT')
      this.depth = 0
      this.flush()
      return result
    } catch (e) {
      this.depth = 0
      this.dirty = false
      try {
        this.db.run('ROLLBACK')
      } catch {
        // SQLite already rolled back (e.g. a constraint aborted the transaction)
      }
      throw e
    }
  }

  private written() {
    this.dirty = true
    if (this.depth === 0) this.flush()
  }

  /** Writes the database to disk if anything changed since the last save. */
  flush(): void {
    if (!this.dirty || !this.path) {
      this.dirty = false
      return
    }
    const data = this.db.export()
    // sql.js closes and reopens the database to export it: settings reset.
    this.pragmas()
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp-${process.pid}`
    writeFileSync(tmp, data)
    renameSync(tmp, this.path)
    this.dirty = false
  }

  close(): void {
    this.flush()
    this.db.close()
  }
}
