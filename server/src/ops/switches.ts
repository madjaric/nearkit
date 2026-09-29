import type { CustodyStore, Intent, IntentKind, TradingWallet } from '../custody/store'
import type { Database } from '../db/database'

/**
 * NearKit's kill switches, set by the operator (npm run ops) and read on every wallet
 * action. They fail closed: a switch that can't be read counts as paused.
 *
 * What each one stops, and what keeps working:
 *
 * - trading: no new Buy or Sell from NearKit wallets (quotes and confirmations are
 *   refused). Withdrawals, deposits, unwrapping wNEAR, the backup key, export and
 *   revoking keep working, so everyone can still take their funds out.
 * - withdrawals: no withdrawal from any NearKit wallet, not even to its owner. Trading,
 *   the backup key and export (owner-signed, in NearKit web) keep working: an owner can
 *   always take control with their own wallet.
 * - a frozen wallet: that wallet neither trades nor withdraws. Its owner can still add the
 *   backup key and export its key.
 * - the signer's own pause (signer/admin.ts, or `npm run ops -- signer-pause`): nothing
 *   is signed, exported, approved or erased anywhere. Funds stay where they are; a
 *   wallet with a backup key is still its owner's to move directly on chain.
 *
 * In every case transactions already sent are still followed to the end (the resolver
 * only reads the chain) and the bot keeps answering.
 */

export type SwitchName = 'trading' | 'withdrawals'
export const SWITCHES: readonly SwitchName[] = ['trading', 'withdrawals']

export interface SwitchState {
  paused: boolean
  reason: string | null
  since: number | null
}

/** Which switch, if any, stops this kind of intent. */
const SWITCH_OF: Partial<Record<IntentKind, SwitchName>> = { buy: 'trading', sell: 'trading', withdraw: 'withdrawals' }
/** What a frozen wallet may still do: things that only hand control to its owner or stay inside it. */
const ALLOWED_WHEN_FROZEN: readonly IntentKind[] = ['backup-key', 'revoke', 'unwrap']

export class OpsSwitches {
  constructor(
    private readonly db: Database,
    private readonly audit: Pick<CustodyStore, 'audit'>,
    private readonly now: () => number = Date.now,
  ) {}

  async state(): Promise<Record<SwitchName, SwitchState>> {
    const rows = await this.db.all<{ name: string; paused: number; reason: string | null; updated_at: number }>('SELECT name, paused, reason, updated_at FROM ops_switches')
    const of = (name: SwitchName): SwitchState => {
      const r = rows.find((x) => x.name === name)
      return r && r.paused === 1 ? { paused: true, reason: r.reason, since: r.updated_at } : { paused: false, reason: null, since: r?.updated_at ?? null }
    }
    return { trading: of('trading'), withdrawals: of('withdrawals') }
  }

  async set(name: SwitchName, paused: boolean, reason: string, by: string): Promise<void> {
    await this.db.run(
      `INSERT INTO ops_switches (name, paused, reason, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET paused = excluded.paused, reason = excluded.reason, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [name, paused ? 1 : 0, reason, this.now(), by],
    )
    await this.audit.audit({ action: paused ? 'ops-paused' : 'ops-resumed', detail: { switch: name, reason, by } })
  }

  /**
   * Why `kind` can't run on `wallet` now, in a sentence for the user; null when it can.
   * Fails closed: if the switches can't be read, nothing that a switch covers runs.
   */
  async blocked(kind: IntentKind, wallet: Pick<TradingWallet, 'frozenAt'> | null): Promise<string | null> {
    if (wallet?.frozenAt && !ALLOWED_WHEN_FROZEN.includes(kind))
      return 'This NearKit wallet is frozen by NearKit for your protection. Its owner wallet can still add the backup key or export the key in NearKit web.'
    const name = SWITCH_OF[kind]
    if (!name) return null
    let s: Record<SwitchName, SwitchState>
    try {
      s = await this.state()
    } catch {
      return 'NearKit can’t confirm that this is allowed right now. Try again in a moment.'
    }
    if (!s[name].paused) return null
    return name === 'trading'
      ? 'Trading from NearKit wallets is paused by NearKit right now. Withdrawals and recovery still work.'
      : 'Withdrawals are paused by NearKit right now. Your owner wallet can still add the backup key or export the key in NearKit web.'
  }

  /** The engine's gate: the same rule, for an intent at Confirm. */
  gate = (intent: Intent, wallet: TradingWallet): Promise<string | null> => this.blocked(intent.kind, wallet)
}
