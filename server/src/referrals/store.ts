import { isUniqueViolation, type Database } from '../db/database'
import { randomToken } from '../ids'

/**
 * Referral accounting (schema v9). Every amount is raw units of the fee token, kept as
 * decimal text and added up with BigInt. The database enforces the rules that matter
 * for money: one code per user, one referrer per referred user (never themselves), one
 * earning per trade, one open claim per token, one payout transaction per claim.
 */

export interface Attribution {
  referredUserId: number
  referrerUserId: number
  code: string
  attributedAt: number
}

export interface Earning {
  id: number
  source: string
  sourceId: string
  referrerUserId: number
  referredUserId: number
  network: string
  token: string
  received: bigint
  referral: bigint
  net: bigint
  volume: bigint
  txHash: string | null
  createdAt: number
  claimId: string | null
  forfeitedAt: number | null
}

export type ClaimStatus = 'requested' | 'paid' | 'rejected'

export interface Claim {
  id: string
  referrerUserId: number
  network: string
  token: string
  amount: bigint
  destination: string
  status: ClaimStatus
  requestedAt: number
  settledAt: number | null
  txHash: string | null
  note: string | null
}

interface EarningRow {
  id: number
  source: string
  source_id: string
  referrer_user_id: number
  referred_user_id: number
  network: string
  token: string
  received_raw: string
  referral_raw: string
  net_raw: string
  volume_raw: string
  tx_hash: string | null
  created_at: number
  claim_id: string | null
  forfeited_at: number | null
}

const toEarning = (r: EarningRow): Earning => ({
  id: r.id,
  source: r.source,
  sourceId: r.source_id,
  referrerUserId: r.referrer_user_id,
  referredUserId: r.referred_user_id,
  network: r.network,
  token: r.token,
  received: BigInt(r.received_raw),
  referral: BigInt(r.referral_raw),
  net: BigInt(r.net_raw),
  volume: BigInt(r.volume_raw),
  txHash: r.tx_hash,
  createdAt: r.created_at,
  claimId: r.claim_id,
  forfeitedAt: r.forfeited_at,
})

interface ClaimRow {
  id: string
  referrer_user_id: number
  network: string
  token: string
  amount_raw: string
  destination: string
  status: ClaimStatus
  requested_at: number
  settled_at: number | null
  tx_hash: string | null
  note: string | null
}

const toClaim = (r: ClaimRow): Claim => ({
  id: r.id,
  referrerUserId: r.referrer_user_id,
  network: r.network,
  token: r.token,
  amount: BigInt(r.amount_raw),
  destination: r.destination,
  status: r.status,
  requestedAt: r.requested_at,
  settledAt: r.settled_at,
  txHash: r.tx_hash,
  note: r.note,
})

