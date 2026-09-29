import { describe, expect, it } from 'vitest'
import { LATEST_SCHEMA, migrate } from './schema'
import { postgresShape, sqliteShape } from './shape'
import { ENGINE_TIMEOUT_MS, openTestDatabase } from './testing'

/**
 * SQLite (development, testnet beta) and PostgreSQL (production) must describe
 * the same database: tables, columns, NOT NULL, and every unique rule (primary
 * keys, unique indexes, partial ones included). This compares the two after
 * migrating each to its newest version.
 */

describe('schema', () => {
  it(
    'SQLite and PostgreSQL describe the same tables, columns and unique rules',
    async () => {
      const sqlite = await openTestDatabase('sqlite')
      const pg = await openTestDatabase('pglite')
      const [a, b] = [await sqliteShape(sqlite), await postgresShape(pg)]
      expect(Object.keys(b.tables).sort()).toEqual(Object.keys(a.tables).sort())
      for (const t of Object.keys(a.tables)) expect({ table: t, columns: b.tables[t] }).toEqual({ table: t, columns: a.tables[t] })
      expect(b.unique).toEqual(a.unique)
    },
    ENGINE_TIMEOUT_MS,
  )

  it(
    'migrating again changes nothing, on either engine',
    async () => {
      for (const engine of ['sqlite', 'pglite'] as const) {
        const db = await openTestDatabase(engine)
        expect(await migrate(db)).toBe(LATEST_SCHEMA[engine === 'sqlite' ? 'sqlite' : 'postgres'])
        expect(await migrate(db)).toBe(LATEST_SCHEMA[engine === 'sqlite' ? 'sqlite' : 'postgres'])
      }
    },
    ENGINE_TIMEOUT_MS,
  )
})
