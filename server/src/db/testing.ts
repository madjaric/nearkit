import { randomBytes } from 'node:crypto'
import { afterAll } from 'vitest'
import type { Database } from './database'
import { PgliteDatabase, PostgresDatabase } from './postgres'
import { migrate } from './schema'
import { SqliteDatabase } from './sqlite'

/**
 * Fresh, migrated databases for tests, on each engine NearKit runs on:
 *
 * - `sqlite`: sql.js in memory (development and the testnet beta).
 * - `pglite`: PostgreSQL compiled to WebAssembly (the production dialect, one connection).
 * - `postgres`: a real PostgreSQL server, when NEARKIT_TEST_DATABASE_URL is set (CI runs
 *   one); each database is its own schema. Concurrency tests need it: several
 *   connections racing for the same row.
 *
 * NEARKIT_TEST_DB (comma-separated) chooses the engines suites run on; by default
 * SQLite and PGlite, plus Postgres when its URL is set.
 */

export type TestEngine = 'sqlite' | 'pglite' | 'postgres'

const PG_URL = process.env.NEARKIT_TEST_DATABASE_URL?.trim() || null

export const TEST_ENGINES: TestEngine[] = (() => {
  const chosen = process.env.NEARKIT_TEST_DB?.split(',')
    .map((s) => s.trim())
    .filter((s): s is TestEngine => s === 'sqlite' || s === 'pglite' || s === 'postgres')
  if (chosen?.length) return chosen
  return PG_URL ? ['sqlite', 'pglite', 'postgres'] : ['sqlite', 'pglite']
})()

/** Per-test timeout for suites that run on PGlite: its first database takes a while to start. */
export const ENGINE_TIMEOUT_MS = 120_000

const open: Database[] = []
afterAll(async () => {
  await Promise.all(open.splice(0).map((db) => db.close().catch(() => undefined)))
})

interface PgliteInstance {
  clone(): Promise<PgliteInstance>
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; affectedRows?: number }>
  exec(text: string): Promise<unknown>
  close(): Promise<void>
}

let template: Promise<PgliteInstance> | null = null

/** A migrated PGlite, made once per test worker; every test gets a clone of it. */
function pgliteTemplate(): Promise<PgliteInstance> {
  template ??= (async () => {
    const { PGlite, types } = await import('@electric-sql/pglite')
    const pg = new PGlite({ parsers: { [types.INT8]: (v: string) => Number(v) } }) as unknown as PgliteInstance
    await migrate(new PgliteDatabase(pg))
    return pg
  })()
  return template
}

/** A fresh database on `engine`, migrated to the newest schema (or to `target`). */
export async function openTestDatabase(engine: TestEngine = 'sqlite', options: { migrateTo?: number } = {}): Promise<Database> {
  let db: Database
  if (engine === 'pglite') {
    if (options.migrateTo !== undefined) {
      const { PGlite, types } = await import('@electric-sql/pglite')
      db = new PgliteDatabase(new PGlite({ parsers: { [types.INT8]: (v: string) => Number(v) } }) as unknown as PgliteInstance)
    } else {
      db = new PgliteDatabase(await (await pgliteTemplate()).clone())
    }
  } else if (engine === 'postgres') {
    if (!PG_URL) throw new Error('NEARKIT_TEST_DATABASE_URL is not set')
    const schema = `t_${randomBytes(6).toString('hex')}`
    const admin = new PostgresDatabase({ url: PG_URL, max: 1 })
    await admin.exec(`CREATE SCHEMA ${schema}`)
    await admin.close()
    db = new PostgresDatabase({ url: PG_URL, max: 8, searchPath: schema })
  } else {
    db = await SqliteDatabase.open(null)
  }
  open.push(db)
  if (engine !== 'pglite' || options.migrateTo !== undefined) await migrate(db, options.migrateTo)
  return db
}

/** A second connection pool on the same database, as another server instance would have (Postgres only). */
export function anotherInstance(db: Database): Database {
  if (!(db instanceof PostgresDatabase)) throw new Error('Only a Postgres server has separate instances')
  const other = db.sibling()
  open.push(other)
  return other
}
