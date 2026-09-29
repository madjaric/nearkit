import pg from 'pg'
import { BaseDatabase, Mutex, numberPlaceholders, type Connection, type SqlParams } from './database'

/**
 * PostgreSQL, the production database: many server instances share it, and
 * everything financial relies on it (transactions, unique constraints, atomic
 * compare-and-set updates), never on one process's memory.
 *
 * - `PostgresDatabase`: a connection pool (node-postgres). Each transaction takes
 *   its own connection; statements outside transactions use any free one.
 * - `PgliteDatabase`: the same SQL on PGlite (Postgres compiled to WebAssembly,
 *   one connection) so tests run the production dialect without a server.
 *
 * 64-bit integers (timestamps in ms, Telegram IDs) come back as JS numbers: every
 * value NearKit stores in them is below 2^53. Big amounts are TEXT.
 */

const INT8 = 20
const NUMERIC = 1700

function int8(value: string): number {
  const n = Number(value)
  if (!Number.isSafeInteger(n)) throw new Error(`A 64-bit integer from the database is outside JavaScript's safe range: ${value}`)
  return n
}

/** Type parsers for this pool only (node-postgres's global ones stay untouched). */
const types = {
  getTypeParser(oid: number, format?: string) {
    if (oid === INT8) return int8
    if (oid === NUMERIC) return (v: string) => v
    return pg.types.getTypeParser(oid, format as 'text')
  },
}

interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>
}

function connection(q: PgQueryable): Connection {
  return {
    async run(sql, params) {
      return (await q.query(numberPlaceholders(sql), [...params])).rowCount ?? 0
    },
    async all<T>(sql: string, params: SqlParams): Promise<T[]> {
      return (await q.query(numberPlaceholders(sql), [...params])).rows as T[]
    },
    async exec(sql) {
      await q.query(sql)
    },
  }
}

export interface PostgresOptions {
  url: string
  max?: number
  applicationName?: string
  ssl?: pg.PoolConfig['ssl']
  /** Schema to use instead of public (tests give each database its own). */
  searchPath?: string
}

export class PostgresDatabase extends BaseDatabase {
  readonly dialect = 'postgres' as const
  private readonly pool: pg.Pool

  constructor(private readonly options: PostgresOptions) {
    super()
    if (options.searchPath !== undefined && !/^[a-z_][a-z0-9_]{0,62}$/.test(options.searchPath)) throw new Error('Invalid schema name')
    this.pool = new pg.Pool({
      connectionString: options.url,
      max: options.max ?? 10,
      application_name: options.applicationName ?? 'nearkit',
      types,
      ...(options.ssl !== undefined ? { ssl: options.ssl } : {}),
      ...(options.searchPath ? { options: `-c search_path=${options.searchPath}` } : {}),
      // A statement that runs this long is stuck: fail it rather than hold locks forever.
      statement_timeout: 30_000,
      idle_in_transaction_session_timeout: 60_000,
    })
    // An idle client that errors (e.g. the server restarted) is dropped by the pool; don't crash the process.
    this.pool.on('error', () => undefined)
  }

  protected outside<T>(fn: (conn: Connection) => Promise<T>): Promise<T> {
    return fn(connection(this.pool as unknown as PgQueryable))
  }

  protected async transaction<T>(fn: (conn: Connection) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    let broken: Error | undefined
    try {
      await client.query('BEGIN')
      try {
        const result = await fn(connection(client as unknown as PgQueryable))
        await client.query('COMMIT')
        return result
      } catch (e) {
        await client.query('ROLLBACK').catch((rollbackError: unknown) => {
          broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError))
        })
        throw e
      }
    } finally {
      // A client whose rollback failed is in an unknown state: the pool destroys it.
      client.release(broken)
    }
  }

  /** Another pool on the same database and schema: what a second server instance would have. */
  sibling(): PostgresDatabase {
    return new PostgresDatabase(this.options)
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

/** PGlite's surface this adapter needs (kept structural so the WASM package stays a dev dependency). */
export interface PgliteLike {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; affectedRows?: number }>
  exec(text: string): Promise<unknown>
  close(): Promise<void>
}

export class PgliteDatabase extends BaseDatabase {
  readonly dialect = 'postgres' as const
  private readonly lock = new Mutex()
  private readonly conn: Connection

  constructor(private readonly db: PgliteLike) {
    super()
    this.conn = {
      async run(sql, params) {
        return (await db.query(numberPlaceholders(sql), [...params])).affectedRows ?? 0
      },
      async all<T>(sql: string, params: SqlParams): Promise<T[]> {
        return (await db.query(numberPlaceholders(sql), [...params])).rows as T[]
      },
      async exec(sql) {
        await db.exec(sql)
      },
    }
  }

  protected outside<T>(fn: (conn: Connection) => Promise<T>): Promise<T> {
    return this.lock.run(() => fn(this.conn))
  }

  protected transaction<T>(fn: (conn: Connection) => Promise<T>): Promise<T> {
    return this.lock.run(async () => {
      await this.db.exec('BEGIN')
      try {
        const result = await fn(this.conn)
        await this.db.exec('COMMIT')
        return result
      } catch (e) {
        await this.db.exec('ROLLBACK').catch(() => undefined)
        throw e
      }
    })
  }

  async close(): Promise<void> {
    await this.lock.run(() => this.db.close())
  }
}
