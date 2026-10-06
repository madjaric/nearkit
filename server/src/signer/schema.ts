import type { Database } from '../db/database'
import { runMigrations, type Migration } from '../db/schema'

/**
 * The signer's own tables. In production they live in the signer's own database (its
 * own credentials, which the app never has). On a single testnet process they share the
 * app's database file, as a separate migration track.
 *
 * - signer_keys: every wallet key, sealed (never plain), with its owner binding.
 * - signer_request_nonces: authenticated requests already seen (replay protection).
 * - signer_challenges: one-time messages the owner wallet signs (export, destinations).
 * - signer_destinations: withdrawal destinations the owner approved, with the signed
 *   approval itself, re-verified whenever it is used.
 * - signer_tg_requests / signer_tg_approvals: for wallets with no owner wallet, what the
 *   controlling Telegram account is asked to approve in NearKit's Mini App, and the approvals
 *   it gave, each with Telegram's signed launch data, re-verified whenever it is used.
 * - signer_exports: key exports the owner signed for, held (24 hours by default) until the
 *   hold is over or the wallet's Telegram account releases one sooner in the Mini App; at most
 *   one open per wallet, each collected once. The owner's signature and Telegram's are kept and
 *   re-verified when the key is released.
 * - signer_signatures: one signed transaction per (intent, step), ever.
 * - signer_events: the signer's own audit log (no secrets).
 * - signer_state: the signer pause switch.
 */

