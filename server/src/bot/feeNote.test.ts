import { describe, expect, it } from 'vitest'
import { NETWORKS } from '@/config/networks'
import { feeNote } from './texts'

/** /help's fee note: true for both ways the fee is taken (inside Rhea's swap, or sent with a direct DCL swap). */

describe('the bot’s fee note', () => {
  it('mainnet: Rhea’s 0.40% / 0.10% split on Rhea’s routes, the full 0.50% to NEARKITS on a direct DCL route', () => {
    const note = feeNote({ network: NETWORKS.mainnet })
    expect(note).not.toMatch(/Rhea the rest/)
    expect(note).toMatch(/0\.40%/)
    expect(note).toMatch(/DCL/)
    expect(note).toMatch(/0\.50%/)
  })

  it('testnet: none', () => {
    expect(feeNote({ network: NETWORKS.testnet })).toBe('No NEARKITS fee on testnet.')
  })
})
