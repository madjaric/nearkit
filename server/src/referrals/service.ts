import type { NetworkConfig } from '@/config/networks'
import { referralSplit } from '@/lib/fees'
import type { CustodyStore, Intent, TradingWallet } from '../custody/store'
import type { Store } from '../db/store'
import { silentLogger, type Logger } from '../log'
import { isReferralCode, ReferralStore, type Claim } from './store'

/**
 * NearKit referrals.
 *
 * - Every user has one permanent code, shared as t.me/<bot>?start=ref_<CODE>.
 * - A NEW user who arrives through a code is attributed to its owner once, for good:
 *   nobody refers themselves, nobody changes or repeats an attribution, no loops.
 *   "New": first seen in the last ATTRIBUTION_WINDOW_MS, with no linked wallet and no
 *   NearKit wallet yet.
 * - A referrer earns NEARKIT_FEE.referralShareBps (20%) of what NearKit's fee account
 *   actually received on chain from each trade of the people they referred (Rhea's
 *   `earn_app_fee`, after Rhea's share): 0.08% of the volume. The trader pays the same
 *   0.50% as everyone. One earning per trade, whatever retries or replays; nothing is
 *   earned on a trade whose fee went elsewhere, or on a trade the referrer made
 *   themselves through someone else's account (their own linked wallet).
 * - Earnings are claimed per token. The owner pays claims from NearKit's own account after
 *   review and records the payout transaction, which is checked on chain
 *   (referrals/admin.ts): NearKit runs no hot wallet for this.
 */

export const ATTRIBUTION_WINDOW_MS = 10 * 60_000

export type AttributionResult = 'attributed' | 'unknown-code' | 'self' | 'already' | 'not-new' | 'loop'

export interface TradeFee {
  /** Fee token contract. */
  token: string
  /** What the fee account received (`earn_app_fee`), raw units. */
  raw: string
  /** The account it was credited to. */
  recipient: string
}

export interface TokenTotals {
  token: string
  volume: bigint
  earned: bigint
  claimed: bigint
  pending: bigint
  available: bigint
}

export interface ReferralSummary {
  code: string
  referred: number
  tokens: TokenTotals[]
  claims: Claim[]
}