const SQLITE: readonly Migration[] = [
  {
    version: 1,
    name: 'signer',
    sql: `
      CREATE TABLE signer_keys (
        network TEXT NOT NULL,
        account_id TEXT NOT NULL,
        public_key TEXT NOT NULL,
        owner_account TEXT,
        owner_key TEXT,
        user_id INTEGER,
        wallet_id TEXT,
        sealed_key TEXT,
        key_ref TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'erased')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        erased_at INTEGER,
        erase_reason TEXT,
        PRIMARY KEY (network, account_id),
        CHECK ((status = 'active' AND sealed_key IS NOT NULL) OR (status = 'erased' AND sealed_key IS NULL))
      );
      CREATE INDEX signer_keys_owner ON signer_keys(network, owner_account);

      CREATE TABLE signer_request_nonces (
        nonce TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX signer_request_nonces_expiry ON signer_request_nonces(expires_at);

      CREATE TABLE signer_challenges (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('owner-session', 'export', 'approve-destination')),
        network TEXT NOT NULL,
        account_id TEXT,
        owner_account TEXT NOT NULL,
        destination TEXT,
        recipient_key TEXT,
        message TEXT NOT NULL,
        nonce TEXT NOT NULL,
        recipient TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        used_key TEXT
      );
      CREATE INDEX signer_challenges_owner ON signer_challenges(network, owner_account, created_at);

      CREATE TABLE signer_destinations (
        id TEXT PRIMARY KEY,
        network TEXT NOT NULL,
        account_id TEXT NOT NULL,
        destination TEXT NOT NULL,
        owner_account TEXT NOT NULL,
        public_key TEXT NOT NULL,
        challenge_id TEXT NOT NULL,
        message TEXT NOT NULL,
        nonce TEXT NOT NULL,
        recipient TEXT NOT NULL,
        signature TEXT NOT NULL,
        approved_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE UNIQUE INDEX signer_destinations_challenge ON signer_destinations(challenge_id);
      CREATE UNIQUE INDEX signer_destinations_live ON signer_destinations(network, account_id, destination) WHERE revoked_at IS NULL;

      CREATE TABLE signer_signatures (
        intent_id TEXT NOT NULL,
        step INTEGER NOT NULL,
        network TEXT NOT NULL,
        account_id TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        signed TEXT NOT NULL,
        nonce TEXT NOT NULL,
        op_kind TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (intent_id, step)
      );
      CREATE INDEX signer_signatures_account ON signer_signatures(network, account_id, created_at);

      CREATE TABLE signer_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        network TEXT,
        account_id TEXT,
        detail TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX signer_events_account ON signer_events(network, account_id, at);

      CREATE TABLE signer_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'telegram-approvals',
    sql: `
      CREATE TABLE signer_tg_requests (
        id TEXT PRIMARY KEY,
        digest TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('destination', 'bind-owner')),
        network TEXT NOT NULL,
        account_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        target TEXT NOT NULL,
        target_key TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );
      CREATE INDEX signer_tg_requests_account ON signer_tg_requests(network, account_id, created_at);

      CREATE TABLE signer_tg_approvals (
        id TEXT PRIMARY KEY,
        network TEXT NOT NULL,
        account_id TEXT NOT NULL,
        destination TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        request_id TEXT NOT NULL UNIQUE,
        request_expires_at INTEGER NOT NULL,
        init_data TEXT NOT NULL,
        approved_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE UNIQUE INDEX signer_tg_approvals_live ON signer_tg_approvals(network, account_id, destination) WHERE revoked_at IS NULL;
    `,
  },
  {
    version: 3,
    name: 'held-exports',
    sql: `
      CREATE TABLE signer_exports (
        id TEXT PRIMARY KEY,
        digest TEXT NOT NULL UNIQUE,
        network TEXT NOT NULL,
        account_id TEXT NOT NULL,
        owner_account TEXT NOT NULL,
        owner_key TEXT NOT NULL,
        signature TEXT NOT NULL,
        message TEXT NOT NULL,
        nonce TEXT NOT NULL,
        recipient TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        recipient_key TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('held', 'confirmed', 'collected', 'cancelled', 'expired')),
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        release_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        confirmed_at INTEGER,
        confirm_init_data TEXT,
        cancelled_at INTEGER,
        cancelled_by TEXT,
        collected_at INTEGER
      );
      CREATE INDEX signer_exports_account ON signer_exports(network, account_id, created_at);
      CREATE UNIQUE INDEX signer_exports_open ON signer_exports(network, account_id) WHERE state IN ('held', 'confirmed');
    `,
  },
]

const POSTGRES: readonly Migration[] = [
  {
    version: 1,
    name: 'signer',
    sql: `
      CREATE TABLE signer_keys (
        network TEXT NOT NULL,
        account_id TEXT NOT NULL,
        public_key TEXT NOT NULL,
        owner_account TEXT,
        owner_key TEXT,
        user_id BIGINT,
        wallet_id TEXT,
        sealed_key TEXT,
        key_ref TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'erased')),
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        erased_at BIGINT,
        erase_reason TEXT,
        PRIMARY KEY (network, account_id),
        CHECK ((status = 'active' AND sealed_key IS NOT NULL) OR (status = 'erased' AND sealed_key IS NULL))
      );
      CREATE INDEX signer_keys_owner ON signer_keys(network, owner_account);

      CREATE TABLE signer_request_nonces (
        nonce TEXT PRIMARY KEY,
        expires_at BIGINT NOT NULL
      );
      CREATE INDEX signer_request_nonces_expiry ON signer_request_nonces(expires_at);

      CREATE TABLE signer_challenges (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('owner-session', 'export', 'approve-destination')),
        network TEXT NOT NULL,
        account_id TEXT,
        owner_account TEXT NOT NULL,
        destination TEXT,
        recipient_key TEXT,
        message TEXT NOT NULL,
        nonce TEXT NOT NULL,
        recipient TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        used_at BIGINT,
        used_key TEXT
      );
      CREATE INDEX signer_challenges_owner ON signer_challenges(network, owner_account, created_at);

      CREATE TABLE signer_destinations (
        id TEXT PRIMARY KEY,
        network TEXT NOT NULL,
        account_id TEXT NOT NULL,
        destination TEXT NOT NULL,
        owner_account TEXT NOT NULL,
        public_key TEXT NOT NULL,
        challenge_id TEXT NOT NULL,
        message TEXT NOT NULL,
        nonce TEXT NOT NULL,
        recipient TEXT NOT NULL,
        signature TEXT NOT NULL,
        approved_at BIGINT NOT NULL,
        revoked_at BIGINT
      );
      CREATE UNIQUE INDEX signer_destinations_challenge ON signer_destinations(challenge_id);
      CREATE UNIQUE INDEX signer_destinations_live ON signer_destinations(network, account_id, destination) WHERE revoked_at IS NULL;

      CREATE TABLE signer_signatures (
        intent_id TEXT NOT NULL,
        step INTEGER NOT NULL,
        network TEXT NOT NULL,
        account_id TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        signed TEXT NOT NULL,
        nonce TEXT NOT NULL,
        op_kind TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (intent_id, step)
      );
      CREATE INDEX signer_signatures_account ON signer_signatures(network, account_id, created_at);

      CREATE TABLE signer_events (
        id BIGSERIAL PRIMARY KEY,
        at BIGINT NOT NULL,
        kind TEXT NOT NULL,
        network TEXT,
        account_id TEXT,
        detail TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX signer_events_account ON signer_events(network, account_id, at);

      CREATE TABLE signer_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at BIGINT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'telegram-approvals',
    sql: `
      CREATE TABLE signer_tg_requests (
        id TEXT PRIMARY KEY,
        digest TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('destination', 'bind-owner')),
        network TEXT NOT NULL,
        account_id TEXT NOT NULL,
        user_id BIGINT NOT NULL,
        target TEXT NOT NULL,
        target_key TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        used_at BIGINT
      );
      CREATE INDEX signer_tg_requests_account ON signer_tg_requests(network, account_id, created_at);

      CREATE TABLE signer_tg_approvals (
        id TEXT PRIMARY KEY,
        network TEXT NOT NULL,
        account_id TEXT NOT NULL,
        destination TEXT NOT NULL,
        user_id BIGINT NOT NULL,
        request_id TEXT NOT NULL UNIQUE,
        request_expires_at BIGINT NOT NULL,
        init_data TEXT NOT NULL,
        approved_at BIGINT NOT NULL,
        revoked_at BIGINT
      );
      CREATE UNIQUE INDEX signer_tg_approvals_live ON signer_tg_approvals(network, account_id, destination) WHERE revoked_at IS NULL;
    `,
  },
  {
    version: 3,
    name: 'held-exports',
    sql: `
      CREATE TABLE signer_exports (
        id TEXT PRIMARY KEY,
        digest TEXT NOT NULL UNIQUE,
        network TEXT NOT NULL,
        account_id TEXT NOT NULL,
        owner_account TEXT NOT NULL,
        owner_key TEXT NOT NULL,
        signature TEXT NOT NULL,
        message TEXT NOT NULL,
        nonce TEXT NOT NULL,
        recipient TEXT NOT NULL,
        user_id BIGINT NOT NULL,
        recipient_key TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('held', 'confirmed', 'collected', 'cancelled', 'expired')),
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL,
        release_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        confirmed_at BIGINT,
        confirm_init_data TEXT,
        cancelled_at BIGINT,
        cancelled_by TEXT,
        collected_at BIGINT
      );
      CREATE INDEX signer_exports_account ON signer_exports(network, account_id, created_at);
      CREATE UNIQUE INDEX signer_exports_open ON signer_exports(network, account_id) WHERE state IN ('held', 'confirmed');
    `,
  },
]

export const SIGNER_MIGRATIONS = { sqlite: SQLITE, postgres: POSTGRES }
export const LATEST_SIGNER_SCHEMA = SQLITE.at(-1)?.version ?? 0

export async function migrateSigner(db: Database): Promise<number> {
  return runMigrations(db, db.dialect === 'postgres' ? POSTGRES : SQLITE, 'signer_schema_version')
}
