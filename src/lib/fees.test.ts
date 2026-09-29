import { describe, expect, it } from 'vitest'
import { NETWORKS } from '@/config/networks'
import { feeLedger, NEARKIT_FEE, NEARKIT_FEE_BPS, NEARKIT_FEE_LABEL, NEARKIT_FEE_RECEIVED_LABEL, nearkitFeeRaw, referralSplit, RHEA_APP_FEE_SHARE_LABEL } from './fees'

const N = 10n ** 24n
const RHEA_SHARE_BPS = NETWORKS.mainnet.rhea.aggregator?.appFeeRouterShareBps ?? 0

describe('the NearKit trading fee (one canonical setting)', () => {
  it('is 0.50% (50 bps); a referrer gets 20% of what NearKit receives', () => {
    expect(NEARKIT_FEE).toEqual({ bps: 50, referralShareBps: 2000 })
    expect(NEARKIT_FEE_BPS).toBe(50)
    expect(NEARKIT_FEE_LABEL).toBe('0.50%')
  })

  it('discloses Rhea’s cut honestly: of the 0.50%, NearKit receives 0.40% and Rhea keeps 0.10%', () => {
    expect(RHEA_SHARE_BPS).toBe(2000)
    expect(NEARKIT_FEE_RECEIVED_LABEL).toBe('0.40%')
    expect(RHEA_APP_FEE_SHARE_LABEL).toBe('0.10%')
  })

  it('takes 0.5 NEAR on a 100 NEAR trade, floored', () => {
    expect(nearkitFeeRaw(100n * N)).toBe(5n * 10n ** 23n)
    expect(nearkitFeeRaw(9_999n)).toBe(49n)
  })
})

describe('fee ledger: gross → router share → received → referral → net', () => {
  it('without referrals NearKit nets everything it receives', () => {
    const fee = nearkitFeeRaw(100n * N)
    expect(feeLedger(fee, RHEA_SHARE_BPS)).toEqual({ gross: 5n * 10n ** 23n, routerShare: 10n ** 23n, received: 4n * 10n ** 23n, referral: 0n, net: 4n * 10n ** 23n })
  })

  it('a future referral share comes out of what NearKit receives, never out of the user’s pocket', () => {
    const l = feeLedger(nearkitFeeRaw(100n * N), RHEA_SHARE_BPS, 2500)
    expect(l.referral).toBe(10n ** 23n)
    expect(l.net).toBe(3n * 10n ** 23n)
    expect(l.gross).toBe(5n * 10n ** 23n)
  })

  it('the locked economics: the trader pays 0.50%, Rhea keeps 0.10%, NearKit 0.40%; with a referrer 0.08% of it goes to them and NearKit keeps 0.32%', () => {
    const volume = 100n * N
    const fee = nearkitFeeRaw(volume)
    const referred = feeLedger(fee, RHEA_SHARE_BPS, NEARKIT_FEE.referralShareBps)
    const pct = (x: bigint) => Number((x * 1_000_000n) / volume) / 10_000
    expect([pct(referred.gross), pct(referred.routerShare), pct(referred.received), pct(referred.referral), pct(referred.net)]).toEqual([0.5, 0.1, 0.4, 0.08, 0.32])
    // A trader without a referrer pays exactly the same: the referral share is NearKit's own.
    expect(feeLedger(fee, RHEA_SHARE_BPS).gross).toBe(referred.gross)
    // From what NearKit's account actually received on chain, the same split and the volume behind it.
    expect(referralSplit(referred.received, RHEA_SHARE_BPS)).toEqual({ referral: referred.referral, net: referred.net, gross: fee, volume })
  })

  it('rounds each share down, and the parts always add up to the fee', () => {
    const l = feeLedger(999n, RHEA_SHARE_BPS, 3333)
    expect(l.routerShare + l.referral + l.net).toBe(l.gross)
    expect(l.routerShare).toBe(199n)
    expect(l.referral).toBe(266n)
  })
})