export function createReferrals(deps: {
  db: ReferralStore['db']
  store: Store
  custody: CustodyStore | null
  network: NetworkConfig
  /** The account NearKit's fee must have gone to for a trade to earn anything (the production one on mainnet). */
  feeRecipient: string | null
  now?: () => number
  log?: Logger
}) {
  const now = deps.now ?? Date.now
  const log = deps.log ?? silentLogger
  const rs = new ReferralStore(deps.db, now)
  const network = deps.network.id
  const routerShareBps = deps.network.rhea.aggregator?.appFeeRouterShareBps ?? 0

  async function isNew(userId: number): Promise<boolean> {
    const first = await deps.db.get<{ created_at: number }>('SELECT created_at FROM telegram_users WHERE user_id = ?', [userId])
    if (!first || now() - first.created_at > ATTRIBUTION_WINDOW_MS) return false
    if ((await deps.store.linksOf(userId, network)).length) return false
    if (deps.custody && (await deps.custody.countWalletsSince(userId, 0)) > 0) return false
    return true
  }

  return {
    store: rs,

    /** The user's permanent invite link. */
    async link(userId: number, botUsername: string): Promise<{ code: string; url: string }> {
      const code = await rs.ensureCode(userId)
      return { code, url: `https://t.me/${botUsername}?start=ref_${code}` }
    },

    /** `/start ref_<code>`: attributes a new user to the code's owner, once, for good. */
    async attribute(userId: number, code: string): Promise<{ result: AttributionResult; referrerUserId: number | null }> {
      const referrer = isReferralCode(code) ? await rs.referrerOfCode(code) : null
      if (referrer === null) return { result: 'unknown-code', referrerUserId: null }
      if (referrer === userId) return { result: 'self', referrerUserId: referrer }
      if (await rs.attribution(userId)) return { result: 'already', referrerUserId: referrer }
      // No loops: someone this user referred can't become their referrer.
      if ((await rs.attribution(referrer))?.referrerUserId === userId) return { result: 'loop', referrerUserId: referrer }
      if (!(await isNew(userId))) return { result: 'not-new', referrerUserId: referrer }
      const done = await rs.attribute({ referredUserId: userId, referrerUserId: referrer, code })
      if (done) log.info('referral attributed', { referrer, referred: userId })
      return { result: done ? 'attributed' : 'already', referrerUserId: referrer }
    },

    /**
     * A settled, fee-bearing trade of `userId`. `trader`: the account that traded (the
     * NearKit wallet's owner, or the linked wallet that signed). True when it earned.
     */
    async recordTrade(t: { source: 'intent' | 'handoff'; sourceId: string; userId: number; fee: TradeFee | null; txHash: string | null; trader: string | null }): Promise<boolean> {
      if (!t.fee || !deps.feeRecipient || t.fee.recipient !== deps.feeRecipient || !/^\d+$/.test(t.fee.raw)) return false
      const received = BigInt(t.fee.raw)
      if (received === 0n) return false
      const a = await rs.attribution(t.userId)
      if (!a) return false
      // The referrer trading through the referred account: their own wallet earns them nothing.
      if (t.trader && (await deps.store.linksOf(a.referrerUserId, network)).some((l) => l.accountId === t.trader)) {
        log.warn('referral skipped: the referrer’s own wallet traded', { referrer: a.referrerUserId, source: t.source, id: t.sourceId })
        return false
      }
      const split = referralSplit(received, routerShareBps)
      const recorded = await rs.recordEarning({
        source: t.source,
        sourceId: t.sourceId,
        referrerUserId: a.referrerUserId,
        referredUserId: t.userId,
        network,
        token: t.fee.token,
        received,
        referral: split.referral,
        net: split.net,
        volume: split.volume,
        txHash: t.txHash,
      })
      if (recorded) log.info('referral earning', { referrer: a.referrerUserId, token: t.fee.token, referral: split.referral.toString() })
      return recorded
    },

    /** A NearKit wallet trade that just became done (the engine's done hook). */
    async recordIntent(intent: Intent, wallet: TradingWallet | null): Promise<boolean> {
      if (intent.kind !== 'buy' && intent.kind !== 'sell') return false
      const facts = intent.result?.facts as { fee?: TradeFee | null } | undefined
      return this.recordTrade({
        source: 'intent',
        sourceId: intent.id,
        userId: intent.userId,
        fee: facts?.fee ?? null,
        txHash: intent.result?.hashes.at(-1) ?? null,
        trader: wallet?.ownerAccount ?? null,
      })
    },

    async summary(userId: number, botUsername: string): Promise<ReferralSummary & { url: string }> {
      const { code, url } = await this.link(userId, botUsername)
      const [earnings, claims, referred] = await Promise.all([rs.earningsOf(userId, network), rs.claimsOf(userId, network), rs.referredCount(userId)])
      const byToken = new Map<string, TokenTotals>()
      const of = (token: string) => {
        let t = byToken.get(token)
        if (!t) byToken.set(token, (t = { token, volume: 0n, earned: 0n, claimed: 0n, pending: 0n, available: 0n }))
        return t
      }
      for (const e of earnings) {
        const t = of(e.token)
        t.volume += e.volume
        if (e.forfeitedAt === null) t.earned += e.referral
        if (e.claimId === null && e.forfeitedAt === null) t.available += e.referral
      }
      for (const c of claims) {
        if (c.status === 'paid') of(c.token).claimed += c.amount
        if (c.status === 'requested') of(c.token).pending += c.amount
      }
      return { code, url, referred, tokens: [...byToken.values()], claims }
    },

    /** Claims everything available in `token`, to be paid to `destination` (the user's linked wallet) after the owner's review. */
    requestClaim: (userId: number, token: string, destination: string) => rs.createClaim({ referrerUserId: userId, network, token, destination }),
  }
}

export type Referrals = ReturnType<typeof createReferrals>
