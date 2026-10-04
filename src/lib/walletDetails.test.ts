import { describe, expect, it } from 'vitest'
import { providerAccounts } from './walletDetails'

describe('what a wallet returned, kept for the user to see', () => {
  it('keeps each account’s id, key and plain fields; never a field that looks secret, nor anything that isn’t plain', () => {
    expect(
      providerAccounts([
        {
          accountId: 'eb2f3770f5da2d8de058988bcd3fef1a24a4262b0b3823fdb1045e0a8ca95672',
          publicKey: 'ed25519:G27MijJFPXLkWZC8fDnX2AvL1gq8jidmemvK8u9gid6b',
          name: 'bottest.near',
          active: true,
          privateKey: 'ed25519:never-kept',
          secretKey: 'x',
          seedPhrase: 'x',
          accessToken: 'x',
          signature: 'x',
          nested: { accountId: 'x' },
        },
        { account_id: 'bottest.near' },
        'not an object',
      ]),
    ).toEqual([
      {
        accountId: 'eb2f3770f5da2d8de058988bcd3fef1a24a4262b0b3823fdb1045e0a8ca95672',
        publicKey: 'ed25519:G27MijJFPXLkWZC8fDnX2AvL1gq8jidmemvK8u9gid6b',
        extra: ['name=bottest.near', 'active=true'],
      },
      { accountId: null, publicKey: null, extra: ['account_id=bottest.near'] },
      { accountId: null, publicKey: null, extra: [] },
    ])
  })

  it('cuts long values and long lists', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ accountId: `a${i}.near` }))
    expect(providerAccounts(many)).toHaveLength(20)
    expect(providerAccounts([{ note: 'x'.repeat(200) }])[0]?.extra[0]).toHaveLength('note='.length + 80)
  })
})
