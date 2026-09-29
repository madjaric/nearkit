import { randomToken } from '../ids'
import type { Database } from './database'

/**
 * Coordination between server instances that share one database, without any
 * in-memory lock:
 *
 * - Role leases: a role only one instance may run at a time (the Telegram poller:
 *   Telegram serves updates to one reader; the buybot runner) belongs to whoever
 *   holds its lease. A holder renews it; if it stops (crash, network split), the
 *   lease expires and another instance takes over.
 * - Processed updates: a Telegram update that was already handled (a retry, or a
 *   batch re-read after a restart or a leader change) is not handled again.
 */

export class Leases {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes or renews the lease on `name` for `ttlMs`. True when `owner` holds it now. */
  async acquire(name: string, owner: string, ttlMs: number): Promise<boolean> {
    const t = this.now()
    const changed = await this.db.run(
      `INSERT INTO leases (name, owner, until) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, until = excluded.until
       WHERE leases.owner = excluded.owner OR leases.until < ?`,
      [name, owner, t + ttlMs, t],
    )
    return changed === 1
  }

  /** Gives the lease up at once (a clean shutdown), if `owner` still holds it. */
  async release(name: string, owner: string): Promise<void> {
    await this.db.run('DELETE FROM leases WHERE name = ? AND owner = ?', [name, owner])
  }

  async holder(name: string): Promise<{ owner: string; until: number } | null> {
    return (await this.db.get<{ owner: string; until: number }>('SELECT owner, until FROM leases WHERE name = ?', [name])) ?? null
  }

  /** True the first time an update ID is seen; false for every later delivery of it. */
  async firstDelivery(updateId: number): Promise<boolean> {
    return (await this.db.run('INSERT INTO processed_updates (update_id, at) VALUES (?, ?) ON CONFLICT DO NOTHING', [updateId, this.now()])) === 1
  }

  /** Forgets handled updates after a few days (Telegram keeps undelivered ones for 24 hours). */
  async prune(ageMs = 3 * 86_400_000): Promise<void> {
    await this.db.run('DELETE FROM processed_updates WHERE at < ?', [this.now() - ageMs])
  }
}

/** A name for this process in leases: unique per start, readable in the database. */
export function instanceId(): string {
  return `${process.env.HOSTNAME ?? 'nearkit'}-${process.pid}-${randomToken(6)}`
}
