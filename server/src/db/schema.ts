import type { Db } from './sqlite'

/**
 * Versioned schema. Each migration runs once, in a transaction, and the version
 * is recorded in `meta`. Never edit a shipped migration: add the next one.
 * Big numbers (yoctoNEAR, token raw amounts) are TEXT; Telegram IDs fit in
 * SQLite's INTEGER and a JS number (< 2^53).
 */

export const MIGRATIONS: readonly { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'telegram users, settings, account links, conversation state',
    sql: `
      CREATE TABLE telegram_users (
        user_id INTEGER PRIMARY KEY,
        username TEXT,
        first_name TEXT NOT NULL,
        language_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        blocked_at INTEGER
      );
      CREATE TABLE user_settings (
        user_id INTEGER PRIMARY KEY REFERENCES telegram_users(user_id) ON DELETE CASCADE,
        slippage_pct REAL NOT NULL,
        buy_presets TEXT NOT NULL,
        sell_presets TEXT NOT NULL,
        default_account TEXT,
        notify_trades INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      -- One-time link codes. Only the SHA-256 of the code is stored.
      CREATE TABLE link_requests (
        code_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
        network TEXT NOT NULL,
        nonce TEXT NOT NULL,
        -- The exact text the wallet signs, fixed when the code is issued.
        message TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        used_at INTEGER,
        linked_account TEXT
      );
      CREATE INDEX link_requests_user ON link_requests(user_id, created_at);
      -- A NEAR account belongs to at most one Telegram user per network.
      CREATE TABLE account_links (
        network TEXT NOT NULL,
        account_id TEXT NOT NULL,
        user_id INTEGER NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
        public_key TEXT NOT NULL,
        linked_at INTEGER NOT NULL,
        PRIMARY KEY (network, account_id)
      );
      CREATE INDEX account_links_user ON account_links(user_id);
      -- Append-only audit of link changes (no secrets: account IDs and public keys only).
      CREATE TABLE link_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        network TEXT NOT NULL,
        account_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        detail TEXT,
        at INTEGER NOT NULL
      );
      CREATE TABLE sessions (
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        flow TEXT NOT NULL,
        data TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, user_id)
      );
      -- Button payloads too long for Telegram's 64-byte callback_data.
      CREATE TABLE callbacks (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        payload TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE user_tokens (
        user_id INTEGER NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
        network TEXT NOT NULL,
        contract TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, network, contract)
      );
    `,
  },
]

export function migrate(db: Db): number {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const current = Number(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")?.value ?? '0')
  let version = current
  for (const m of MIGRATIONS) {
    if (m.version <= version) continue
    db.tx(() => {
      db.exec(m.sql)
      db.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(m.version)])
    })
    version = m.version
  }
  return version
}
