import type { Database } from './database'
import { PG_MIGRATIONS } from './pgSchema'

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
  {
    version: 2,
    name: 'buybot: configurations, block cursor, candidates, detected buys, deliveries',
    sql: `
      -- One token followed in one chat. Amounts in yoctoNEAR as TEXT.
      CREATE TABLE buybot_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        chat_title TEXT,
        network TEXT NOT NULL,
        token TEXT NOT NULL,
        symbol TEXT NOT NULL,
        name TEXT NOT NULL,
        decimals INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        min_near TEXT NOT NULL DEFAULT '0',
        emoji TEXT NOT NULL DEFAULT '🟢',
        step_near TEXT NOT NULL DEFAULT '1000000000000000000000000',
        silent INTEGER NOT NULL DEFAULT 0,
        paused_reason TEXT,
        created_by INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (chat_id, network, token)
      );
      CREATE INDEX buybot_configs_token ON buybot_configs(network, token);
      -- Transactions that touched a followed token. Read in full, then kept a while
      -- as done so the index showing them again doesn't cause another read.
      CREATE TABLE buybot_candidates (
        tx_hash TEXT PRIMARY KEY,
        network TEXT NOT NULL,
        tokens TEXT NOT NULL,
        block_height INTEGER NOT NULL,
        first_seen INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL,
        done_at INTEGER
      );
      CREATE INDEX buybot_candidates_due ON buybot_candidates(network, done_at, next_at);
      -- A detected buy. The key (tx, token, buyer) makes detection idempotent.
      CREATE TABLE buybot_events (
        event_key TEXT PRIMARY KEY,
        network TEXT NOT NULL,
        token TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        buyer TEXT NOT NULL,
        amount TEXT NOT NULL,
        paid TEXT NOT NULL,
        block_height INTEGER NOT NULL,
        detected_at INTEGER NOT NULL
      );
      -- One message per (buy, chat). The key makes delivery idempotent.
      CREATE TABLE buybot_deliveries (
        event_key TEXT NOT NULL REFERENCES buybot_events(event_key) ON DELETE CASCADE,
        config_id INTEGER NOT NULL REFERENCES buybot_configs(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL,
        message_id INTEGER,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (event_key, config_id)
      );
      CREATE INDEX buybot_deliveries_due ON buybot_deliveries(status, next_at);
    `,
  },
  {
    version: 3,
    name: 'trade handoffs: trades prepared in Telegram, signed in the web app',
    sql: `
      CREATE TABLE handoffs (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
        chat_id INTEGER NOT NULL,
        network TEXT NOT NULL,
        account_id TEXT NOT NULL,
        side TEXT NOT NULL,
        token_in TEXT NOT NULL,
        token_out TEXT NOT NULL,
        amount_in TEXT NOT NULL,
        slippage_pct REAL NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        tx_hashes TEXT,
        result TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX handoffs_user ON handoffs(user_id, created_at);
    `,
  },
  {
    version: 4,
    name: 'buybot v2: USD or NEAR thresholds, emoji cap, media, sell alerts',
    sql: `
      -- Minimum and emoji step are in this unit: NEAR (min_near, step_near) or USD (min_usd, step_usd).
      ALTER TABLE buybot_configs ADD COLUMN unit TEXT NOT NULL DEFAULT 'NEAR';
      ALTER TABLE buybot_configs ADD COLUMN min_usd REAL NOT NULL DEFAULT 0;
      ALTER TABLE buybot_configs ADD COLUMN step_usd REAL NOT NULL DEFAULT 10;
      ALTER TABLE buybot_configs ADD COLUMN max_emoji INTEGER NOT NULL DEFAULT 30;
      -- A photo, GIF or video posted with every alert (Telegram file_id), or none.
      ALTER TABLE buybot_configs ADD COLUMN media_kind TEXT;
      ALTER TABLE buybot_configs ADD COLUMN media_file_id TEXT;
      ALTER TABLE buybot_configs ADD COLUMN sells INTEGER NOT NULL DEFAULT 0;
      -- 'buy' or 'sell'; paid holds the other side (what a buyer paid, what a seller got).
      ALTER TABLE buybot_events ADD COLUMN side TEXT NOT NULL DEFAULT 'buy';
    `,
  },
  {
    version: 5,
    name: 'trading wallets: sealed keys, transaction intents, signed transactions, audit, recovery',
    sql: `
      -- A NearKit trading wallet: a NEAR implicit account whose key NearKit holds, sealed.
      -- sealed_key is envelope ciphertext (custody/vault.ts); the key that opens it is never
      -- in this database. It is erased (NULL) when the wallet is revoked or deleted.
      CREATE TABLE trading_wallets (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES telegram_users(user_id),
        network TEXT NOT NULL,
        account_id TEXT NOT NULL,
        public_key TEXT NOT NULL,
        sealed_key TEXT,
        key_ref TEXT NOT NULL,
        status TEXT NOT NULL,
        backup_key TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at INTEGER
      );
      -- One live wallet per Telegram user and network, however often "create" is pressed.
      CREATE UNIQUE INDEX trading_wallets_live ON trading_wallets(user_id, network) WHERE status = 'active';
      CREATE UNIQUE INDEX trading_wallets_account ON trading_wallets(network, account_id);
      -- One confirmation in Telegram = one intent. Its status only moves forward.
      CREATE TABLE wallet_intents (
        id TEXT PRIMARY KEY,
        wallet_id TEXT NOT NULL REFERENCES trading_wallets(id),
        user_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        params TEXT NOT NULL,
        quote TEXT,
        status TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        result TEXT,
        replaced_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX wallet_intents_wallet ON wallet_intents(wallet_id, status);
      CREATE INDEX wallet_intents_open ON wallet_intents(status, updated_at);
      -- Every transaction NearKit signs, saved BEFORE it is sent: the idempotency record.
      -- A signed transaction is public data (it is broadcast), never a secret.
      CREATE TABLE wallet_txs (
        intent_id TEXT NOT NULL REFERENCES wallet_intents(id),
        step INTEGER NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        signer_id TEXT NOT NULL,
        receiver_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        -- The transaction can't land once the chain passes this height.
        expires_height INTEGER NOT NULL,
        signed TEXT NOT NULL,
        plan TEXT NOT NULL,
        status TEXT NOT NULL,
        outcome TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (intent_id, step)
      );
      CREATE INDEX wallet_txs_status ON wallet_txs(status);
      -- Append-only security log: public facts only (IDs, accounts, hashes, amounts).
      CREATE TABLE custody_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        user_id INTEGER,
        wallet_id TEXT,
        action TEXT NOT NULL,
        detail TEXT
      );
      CREATE INDEX custody_audit_wallet ON custody_audit(wallet_id, id);
      -- Key export in the web app: a one-time code (stored as SHA-256) and the exact message to sign.
      CREATE TABLE recovery_requests (
        code_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        wallet_id TEXT NOT NULL REFERENCES trading_wallets(id),
        network TEXT NOT NULL,
        nonce TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        verified_at INTEGER,
        verified_account TEXT,
        exported_at INTEGER
      );
      CREATE INDEX recovery_requests_user ON recovery_requests(user_id, created_at);
    `,
  },
  {
    version: 6,
    name: 'trading wallets: the owner (linked wallet and key the wallet was created with)',
    sql: `
      -- Export, the backup key and removing NearKit's key answer to the owner only, never
      -- to whichever wallet happens to be linked now (a stolen Telegram session could link one).
      ALTER TABLE trading_wallets ADD COLUMN owner_account TEXT;
      ALTER TABLE trading_wallets ADD COLUMN owner_key TEXT;
      -- Wallets from before: a wallet still linked to the user that was already linked to them
      -- when the NearKit wallet was created (creating one required it), the default one first.
      UPDATE trading_wallets SET
        owner_account = (
          SELECT a.account_id FROM account_links a LEFT JOIN user_settings s ON s.user_id = a.user_id
          WHERE a.user_id = trading_wallets.user_id AND a.network = trading_wallets.network
            AND EXISTS (SELECT 1 FROM link_events e WHERE e.kind = 'linked' AND e.network = a.network AND e.account_id = a.account_id
                          AND e.user_id = a.user_id AND e.at <= trading_wallets.created_at)
          ORDER BY (a.account_id = s.default_account) DESC, a.linked_at ASC LIMIT 1
        ),
        owner_key = (
          SELECT a.public_key FROM account_links a LEFT JOIN user_settings s ON s.user_id = a.user_id
          WHERE a.user_id = trading_wallets.user_id AND a.network = trading_wallets.network
            AND EXISTS (SELECT 1 FROM link_events e WHERE e.kind = 'linked' AND e.network = a.network AND e.account_id = a.account_id
                          AND e.user_id = a.user_id AND e.at <= trading_wallets.created_at)
          ORDER BY (a.account_id = s.default_account) DESC, a.linked_at ASC LIMIT 1
        )
      WHERE owner_account IS NULL;
      -- A backup key added before this may belong to another linked wallet: forget it, so the
      -- Recovery screen lists it as a key that isn't the owner's.
      UPDATE trading_wallets SET backup_key = NULL WHERE backup_key IS NOT NULL AND (owner_key IS NULL OR backup_key <> owner_key);
    `,
  },
  {
    version: 7,
    name: 'multi-instance safety: execution leases, one intent in flight per wallet, role leases, processed Telegram updates',
    sql: `
      -- Which server instance runs an in-flight intent, and until when. Signing and recording
      -- a transaction require holding the lease; the resolver takes over only expired ones.
      ALTER TABLE wallet_intents ADD COLUMN lease_owner TEXT;
      ALTER TABLE wallet_intents ADD COLUMN lease_until INTEGER;
      -- The database, not a process, guarantees one intent in flight per wallet.
      CREATE UNIQUE INDEX wallet_intents_one_in_flight ON wallet_intents(wallet_id) WHERE status IN ('confirmed', 'signing', 'submitted');
      -- Singleton roles (the Telegram poller, the buybot runner): one holder at a time.
      CREATE TABLE leases (
        name TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        until INTEGER NOT NULL
      );
      -- Telegram updates already handled: a retried or re-delivered update runs once.
      CREATE TABLE processed_updates (
        update_id INTEGER PRIMARY KEY,
        at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 8,
    name: 'multi-wallet: up to 10 active NearKit wallets per user, labels, idempotent creation, the selected wallet',
    sql: `
      -- Each active wallet takes one of the user's 10 slots (MAX_ACTIVE_WALLETS_PER_USER, custody/limits.ts):
      -- the database itself refuses an 11th. A deleted or revoked wallet frees its slot.
      ALTER TABLE trading_wallets ADD COLUMN slot INTEGER NOT NULL DEFAULT 1 CHECK (slot BETWEEN 1 AND 10);
      ALTER TABLE trading_wallets ADD COLUMN label TEXT;
      -- The Create button's one-time key: a double tap makes one wallet, not two.
      ALTER TABLE trading_wallets ADD COLUMN create_key TEXT;
      DROP INDEX trading_wallets_live;
      CREATE UNIQUE INDEX trading_wallets_slot ON trading_wallets(user_id, network, slot) WHERE status = 'active';
      CREATE UNIQUE INDEX trading_wallets_create_key ON trading_wallets(user_id, create_key) WHERE create_key IS NOT NULL;
      -- The wallet Telegram trades from; the lowest slot when unset or no longer active.
      ALTER TABLE user_settings ADD COLUMN active_wallet TEXT;
    `,
  },
  {
    version: 9,
    name: 'referrals: codes, permanent attribution, idempotent earnings, owner-paid claims',
    sql: `
      -- Referrals: one permanent code per user; one permanent referrer per referred user.
      CREATE TABLE referral_codes (
        user_id INTEGER PRIMARY KEY REFERENCES telegram_users(user_id) ON DELETE CASCADE,
        code TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE referrals (
        referred_user_id INTEGER PRIMARY KEY REFERENCES telegram_users(user_id) ON DELETE CASCADE,
        referrer_user_id INTEGER NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
        code TEXT NOT NULL,
        attributed_at INTEGER NOT NULL,
        CHECK (referred_user_id <> referrer_user_id)
      );
      CREATE INDEX referrals_referrer ON referrals(referrer_user_id, attributed_at);
      -- One earning per fee-bearing trade (source, source_id), whatever retries or replays.
      -- Amounts are raw units of the fee token, as decimal text.
      CREATE TABLE referral_earnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        referrer_user_id INTEGER NOT NULL,
        referred_user_id INTEGER NOT NULL,
        network TEXT NOT NULL,
        token TEXT NOT NULL,
        received_raw TEXT NOT NULL,
        referral_raw TEXT NOT NULL,
        net_raw TEXT NOT NULL,
        volume_raw TEXT NOT NULL,
        tx_hash TEXT,
        created_at INTEGER NOT NULL,
        claim_id TEXT,
        forfeited_at INTEGER
      );
      CREATE UNIQUE INDEX referral_earnings_source ON referral_earnings(source, source_id);
      CREATE INDEX referral_earnings_referrer ON referral_earnings(referrer_user_id, network, token);
      -- A claim: the owner pays it from NearKit's account (no hot wallet) and records the transaction.
      CREATE TABLE referral_claims (
        id TEXT PRIMARY KEY,
        referrer_user_id INTEGER NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
        network TEXT NOT NULL,
        token TEXT NOT NULL,
        amount_raw TEXT NOT NULL,
        destination TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('requested', 'paid', 'rejected')),
        requested_at INTEGER NOT NULL,
        settled_at INTEGER,
        tx_hash TEXT,
        note TEXT
      );
      CREATE INDEX referral_claims_referrer ON referral_claims(referrer_user_id, requested_at);
      CREATE UNIQUE INDEX referral_claims_open ON referral_claims(referrer_user_id, network, token) WHERE status = 'requested';
      CREATE UNIQUE INDEX referral_claims_tx ON referral_claims(tx_hash) WHERE tx_hash IS NOT NULL;
    `,
  },
  {
    version: 10,
    name: 'kill switches: trading and withdrawal pauses, frozen wallets',
    sql: `
      -- Operator switches (npm run ops). Unknown or unreadable means paused: they fail closed.
      CREATE TABLE ops_switches (
        name TEXT PRIMARY KEY,
        paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
        reason TEXT,
        updated_at INTEGER NOT NULL,
        updated_by TEXT NOT NULL
      );
      -- A frozen wallet neither trades nor withdraws; its owner can still add the backup key and export.
      ALTER TABLE trading_wallets ADD COLUMN frozen_at INTEGER;
      ALTER TABLE trading_wallets ADD COLUMN frozen_reason TEXT;
    `,
  },
  {
    version: 11,
    name: 'NearKit web: sign-in links, sessions, and grouped web trades',
    sql: `
      -- Sign-in links the bot sends in the user's own chat (one-time codes), and the sessions they
      -- open. Only SHA-256 of a code or token is stored. A session lists, creates and renames the
      -- user's NearKit wallets, and runs their trades and sends (group_id ties a Multi Buy together).
      CREATE TABLE web_login_codes (
        code_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );
      CREATE INDEX web_login_codes_user ON web_login_codes(user_id, created_at);
      CREATE TABLE web_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX web_sessions_user ON web_sessions(user_id);
      -- The intents one confirmation covers (a trade prepared on NearKit web, one per wallet).
      ALTER TABLE wallet_intents ADD COLUMN group_id TEXT;
      CREATE INDEX wallet_intents_group ON wallet_intents(group_id);
    `,
  },
  {
    version: 12,
    name: 'NearKit web: the order a user lists their NearKit wallets in',
    sql: `
      -- Where the user put the wallet in their list (1 first); NULL: never ordered, listed by slot after the ordered ones.
      ALTER TABLE trading_wallets ADD COLUMN display_order INTEGER;
    `,
  },
  {
    version: 13,
    name: 'Volume Bot: bots, their wallets, runs, trades, events and metrics',
    sql: `
      -- A user's Volume Bot: its configuration (JSON, src/lib/volumeBot/types.ts), its state, and the worker's lease.
      CREATE TABLE volume_bots (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
        network TEXT NOT NULL,
        token TEXT NOT NULL,
        strategy TEXT NOT NULL,
        config TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'running', 'paused', 'stopping', 'stopped', 'completed')),
        pause_code TEXT,
        pause_reason TEXT,
        next_tick_at INTEGER,
        lease_owner TEXT,
        lease_until INTEGER,
        started_at INTEGER,
        stopped_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX volume_bots_due ON volume_bots(status, next_tick_at);
      CREATE INDEX volume_bots_user ON volume_bots(user_id, created_at);
      -- One live bot per user and token: two of theirs could otherwise trade it against each other.
      CREATE UNIQUE INDEX volume_bots_one_live_per_token ON volume_bots(user_id, network, token) WHERE status IN ('running', 'paused', 'stopping');
      CREATE TABLE volume_bot_wallets (
        bot_id TEXT NOT NULL REFERENCES volume_bots(id) ON DELETE CASCADE,
        wallet_id TEXT NOT NULL REFERENCES trading_wallets(id),
        PRIMARY KEY (bot_id, wallet_id)
      );
      -- A run: from Start to its end; its state (progress, fair value, books, baselines) as JSON.
      CREATE TABLE volume_bot_runs (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES volume_bots(id) ON DELETE CASCADE,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        end_reason TEXT,
        state TEXT NOT NULL
      );
      CREATE INDEX volume_bot_runs_bot ON volume_bot_runs(bot_id, started_at);
      -- Each trade the bot sent: its intent, and what really moved once it settled.
      CREATE TABLE volume_bot_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL REFERENCES volume_bots(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        wallet_id TEXT NOT NULL,
        intent_id TEXT,
        side TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('submitted', 'confirmed', 'failed')),
        near_raw TEXT,
        token_raw TEXT,
        price_near REAL,
        impact_bps REAL,
        fee_near REAL,
        gas_near REAL,
        near_usd REAL,
        tx_hash TEXT,
        message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX volume_bot_trades_bot ON volume_bot_trades(bot_id, created_at);
      CREATE UNIQUE INDEX volume_bot_trades_intent ON volume_bot_trades(intent_id) WHERE intent_id IS NOT NULL;
      -- What happened to a bot, in its owner's words: starts, pauses (the guardian's with their code), skips, errors.
      CREATE TABLE volume_bot_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL REFERENCES volume_bots(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        code TEXT,
        message TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX volume_bot_events_bot ON volume_bot_events(bot_id, at);
      -- The bot's figures over time, for its charts.
      CREATE TABLE volume_bot_metrics (
        bot_id TEXT NOT NULL REFERENCES volume_bots(id) ON DELETE CASCADE,
        at INTEGER NOT NULL,
        price_near REAL,
        equity_near REAL,
        pnl_near REAL,
        token_pct REAL,
        inventory_tokens REAL,
        volume_near REAL NOT NULL,
        trades INTEGER NOT NULL,
        PRIMARY KEY (bot_id, at)
      );
    `,
  },
  {
    version: 14,
    name: 'Referrals: one earning per on-chain transaction',
    sql: `
      -- A transaction pays NEARKITS one fee: it earns its referrer once, whichever record (intent or handoff) reports it.
      CREATE UNIQUE INDEX referral_earnings_tx ON referral_earnings(network, tx_hash) WHERE tx_hash IS NOT NULL;
    `,
  },
  {
    version: 15,
    name: 'Bridge & Buy $KITS: orders through NEAR Intents and the purchase after them',
    sql: `
      -- One Bridge & Buy: the quote the user reviewed (and 1Click's signed answer), where it stands
      -- with NEAR Intents, the NEAR delivered (checked on chain) and the $KITS bought with it.
      -- kind 'nearkits': to one of the user's NEARKITS wallets (user_id, wallet_id), bought by the server;
      -- 'connected': to a connected NEAR wallet, whose owner signs the purchase. No key or secret is stored.
      CREATE TABLE bridge_orders (
        id TEXT PRIMARY KEY,
        network TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('nearkits', 'connected')),
        user_id INTEGER REFERENCES telegram_users(user_id) ON DELETE CASCADE,
        wallet_id TEXT REFERENCES trading_wallets(id),
        recipient TEXT NOT NULL,
        chain TEXT NOT NULL,
        origin_asset TEXT NOT NULL,
        source_address TEXT NOT NULL,
        amount_in TEXT NOT NULL,
        deposit_address TEXT NOT NULL,
        deposit_deadline INTEGER NOT NULL,
        sign_by INTEGER NOT NULL,
        quote TEXT NOT NULL,
        oneclick TEXT NOT NULL,
        kits_min_per_near TEXT,
        kits_slippage REAL NOT NULL,
        status TEXT NOT NULL,
        intents_status TEXT,
        deposit_tx TEXT,
        delivered TEXT,
        kits TEXT,
        refund TEXT,
        stage2 TEXT,
        message TEXT,
        next_check_at INTEGER,
        checks INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_until INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX bridge_orders_deposit ON bridge_orders(deposit_address);
      CREATE INDEX bridge_orders_due ON bridge_orders(next_check_at);
      CREATE INDEX bridge_orders_user ON bridge_orders(user_id, created_at);
    `,
  },
]

/**
 * Brings the database up to the newest version (or to `target`, for tests of a
 * migration), with the migrations of its engine: SQLite's below, Postgres's in
 * pgSchema.ts. Each migration and its version record commit together. On
 * Postgres an advisory lock makes instances that start at once take turns, so a
 * migration never runs twice.
 */
export async function migrate(db: Database, target = Number.POSITIVE_INFINITY): Promise<number> {
  return runMigrations(db, db.dialect === 'postgres' ? PG_MIGRATIONS : MIGRATIONS, 'schema_version', target)
}

export type Migration = { version: number; name: string; sql: string }

/**
 * Applies `list` up to `target`, each migration in its own transaction, recording the
 * version under `key` in the meta table. On PostgreSQL every step holds an advisory
 * lock, so instances starting together migrate one at a time. The signer's tables are
 * a separate track (signer/schema.ts) with its own key.
 */
export async function runMigrations(db: Database, list: readonly Migration[], key: string, target = Number.POSITIVE_INFINITY): Promise<number> {
  const versionOf = async () => Number((await db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key]))?.value ?? '0')
  const lock = async () => {
    if (db.dialect === 'postgres') await db.get("SELECT pg_advisory_xact_lock(hashtext('nearkit:migrate'))")
  }
  await db.tx(async () => {
    await lock()
    await db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  })
  let version = 0
  for (const m of list) {
    if (m.version > target) break
    version = await db.tx(async () => {
      await lock()
      const current = await versionOf()
      if (m.version <= current) return current
      await db.exec(m.sql)
      await db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, String(m.version)])
      return m.version
    })
  }
  return Math.max(version, await versionOf())
}

/** The newest schema version of each engine. */
export const LATEST_SCHEMA = { sqlite: MIGRATIONS.at(-1)?.version ?? 0, postgres: PG_MIGRATIONS.at(-1)?.version ?? 0 }
