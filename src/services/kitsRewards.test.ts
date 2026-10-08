import { describe, expect, it } from 'vitest'
import { parseKitsRewardsView, type KitsRewardsView } from './kitsRewards'

/** The page reads holder rewards only as NEARKITS' server vouches for them, and checks they hold together. */

const VIEW: KitsRewardsView = {
  network: 'mainnet',
  token: 'kits.nearlytrade.near',
  launchpad: 'nearlytrade.near',
  launchId: '2699',
  asset: 'near',
  decimals: 24,
  holdersBps: 5000,
  paid: '232526623184551179508975',
  waiting: '90769292844558304509419',
  allocated: '323295916029109484018394',
  payouts: [
    { tx: 'CUsuBcPL6iMGJK313cnZfwmMJA48UACXTZAvauu4mWFV', at: 1791471949026, amount: '214275357901757820022881', payments: 8 },
    { tx: '7eW3uDUYo3sZeFnqspYD6RvM6wXTNG8NbjHJUwZ24xXM', at: 1791437662764, amount: '18251265282793359486094', payments: 2 },
  ],
  payoutCount: 2,
  paymentCount: 10,
  historyComplete: true,
  readAt: 1791500000000,
  historyReadAt: 1791500000000,
}

describe('holder rewards as the page takes them', () => {
  it('a reading that holds together is taken as it is', () => {
    expect(parseKitsRewardsView(JSON.parse(JSON.stringify(VIEW)))).toEqual(VIEW)
  })

  it('refuses another token, network or launchpad, and anything not paid in NEAR', () => {
    for (const bad of [{ token: 'evil.near' }, { network: 'testnet' }, { launchpad: 'mallory.near' }, { asset: 'kits' }, { decimals: 18 }])
      expect(() => parseKitsRewardsView({ ...VIEW, ...bad })).toThrow(/refused/)
  })

  it('refuses figures that don’t hold together: allocated other than paid plus waiting, more listed than paid, a complete history that isn’t what was paid', () => {
    expect(() => parseKitsRewardsView({ ...VIEW, allocated: '1' })).toThrow(/allocated/)
    expect(() => parseKitsRewardsView({ ...VIEW, historyComplete: false, paid: '1', allocated: (1n + BigInt(VIEW.waiting)).toString() })).toThrow(/more listed than paid/)
    const shortPaid = (BigInt(VIEW.paid) + 1n).toString()
    expect(() => parseKitsRewardsView({ ...VIEW, paid: shortPaid, allocated: (BigInt(shortPaid) + BigInt(VIEW.waiting)).toString() })).toThrow(/complete history/)
    expect(() => parseKitsRewardsView({ ...VIEW, payouts: [{ ...VIEW.payouts[0], payments: 0 }], payoutCount: 1 })).toThrow(/no payment/)
    expect(() => parseKitsRewardsView({ ...VIEW, payouts: [{ ...VIEW.payouts[0], tx: '0xabc' }] })).toThrow(/hash/)
  })
})
