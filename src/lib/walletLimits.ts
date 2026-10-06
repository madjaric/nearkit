/**
 * NEARKITS wallets one Telegram user may have active at once, per network: one figure for the
 * server (custody/limits.ts, which the database's slot CHECK matches) and for what the site says.
 */
export const MAX_ACTIVE_WALLETS_PER_USER = 10
