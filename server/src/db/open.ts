import type { Database } from './database'
import { PostgresDatabase } from './postgres'
import { SqliteDatabase } from './sqlite'

/** Where the server keeps its state: a SQLite file (development, testnet beta) or PostgreSQL (production). */
export type DatabaseConfig = { kind: 'sqlite'; path: string } | { kind: 'postgres'; url: string }

export async function openDatabase(config: DatabaseConfig, applicationName = 'nearkit'): Promise<Database> {
  return config.kind === 'postgres' ? new PostgresDatabase({ url: config.url, applicationName }) : SqliteDatabase.open(config.path)
}

/** A loggable description: the SQLite path, or the Postgres host and database without credentials. */
export function describeDatabase(config: DatabaseConfig): string {
  if (config.kind === 'sqlite') return config.path
  try {
    const u = new URL(config.url)
    return `postgres://${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`
  } catch {
    return 'postgres (unreadable URL)'
  }
}

/** Parts of a connection URL that must never reach a log: the URL itself and its password. */
export function databaseSecrets(config: DatabaseConfig): string[] {
  if (config.kind !== 'postgres') return []
  const out = [config.url]
  try {
    const password = new URL(config.url).password
    if (password) out.push(password, decodeURIComponent(password))
  } catch {
    // an unreadable URL is refused by the configuration anyway
  }
  return out.filter((s) => s.length >= 4)
}