/** Codes people can read aloud and type: no 0/O, 1/I/L. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function newReferralCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('')
}

export const isReferralCode = (s: string) => /^[A-HJ-KM-NP-Z2-9]{8}$/.test(s)

export class ReferralStore {
  constructor(
    readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  // ─── codes and attribution ────────────────────────────────────────────────

  async codeOf(userId: number): Promise<string | null> {
    return (await this.db.get<{ code: string }>('SELECT code FROM referral_codes WHERE user_id = ?', [userId]))?.code ?? null
  }

  /** The user's one permanent code, made on first use. */
  async ensureCode(userId: number): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const existing = await this.codeOf(userId)
      if (existing) return existing
      try {
        await this.db.attempt(() =>
          this.db.run('INSERT INTO referral_codes (user_id, code, created_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO NOTHING', [userId, newReferralCode(), this.now()]),
        )
      } catch (e) {
        // A code collision (another user's code): try another.
        if (!isUniqueViolation(e)) throw e
      }
    }
    const code = await this.codeOf(userId)
    if (!code) throw new Error('Could not make a referral code')
    return code
  }

  async referrerOfCode(code: string): Promise<number | null> {
    return (await this.db.get<{ user_id: number }>('SELECT user_id FROM referral_codes WHERE code = ?', [code]))?.user_id ?? null
  }

  async attribution(referredUserId: number): Promise<Attribution | null> {
    const r = await this.db.get<{ referred_user_id: number; referrer_user_id: number; code: string; attributed_at: number }>('SELECT * FROM referrals WHERE referred_user_id = ?', [
      referredUserId,
    ])
    return r ? { referredUserId: r.referred_user_id, referrerUserId: r.referrer_user_id, code: r.code, attributedAt: r.attributed_at } : null
  }

  /** Once per referred user, ever: false when they already have a referrer. */
  async attribute(a: Omit<Attribution, 'attributedAt'>): Promise<boolean> {
    return (
      (await this.db.run('INSERT INTO referrals (referred_user_id, referrer_user_id, code, attributed_at) VALUES (?, ?, ?, ?) ON CONFLICT (referred_user_id) DO NOTHING', [
        a.referredUserId,
        a.referrerUserId,
        a.code,
        this.now(),
      ])) === 1
    )
  }

  async referredCount(referrerUserId: number): Promise<number> {
    return (await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM referrals WHERE referrer_user_id = ?', [referrerUserId]))?.n ?? 0
  }

  // ─── earnings ─────────────────────────────────────────────────────────────

  /** One earning per trade: false when this trade was already recorded (a retry or a replay). */
  async recordEarning(e: Omit<Earning, 'id' | 'createdAt' | 'claimId' | 'forfeitedAt'>): Promise<boolean> {
    return (
      (await this.db.run(
        `INSERT INTO referral_earnings (source, source_id, referrer_user_id, referred_user_id, network, token, received_raw, referral_raw, net_raw, volume_raw, tx_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        [
          e.source,
          e.sourceId,
          e.referrerUserId,
          e.referredUserId,
          e.network,
          e.token,
          e.received.toString(),
          e.referral.toString(),
          e.net.toString(),
          e.volume.toString(),
          e.txHash,
          this.now(),
        ],
      )) === 1
    )
  }

  async earningsOf(referrerUserId: number, network: string): Promise<Earning[]> {
    return (await this.db.all<EarningRow>('SELECT * FROM referral_earnings WHERE referrer_user_id = ? AND network = ? ORDER BY id', [referrerUserId, network])).map(toEarning)
  }

  async allEarnings(network: string): Promise<Earning[]> {
    return (await this.db.all<EarningRow>('SELECT * FROM referral_earnings WHERE network = ? ORDER BY id', [network])).map(toEarning)
  }

  // ─── claims ───────────────────────────────────────────────────────────────

  async claim(id: string): Promise<Claim | null> {
    const r = await this.db.get<ClaimRow>('SELECT * FROM referral_claims WHERE id = ?', [id])
    return r ? toClaim(r) : null
  }

  async claimsOf(referrerUserId: number, network: string): Promise<Claim[]> {
    return (await this.db.all<ClaimRow>('SELECT * FROM referral_claims WHERE referrer_user_id = ? AND network = ? ORDER BY requested_at', [referrerUserId, network])).map(toClaim)
  }

  async claims(network: string, status?: ClaimStatus): Promise<Claim[]> {
    return (
      await this.db.all<ClaimRow>(`SELECT * FROM referral_claims WHERE network = ?${status ? ' AND status = ?' : ''} ORDER BY requested_at`, status ? [network, status] : [network])
    ).map(toClaim)
  }

  /**
   * Claims everything available in `token` at once: the unclaimed earnings are tied to one
   * new claim in the same transaction. One open claim per token: a second request returns
   * the open one ('open'). Nothing available: 'empty'.
   */
  async createClaim(c: { referrerUserId: number; network: string; token: string; destination: string }): Promise<{ kind: 'created' | 'open'; claim: Claim } | { kind: 'empty' }> {
    const open = async () =>
      (await this.db.get<ClaimRow>("SELECT * FROM referral_claims WHERE referrer_user_id = ? AND network = ? AND token = ? AND status = 'requested'", [
        c.referrerUserId,
        c.network,
        c.token,
      ])) ?? null
    try {
      return await this.db.tx(async () => {
        const existing = await open()
        if (existing) return { kind: 'open' as const, claim: toClaim(existing) }
        const rows = await this.db.all<{ id: number; referral_raw: string }>(
          'SELECT id, referral_raw FROM referral_earnings WHERE referrer_user_id = ? AND network = ? AND token = ? AND claim_id IS NULL AND forfeited_at IS NULL',
          [c.referrerUserId, c.network, c.token],
        )
        const amount = rows.reduce((s, r) => s + BigInt(r.referral_raw), 0n)
        if (amount === 0n) {
          // A request that committed since the first look may hold them (PostgreSQL reads
          // committed rows per statement): answer with its claim, not "nothing to claim".
          const claimed = await open()
          return claimed ? { kind: 'open' as const, claim: toClaim(claimed) } : { kind: 'empty' as const }
        }
        const id = randomToken(12)
        const t = this.now()
        await this.db.run(
          "INSERT INTO referral_claims (id, referrer_user_id, network, token, amount_raw, destination, status, requested_at) VALUES (?, ?, ?, ?, ?, ?, 'requested', ?)",
          [id, c.referrerUserId, c.network, c.token, amount.toString(), c.destination, t],
        )
        let tied = 0
        for (const r of rows) tied += await this.db.run('UPDATE referral_earnings SET claim_id = ? WHERE id = ? AND claim_id IS NULL', [id, r.id])
        // Something claimed these first: undo, never pay twice.
        if (tied !== rows.length) throw new ClaimRaceError()
        return { kind: 'created' as const, claim: (await this.claim(id)) as Claim }
      })
    } catch (e) {
      if (e instanceof ClaimRaceError || isUniqueViolation(e)) {
        const existing = await open()
        if (existing) return { kind: 'open', claim: toClaim(existing) }
      }
      throw e
    }
  }

  /** The owner paid it (the transaction is verified by the caller first). Once only. */
  async markPaid(id: string, txHash: string): Promise<boolean> {
    return (await this.db.run("UPDATE referral_claims SET status = 'paid', tx_hash = ?, settled_at = ? WHERE id = ? AND status = 'requested'", [txHash, this.now(), id])) === 1
  }

  /**
   * The owner refuses it. Its earnings go back to available, or with `forfeit` (abuse) are
   * kept out of every future claim.
   */
  async reject(id: string, note: string, forfeit: boolean): Promise<boolean> {
    return this.db.tx(async () => {
      const t = this.now()
      if ((await this.db.run("UPDATE referral_claims SET status = 'rejected', note = ?, settled_at = ? WHERE id = ? AND status = 'requested'", [note, t, id])) !== 1) return false
      if (forfeit) await this.db.run('UPDATE referral_earnings SET forfeited_at = ? WHERE claim_id = ?', [t, id])
      else await this.db.run('UPDATE referral_earnings SET claim_id = NULL WHERE claim_id = ?', [id])
      return true
    })
  }
}

class ClaimRaceError extends Error {}
