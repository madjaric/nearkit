import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * The database NearKit's server keeps its state in, behind one small async
 * interface with two engines:
 *
 * - SQLite through sql.js (`sqlite.ts`): development, tests and the testnet beta.
 *   One connection in one process.
 * - PostgreSQL (`postgres.ts`): production. Many server instances share it, so
 *   everything financial relies on the database itself (transactions, unique
 *   constraints and atomic compare-and-set updates), never on in-memory locks.
 *
 * SQL is written once with `?` placeholders; the Postgres engine numbers them.
 * Statements issued anywhere inside `tx(fn)` (including from other methods that
 * `fn` calls) join that transaction: the current transaction follows the async
 * call chain. Keep network I/O out of transactions.
 */

export type SqlValue = string | number | null
export type SqlParams = readonly SqlValue[]

export interface Queryable {
  /** Runs one statement; resolves to the number of rows it changed. */
  run(sql: string, params?: SqlParams): Promise<number>
  all<T = Record<string, unknown>>(sql: string, params?: SqlParams): Promise<T[]>
  get<T = Record<string, unknown>>(sql: string, params?: SqlParams): Promise<T | undefined>
}

export type Dialect = 'sqlite' | 'postgres'

export interface Database extends Queryable {
  readonly dialect: Dialect
  /**
   * All-or-nothing: commits when `fn` resolves, rolls back when it throws. A call
   * made while a transaction is open (anywhere in `fn`'s async call chain) joins it.
   */
  tx<T>(fn: () => Promise<T>): Promise<T>
  /** Several statements without parameters (schema changes). */
  exec(sql: string): Promise<void>
  close(): Promise<void>
}

/** A connection that runs statements right away. */
export interface Connection {
  run(sql: string, params: SqlParams): Promise<number>
  all<T>(sql: string, params: SqlParams): Promise<T[]>
  exec(sql: string): Promise<void>
}

interface Scope {
  conn: Connection
  /** False once the transaction ended: a straggling promise must not use it. */
  open: boolean
}

/** Shared by the engines: statements inside a transaction go to its connection. */
export abstract class BaseDatabase implements Database {
  abstract readonly dialect: Dialect
  protected readonly scope = new AsyncLocalStorage<Scope>()

  /** Runs `fn` on a connection outside any transaction. */
  protected abstract outside<T>(fn: (conn: Connection) => Promise<T>): Promise<T>
  /** Runs `fn` inside a new transaction on a dedicated connection. */
  protected abstract transaction<T>(fn: (conn: Connection) => Promise<T>): Promise<T>
  abstract close(): Promise<void>

  private current(): Scope | undefined {
    const s = this.scope.getStore()
    return s?.open ? s : undefined
  }

  run(sql: string, params: SqlParams = []): Promise<number> {
    const s = this.current()
    return s ? s.conn.run(sql, params) : this.outside((c) => c.run(sql, params))
  }

  all<T = Record<string, unknown>>(sql: string, params: SqlParams = []): Promise<T[]> {
    const s = this.current()
    return s ? s.conn.all<T>(sql, params) : this.outside((c) => c.all<T>(sql, params))
  }

  async get<T = Record<string, unknown>>(sql: string, params: SqlParams = []): Promise<T | undefined> {
    return (await this.all<T>(sql, params))[0]
  }

  exec(sql: string): Promise<void> {
    const s = this.current()
    return s ? s.conn.exec(sql) : this.outside((c) => c.exec(sql))
  }

  tx<T>(fn: () => Promise<T>): Promise<T> {
    // Nested: join the transaction already open in this call chain.
    if (this.current()) return fn()
    return this.transaction(async (conn) => {
      const scope: Scope = { conn, open: true }
      try {
        return await this.scope.run(scope, fn)
      } finally {
        scope.open = false
      }
    })
  }
}

/** A queue that runs one task at a time (the single connection of an embedded engine). */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task)
    this.tail = result.catch(() => undefined)
    return result
  }
}

/**
 * True when `e` is a unique-constraint violation (SQLite's message or Postgres's
 * SQLSTATE 23505): the row it tried to create already exists.
 */
export function isUniqueViolation(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const code = (e as { code?: unknown }).code
  if (code === '23505') return true
  const message = (e as { message?: unknown }).message
  return typeof message === 'string' && /UNIQUE constraint failed/i.test(message)
}

/** `?` placeholders become `$1, $2, …` (Postgres), leaving quoted text, identifiers and comments alone. */
export function numberPlaceholders(sql: string): string {
  let out = ''
  let n = 0
  let i = 0
  while (i < sql.length) {
    const c = sql[i] as string
    if (c === "'" || c === '"') {
      const end = closing(sql, i, c)
      out += sql.slice(i, end)
      i = end
    } else if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? sql.length : end
      out += sql.slice(i, stop)
      i = stop
    } else if (c === '?') {
      n += 1
      out += `$${n}`
      i += 1
    } else {
      out += c
      i += 1
    }
  }
  return out
}

/** Index just past the quote that closes the one at `start` (a doubled quote is an escaped one). */
function closing(sql: string, start: number, quote: string): number {
  let i = start + 1
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2
        continue
      }
      return i + 1
    }
    i += 1
  }
  return sql.length
}
