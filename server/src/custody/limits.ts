/**
 * Canonical limits on NearKit wallets. None is a limit on money: trades and
 * withdrawals have no monetary cap (owner decision).
 */

/**
 * NearKit wallets one Telegram user may have active at once, per network. The
 * database enforces the same bound (trading_wallets.slot is CHECKed to 1..10 and
 * unique per user while active), so no race can open an 11th. A deleted or revoked
 * wallet frees its slot: over a lifetime a user may create any number.
 */
export const MAX_ACTIVE_WALLETS_PER_USER = 10

/** Wallets a user may create in a day: abuse protection (each is a key and a KMS call), not a trading limit. */
export const MAX_WALLET_CREATIONS_PER_DAY = 10

/** A wallet's label is shown in Telegram: short, one line, plain text. */
export const MAX_WALLET_LABEL = 24

/** The name a wallet shows under: its label, else "Main" for the first slot, else "Wallet N". */
export function walletName(w: { slot: number; label: string | null }): string {
  return w.label ?? (w.slot === 1 ? 'Main' : `Wallet ${w.slot}`)
}
