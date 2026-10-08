import { describe, expect, it } from 'vitest'
import { kitConfig, KITS_CONTRACT } from '@/config/kit'
import { NETWORKS } from '@/config/networks'
import type { TokenListing } from '@/types/domain'
import { listedKit, openingToken } from './openingToken'

/**
 * The token a trade tool opens on. Quick Trade opens on $KITS, the NEARKITS token, read from its one
 * configuration (config/kit.ts), while it is listed; every other trade tool keeps the network's
 * configured default. The id is the contract the quote and the plan are built for, not a label.
 */

const token = (id: string, status: TokenListing['status'] = 'listed', isNative = false) => ({ id, status, isNative })
const NEAR = token('near', 'listed', true)
const BLACKDRAGON = token('blackdragon.tkn.near')
const USDT = token('usdt.tether-token.near')
const KITS = token(KITS_CONTRACT)
const mainnetKit = kitConfig(NETWORKS.mainnet.kitsContract)
const testnetKit = kitConfig(NETWORKS.testnet.kitsContract)

describe('Quick Trade opens on $KITS', () => {
  it('is the canonical $KITS contract, kits.nearlytrade.near, whatever order the list comes in', () => {
    const list = [NEAR, BLACKDRAGON, USDT, KITS]
    const quick = openingToken(list, [listedKit(list, mainnetKit), NETWORKS.mainnet.defaultTradeToken])
    expect(quick).toBe('kits.nearlytrade.near')
    expect(quick).toBe(NETWORKS.mainnet.kitsContract)
  })

  it('falls back to the network’s default while $KITS isn’t listed, or isn’t live yet', () => {
    for (const list of [
      [NEAR, BLACKDRAGON, USDT],
      [NEAR, BLACKDRAGON, USDT, token(KITS_CONTRACT, 'prelaunch')],
    ])
      expect(openingToken(list, [listedKit(list, mainnetKit), NETWORKS.mainnet.defaultTradeToken])).toBe('blackdragon.tkn.near')
  })

  it('on testnet, where $KITS doesn’t exist, opens on the testnet default', () => {
    const list = [NEAR, token('usdt.itachicara.testnet'), token(KITS_CONTRACT)]
    expect(listedKit(list, testnetKit)).toBeNull()
    expect(openingToken(list, [listedKit(list, testnetKit), NETWORKS.testnet.defaultTradeToken])).toBe('usdt.itachicara.testnet')
  })
})

describe('the other trade tools keep the network’s default', () => {
  it('opens on the configured default when it is in the list, $KITS listed or not', () => {
    expect(openingToken([NEAR, KITS, BLACKDRAGON, USDT], [NETWORKS.mainnet.defaultTradeToken])).toBe('blackdragon.tkn.near')
  })

  it('else on the first listed token that isn’t NEAR, else NEAR', () => {
    expect(openingToken([NEAR, token('a.near', 'prelaunch'), USDT], ['gone.near'])).toBe('usdt.tether-token.near')
    expect(openingToken([NEAR], ['gone.near'])).toBe('near')
    expect(openingToken([], [null])).toBe('near')
  })
})
