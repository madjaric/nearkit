import { describe, expect, it } from 'vitest'
import type { Database } from './database'
import { LATEST_SCHEMA, migrate } from './schema'
import { ENGINE_TIMEOUT_MS, openTestDatabase } from './testing'

/**
 * SQLite (development, testnet beta) and PostgreSQL (production) must describe
 * the same database: tables, columns, NOT NULL, and every unique rule (primary
 * keys, unique indexes, partial ones included). This compares the two after
 * migrating each to its newest version.
 */

interface Shape {
  tables: Record<string, Record<string, { notNull: boolean }>>
  /** "table(col,col)" for each unique rule, with "where" when it is partial. */
  unique: string[]
}

async function sqliteShape(db: Database): Promise<Shape> {
  const tables = (await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).map((r) => r.name)
  const shape: Shape = { tables: {}, unique: [] }
  for (const t of tables) {
    const cols = await db.all<{ name: string; notnull: number; pk: number }>(`PRAGMA table_info("${t}")`)
    shape.tables[t] = Object.fromEntries(cols.map((c) => [c.name, { notNull: c.notnull === 1 || c.pk > 0 }]))
    const pk = cols
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name)
    if (pk.length) shape.unique.push(`${t}(${pk.join(',')})`)
    for (const idx of await db.all<{ name: string; unique: number; origin: string; partial: number }>(`PRAGMA index_list("${t}")`)) {
      if (idx.unique !== 1 || idx.origin === 'pk') continue
      const on = (await db.all<{ name: string; seqno: number }>(`PRAGMA index_info("${idx.name}")`)).sort((a, b) => a.seqno - b.seqno).map((c) => c.name)
      shape.unique.push(`${t}(${on.join(',')})${idx.partial ? ' where' : ''}`)
    }
  }
  shape.unique.sort()
  return shape
}

async function postgresShape(db: Database): Promise<Shape> {
  const cols = await db.all<{ table_name: string; column_name: string; is_nullable: string }>(
    'SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position',
  )
  const shape: Shape = { tables: {}, unique: [] }
  for (const c of cols) (shape.tables[c.table_name] ??= {})[c.column_name] = { notNull: c.is_nullable === 'NO' }
  const idx = await db.all<{ tablename: string; indexdef: string }>(
    "SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexdef LIKE 'CREATE UNIQUE%'",
  )
  for (const i of idx) {
    const on =
      /\(([^)]*)\)/
        .exec(i.indexdef)?.[1]
        ?.split(',')
        .map((s) => s.trim().replace(/"/g, '')) ?? []
    shape.unique.push(`${i.tablename}(${on.join(',')})${/ WHERE /i.test(i.indexdef) ? ' where' : ''}`)
  }
  shape.unique.sort()
  return shape
}

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
