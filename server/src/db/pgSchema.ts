/**
 * PostgreSQL schema (production). It describes the same tables, columns, keys and
 * unique indexes as the SQLite migrations in schema.ts; schema.test.ts compares
 * the two after migrating both, so they can't drift apart.
 *
 * Types: IDs and big amounts are TEXT (yoctoNEAR does not fit in 64 bits);
 * timestamps (ms) and Telegram IDs are BIGINT; flags are INTEGER 0/1 like SQLite.
 *
 * No production database exists before the first mainnet deployment, so version
 * 1 is a baseline. After that, never edit a shipped migration: add the next one,
 * together with its SQLite twin.
 */

export const PG_MIGRATIONS: readonly { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'baseline: users, links, conversation state, buybot, handoffs, trading wallets, intents, audit, recovery',
    sql: `
      CREATE TABLE telegram_users (
        user_id BIGINT PRIMARY KEY,
        username TEXT,
        first_name TEXT NOT NULL,
        language_code TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        blocked_at BIGINT
      );
      CREATE TABLE user_settings (
        user_id BIGINT PRIMARY KEY REFERENCES telegram_users(user_id) ON DELETE CASCADE,
        slippage_pct DOUBLE PRECISION NOT NULL,
        buy_presets TEXT NOT NULL,
        sell_presets TEXT NOT NULL,
        default_account TEXT,
        notify_trades INTEGER NOT NULL,
        updated_at BIGINT NOT NULL,
        active_wallet TEXT
      );
      CREATE TABLE link_requests (
        code_hash TEXT PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
        network TEXT NOT NULL,
        nonce TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        used_at BIGINT,
        linked_account TEXT
      );
      CREATE INDEX link_requests_user ON link_requests(user_id, created_at);
      CREATE TABLE account_links (
        network TEXT NOT NULL,
        account_id TEXT NOT NULL,
        user_id BIGINT NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
        public_key TEXT NOT NULL,
        linked_at BIGINT NOT NULL,
        PRIMARY KEY (network, account_id)
      );
      CREATE INDEX account_links_user ON account_links(user_id);
      CREATE TABLE link_events (
        id BIGSERIAL PRIMARY KEY,
        network TEXT NOT NULL,
        account_id TEXT NOT NULL,
        user_id BIGINT NOT NULL,
        kind TEXT NOT NULL,
        detail TEXT,
        at BIGINT NOT NULL
      );
      CREATE TABLE sessions (
        chat_id BIGINT NOT NULL,
        user_id BIGINT NOT NULL,
        flow TEXT NOT NULL,
        data TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        PRIMARY KEY (chat_id, user_id)
      );
      CREATE TABLE callbacks (
        id TEXT PRIMARY KEY,
        user_id BIGINT NOT NULL,
        chat_id BIGINT NOT NULL,
        payload TEXT NOT NULL,
        expires_at BIGINT NOT NULL
      );
      CREATE TABLE user_tokens (
        user_id BIGINT NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
        network TEXT NOT NULL,
        contract TEXT NOT NULL,
        added_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, network, contract)
      );

      CREATE TABLE buybot_configs (
        id BIGSERIAL PRIMARY KEY,
        chat_id BIGINT NOT NULL,
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
        created_by BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        unit TEXT NOT NULL DEFAULT 'NEAR',
        min_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
        step_usd DOUBLE PRECISION NOT NULL DEFAULT 10,
        max_emoji INTEGER NOT NULL DEFAULT 30,
        media_kind TEXT,
        media_file_id TEXT,
        sells INTEGER NOT NULL DEFAULT 0,
        UNIQUE (chat_id, network, token)
      );
      CREATE INDEX buybot_configs_token ON buybot_configs(network, token);
      CREATE TABLE buybot_candidates (
        tx_hash TEXT PRIMARY KEY,
        network TEXT NOT NULL,
        tokens TEXT NOT NULL,
        block_height BIGINT NOT NULL,
        first_seen BIGINT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at BIGINT NOT NULL,
        done_at BIGINT
      );
      CREATE INDEX buybot_candidates_due ON buybot_candidates(network, done_at, next_at);
      CREATE TABLE buybot_events (
        event_key TEXT PRIMARY KEY,
        network TEXT NOT NULL,
        token TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        buyer TEXT NOT NULL,
        amount TEXT NOT NULL,
        paid TEXT NOT NULL,
        block_height BIGINT NOT NULL,
        detected_at BIGINT NOT NULL,
        side TEXT NOT NULL DEFAULT 'buy'
      );
      CREATE TABLE buybot_deliveries (
        event_key TEXT NOT NULL REFERENCES buybot_events(event_key) ON DELETE CASCADE,
        config_id BIGINT NOT NULL REFERENCES buybot_configs(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at BIGINT NOT NULL,
        message_id BIGINT,
        error TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (event_key, config_id)
      );
      CREATE INDEX buybot_deliveries_due ON buybot_deliveries(status, next_at);

      CREATE TABLE handoffs (
        id TEXT PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
        chat_id BIGINT NOT NULL,
        network TEXT NOT NULL,
        account_id TEXT NOT NULL,
        side TEXT NOT NULL,
        token_in TEXT NOT NULL,
        token_out TEXT NOT NULL,
        amount_in TEXT NOT NULL,
        slippage_pct DOUBLE PRECISION NOT NULL,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        status TEXT NOT NULL,
        tx_hashes TEXT,
        result TEXT,
        updated_at BIGINT NOT NULL
      );
      CREATE INDEX handoffs_user ON handoffs(user_id, created_at);

      CREATE TABLE trading_wallets (
        id TEXT PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES telegram_users(user_id),
        network TEXT NOT NULL,
        account_id TEXT NOT NULL,
        public_key TEXT NOT NULL,
        sealed_key TEXT,
        key_ref TEXT NOT NULL,
        status TEXT NOT NULL,
        backup_key TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        closed_at BIGINT,
        owner_account TEXT,
        owner_key TEXT,
        slot INTEGER NOT NULL DEFAULT 1 CHECK (slot BETWEEN 1 AND 10),
        label TEXT,
        create_key TEXT,
        frozen_at BIGINT,
        frozen_reason TEXT
      );
      CREATE UNIQUE INDEX trading_wallets_slot ON trading_wallets(user_id, network, slot) WHERE status = 'active';
      CREATE UNIQUE INDEX trading_wallets_create_key ON trading_wallets(user_id, create_key) WHERE create_key IS NOT NULL;
      CREATE UNIQUE INDEX trading_wallets_account ON trading_wallets(network, account_id);
      CREATE TABLE wallet_intents (
        id TEXT PRIMARY KEY,
        wallet_id TEXT NOT NULL REFERENCES trading_wallets(id),
        user_id BIGINT NOT NULL,
        chat_id BIGINT NOT NULL,
        kind TEXT NOT NULL,
        params TEXT NOT NULL,
        quote TEXT,
        status TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        result TEXT,
        replaced_by TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        lease_owner TEXT,
        lease_until BIGINT
      );
      CREATE INDEX wallet_intents_wallet ON wallet_intents(wallet_id, status);
      CREATE INDEX wallet_intents_open ON wallet_intents(status, updated_at);
      CREATE UNIQUE INDEX wallet_intents_one_in_flight ON wallet_intents(wallet_id) WHERE status IN ('confirmed', 'signing', 'submitted');
      CREATE TABLE wallet_txs (
        intent_id TEXT NOT NULL REFERENCES wallet_intents(id),
        step INTEGER NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        signer_id TEXT NOT NULL,
        receiver_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        expires_height BIGINT NOT NULL,
        signed TEXT NOT NULL,
        plan TEXT NOT NULL,
        status TEXT NOT NULL,
        outcome TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (intent_id, step)
      );
      CREATE INDEX wallet_txs_status ON wallet_txs(status);
      CREATE TABLE custody_audit (
        id BIGSERIAL PRIMARY KEY,
        at BIGINT NOT NULL,
        user_id BIGINT,
        wallet_id TEXT,
        action TEXT NOT NULL,
        detail TEXT
      );
      CREATE INDEX custody_audit_wallet ON custody_audit(wallet_id, id);
      CREATE TABLE recovery_requests (
        code_hash TEXT PRIMARY KEY,
        user_id BIGINT NOT NULL,
        wallet_id TEXT NOT NULL REFERENCES trading_wallets(id),
        network TEXT NOT NULL,
        nonce TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        verified_at BIGINT,
        verified_account TEXT,
        exported_at BIGINT
      );
      CREATE INDEX recovery_requests_user ON recovery_requests(user_id, created_at);

      CREATE TABLE leases (
        name TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        until BIGINT NOT NULL
      );
      CREATE TABLE processed_updates (
        update_id BIGINT PRIMARY KEY,
        at BIGINT NOT NULL
      );

      CREATE TABLE referral_codes (
        user_id BIGINT PRIMARY KEY REFERENCES telegram_users(user_id) ON DELETE CASCADE,
        code TEXT NOT NULL UNIQUE,
        created_at BIGINT NOT NULL
      );
      CREATE TABLE referrals (
        referred_user_id BIGINT PRIMARY KEY REFERENCES telegram_users(user_id) ON DELETE CASCADE,
        referrer_user_id BIGINT NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
        code TEXT NOT NULL,
        attributed_at BIGINT NOT NULL,
        CHECK (referred_user_id <> referrer_user_id)
      );
      CREATE INDEX referrals_referrer ON referrals(referrer_user_id, attributed_at);
      CREATE TABLE referral_earnings (
        id BIGSERIAL PRIMARY KEY,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        referrer_user_id BIGINT NOT NULL,
        referred_user_id BIGINT NOT NULL,
        network TEXT NOT NULL,
        token TEXT NOT NULL,
        received_raw TEXT NOT NULL,
        referral_raw TEXT NOT NULL,
        net_raw TEXT NOT NULL,
        volume_raw TEXT NOT NULL,
        tx_hash TEXT,
        created_at BIGINT NOT NULL,
        claim_id TEXT,
        forfeited_at BIGINT
      );
      CREATE UNIQUE INDEX referral_earnings_source ON referral_earnings(source, source_id);
      CREATE INDEX referral_earnings_referrer ON referral_earnings(referrer_user_id, network, token);
      CREATE TABLE referral_claims (
        id TEXT PRIMARY KEY,
        referrer_user_id BIGINT NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
        network TEXT NOT NULL,
        token TEXT NOT NULL,
        amount_raw TEXT NOT NULL,
        destination TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('requested', 'paid', 'rejected')),
        requested_at BIGINT NOT NULL,
        settled_at BIGINT,
        tx_hash TEXT,
        note TEXT
      );
      CREATE INDEX referral_claims_referrer ON referral_claims(referrer_user_id, requested_at);
      CREATE UNIQUE INDEX referral_claims_open ON referral_claims(referrer_user_id, network, token) WHERE status = 'requested';
      CREATE UNIQUE INDEX referral_claims_tx ON referral_claims(tx_hash) WHERE tx_hash IS NOT NULL;

      CREATE TABLE ops_switches (
        name TEXT PRIMARY KEY,
        paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
        reason TEXT,
        updated_at BIGINT NOT NULL,
        updated_by TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'NearKit web: sign-in links, sessions, and grouped web trades',
    sql: `
      CREATE TABLE web_login_codes (
        code_hash TEXT PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        used_at BIGINT
      );
      CREATE INDEX web_login_codes_user ON web_login_codes(user_id, created_at);
      CREATE TABLE web_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        revoked_at BIGINT
      );
      CREATE INDEX web_sessions_user ON web_sessions(user_id);
      ALTER TABLE wallet_intents ADD COLUMN group_id TEXT;
      CREATE INDEX wallet_intents_group ON wallet_intents(group_id);
    `,
  },
  {
    version: 3,
    name: 'NearKit web: the order a user lists their NearKit wallets in',
    sql: `
      ALTER TABLE trading_wallets ADD COLUMN display_order INTEGER;
    `,
  },
  {
    version: 4,
    name: 'Volume Bot: bots, their wallets, runs, trades, events and metrics',
    sql: `
      CREATE TABLE volume_bots (
        id TEXT PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
        network TEXT NOT NULL,
        token TEXT NOT NULL,
        strategy TEXT NOT NULL,
        config TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'running', 'paused', 'stopping', 'stopped', 'completed')),
        pause_code TEXT,
        pause_reason TEXT,
        next_tick_at BIGINT,
        lease_owner TEXT,
        lease_until BIGINT,
        started_at BIGINT,
        stopped_at BIGINT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
      CREATE INDEX volume_bots_due ON volume_bots(status, next_tick_at);
      CREATE INDEX volume_bots_user ON volume_bots(user_id, created_at);
      CREATE UNIQUE INDEX volume_bots_one_live_per_token ON volume_bots(user_id, network, token) WHERE status IN ('running', 'paused', 'stopping');
      CREATE TABLE volume_bot_wallets (
        bot_id TEXT NOT NULL REFERENCES volume_bots(id) ON DELETE CASCADE,
        wallet_id TEXT NOT NULL REFERENCES trading_wallets(id),
        PRIMARY KEY (bot_id, wallet_id)
      );
      CREATE TABLE volume_bot_runs (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES volume_bots(id) ON DELETE CASCADE,
        started_at BIGINT NOT NULL,
        ended_at BIGINT,
        end_reason TEXT,
        state TEXT NOT NULL
      );
      CREATE INDEX volume_bot_runs_bot ON volume_bot_runs(bot_id, started_at);
      CREATE TABLE volume_bot_trades (
        id BIGSERIAL PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES volume_bots(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        wallet_id TEXT NOT NULL,
        intent_id TEXT,
        side TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('submitted', 'confirmed', 'failed')),
        near_raw TEXT,
        token_raw TEXT,
        price_near DOUBLE PRECISION,
        impact_bps DOUBLE PRECISION,
        fee_near DOUBLE PRECISION,
        gas_near DOUBLE PRECISION,
        near_usd DOUBLE PRECISION,
        tx_hash TEXT,
        message TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
      CREATE INDEX volume_bot_trades_bot ON volume_bot_trades(bot_id, created_at);
      CREATE UNIQUE INDEX volume_bot_trades_intent ON volume_bot_trades(intent_id) WHERE intent_id IS NOT NULL;
      CREATE TABLE volume_bot_events (
        id BIGSERIAL PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES volume_bots(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        code TEXT,
        message TEXT NOT NULL,
        at BIGINT NOT NULL
      );
      CREATE INDEX volume_bot_events_bot ON volume_bot_events(bot_id, at);
      CREATE TABLE volume_bot_metrics (
        bot_id TEXT NOT NULL REFERENCES volume_bots(id) ON DELETE CASCADE,
        at BIGINT NOT NULL,
        price_near DOUBLE PRECISION,
        equity_near DOUBLE PRECISION,
        pnl_near DOUBLE PRECISION,
        token_pct DOUBLE PRECISION,
        inventory_tokens DOUBLE PRECISION,
        volume_near DOUBLE PRECISION NOT NULL,
        trades INTEGER NOT NULL,
        PRIMARY KEY (bot_id, at)
      );
    `,
  },
  {
    version: 5,
    name: 'Referrals: one earning per on-chain transaction',
    sql: `
      CREATE UNIQUE INDEX referral_earnings_tx ON referral_earnings(network, tx_hash) WHERE tx_hash IS NOT NULL;
    `,
  },
  {
    version: 6,
    name: 'Bridge & Buy $KITS: orders through NEAR Intents and the purchase after them',
    sql: `
      CREATE TABLE bridge_orders (
        id TEXT PRIMARY KEY,
        network TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('nearkits', 'connected')),
        user_id BIGINT REFERENCES telegram_users(user_id) ON DELETE CASCADE,
        wallet_id TEXT REFERENCES trading_wallets(id),
        recipient TEXT NOT NULL,
        chain TEXT NOT NULL,
        origin_asset TEXT NOT NULL,
        source_address TEXT NOT NULL,
        amount_in TEXT NOT NULL,
        deposit_address TEXT NOT NULL,
        deposit_deadline BIGINT NOT NULL,
        sign_by BIGINT NOT NULL,
        quote TEXT NOT NULL,
        oneclick TEXT NOT NULL,
        kits_min_per_near TEXT,
        kits_slippage DOUBLE PRECISION NOT NULL,
        status TEXT NOT NULL,
        intents_status TEXT,
        deposit_tx TEXT,
        delivered TEXT,
        kits TEXT,
        refund TEXT,
        stage2 TEXT,
        message TEXT,
        next_check_at BIGINT,
        checks INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_until BIGINT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
      CREATE UNIQUE INDEX bridge_orders_deposit ON bridge_orders(deposit_address);
      CREATE INDEX bridge_orders_due ON bridge_orders(next_check_at);
      CREATE INDEX bridge_orders_user ON bridge_orders(user_id, created_at);
    `,
  },
  {
    version: 7,
    name: 'The generic Bridge beside Bridge & Buy: an order says which product it is, and may go to any NEAR account',
    sql: `
      ALTER TABLE bridge_orders DROP CONSTRAINT bridge_orders_kind_check;
      ALTER TABLE bridge_orders ADD CONSTRAINT bridge_orders_kind_check CHECK (kind IN ('nearkits', 'connected', 'external'));
      ALTER TABLE bridge_orders ADD COLUMN product TEXT NOT NULL DEFAULT 'buy-kits' CHECK (product IN ('buy-kits', 'bridge'));
    `,
  },
]
