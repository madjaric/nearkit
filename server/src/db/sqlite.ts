import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js'
import { BaseDatabase, Mutex, type Connection, type SqlParams } from './database'

/**
 * SQLite through sql.js (WebAssembly: no native build, same engine everywhere).
 * Development, tests and the testnet beta. The database lives in memory and is
 * written to disk after every committed write: to a temporary file first, then
 * renamed over the old one, so a crash leaves either the previous or the new
 * state, never half of one. One connection serves the whole process, so every
 * statement and transaction takes its turn (a transaction holds the connection
 * until it ends). Production uses PostgreSQL (postgres.ts).
 */

let engine: Promise<SqlJsStatic> | null = null

function sqlEngine(): Promise<SqlJsStatic> {
  if (!engine) {
    const wasmDir = dirname(createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.js'))
    engine = initSqlJs({ locateFile: (file: string) => join(wasmDir, file) })
  }
  return engine
}

export class SqliteDatabase extends BaseDatabase {
  readonly dialect = 'sqlite' as const
  private readonly lock = new Mutex()
  private dirty = false
  private readonly conn: Connection

  private constructor(
    private db: SqlJsDatabase,
    private readonly path: string | null,
  ) {
    super()
    this.pragmas()
    this.conn = {
      run: async (sql, params) => {
        this.db.run(sql, params as (string | number | null)[])
        const changes = this.db.getRowsModified()
        this.dirty = true
        return changes
      },
      all: async <T>(sql: string, params: SqlParams): Promise<T[]> => {
        const stmt = this.db.prepare(sql)
        try {
          if (params.length) stmt.bind(params as (string | number | null)[])
          const rows: T[] = []
          while (stmt.step()) rows.push(stmt.getAsObject() as T)
          return rows
        } finally {
          stmt.free()
        }
      },
      exec: async (sql) => {
        this.db.exec(sql)
        this.dirty = true
      },
    }
  }

  /** `path` null keeps the database in memory only (tests). */
  static async open(path: string | null): Promise<SqliteDatabase> {
    const SQL = await sqlEngine()
    const bytes = path && existsSync(path) ? readFileSync(path) : null
    return new SqliteDatabase(bytes ? new SQL.Database(bytes) : new SQL.Database(), path)
  }

  private pragmas() {
    this.db.run('PRAGMA foreign_keys = ON')
  }

  protected outside<T>(fn: (conn: Connection) => Promise<T>): Promise<T> {
    return this.lock.run(async () => {
      try {
        return await fn(this.conn)
      } finally {
        this.flush()
      }
    })
  }

  protected transaction<T>(fn: (conn: Connection) => Promise<T>): Promise<T> {
    return this.lock.run(async () => {
      this.db.run('BEGIN IMMEDIATE')
      let result: T
      try {
        result = await fn(this.conn)
        this.db.run('COMMIT')
      } catch (e) {
        this.dirty = false
        try {
          this.db.run('ROLLBACK')
        } catch {
          // SQLite already rolled back (e.g. a constraint aborted the transaction)
        }
        throw e
      }
      this.flush()
      return result
    })
  }

  /** Writes the database to disk if anything changed since the last save. */
  private flush(): void {
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

  async close(): Promise<void> {
    await this.lock.run(async () => {
      this.flush()
      this.db.close()
    })
  }
}
