import { describe, expect, it } from 'vitest'
import { NEARKIT_FEE_BPS, NEARKIT_FEE_LABEL, NEARKIT_FEE_RECEIVED_LABEL, nearkitFeeRaw, RHEA_APP_FEE_SHARE_LABEL } from './fees'

describe('the NearKit trading fee', () => {
  it('is 0.10% (10 bps) on Swap and Quick Trade, never the old 2.00%', () => {
    expect(NEARKIT_FEE_BPS).toBe(10)
    expect(NEARKIT_FEE_LABEL).toBe('0.10%')
  })

  it('discloses Rhea’s cut honestly: of the 0.10%, NearKit receives 0.08% and Rhea keeps 0.02%', () => {
    expect(NEARKIT_FEE_RECEIVED_LABEL).toBe('0.08%')
    expect(RHEA_APP_FEE_SHARE_LABEL).toBe('0.02%')
  })

  it('takes 0.1 NEAR on a 100 NEAR trade, floored', () => {
    expect(nearkitFeeRaw(100n * 10n ** 24n)).toBe(10n ** 23n)
    expect(nearkitFeeRaw(9_999n)).toBe(9n)
  })
})
