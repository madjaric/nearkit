import type { Database } from '../db/database'

/**
 * Testnet wallets made before the signer kept their sealed key in the app's own table.
 * On a single-process (testnet) server the app's and the signer's tables share one
 * database: this moves each such key into the signer's vault as it is (v1 sealing, which
 * still opens with the same KEK) and clears the app's copy, all in one transaction. It
 * runs at every start and does nothing once there is nothing left to move. The reseal
 * tool (npm run server:signer-reseal) later moves them to the owner-bound v2 sealing.
 */
export async function importLegacyKeys(db: Database, now: () => number = Date.now): Promise<number> {
  return db.tx(async () => {
    const rows = await db.all<{
      id: string
      user_id: number
      network: string
      account_id: string
      public_key: string
      sealed_key: string
      key_ref: string
      owner_account: string | null
      owner_key: string | null
    }>("SELECT id, user_id, network, account_id, public_key, sealed_key, key_ref, owner_account, owner_key FROM trading_wallets WHERE sealed_key IS NOT NULL AND status = 'active'")
    let moved = 0
    for (const r of rows) {
      const t = now()
      const inserted = await db.run(
        `INSERT INTO signer_keys (network, account_id, public_key, owner_account, owner_key, user_id, wallet_id, sealed_key, key_ref, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?) ON CONFLICT (network, account_id) DO NOTHING`,
        [r.network, r.account_id, r.public_key, r.owner_account, r.owner_key, r.user_id, r.id, r.sealed_key, r.key_ref, t, t],
      )
      if (inserted === 1) {
        moved++
        await db.run("INSERT INTO signer_events (at, kind, network, account_id, detail) VALUES (?, 'key-imported', ?, ?, ?)", [
          t,
          r.network,
          r.account_id,
          JSON.stringify({ from: 'app table', wallet: r.id }),
        ])
      }
      await db.run('UPDATE trading_wallets SET sealed_key = NULL WHERE id = ?', [r.id])
    }
    return moved
  })
}
