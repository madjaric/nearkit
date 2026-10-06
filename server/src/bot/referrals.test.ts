import { describe, expect, it } from 'vitest'
import type { TgUser } from '../telegram/types'
import { ALICE } from './testing'
import { LINKED, walletBot } from './walletTesting'

const BOB: TgUser = { id: 202, is_bot: false, first_name: 'Bob', username: 'bob', language_code: 'en' }
const CAROL: TgUser = { id: 303, is_bot: false, first_name: 'Carol', language_code: 'en' }
const USDT = 'usdt.itachicara.testnet'

async function bot() {
  const h = await walletBot()
  const referrals = h.deps.referrals as NonNullable<typeof h.deps.referrals>
  await h.say('/referral')
  const url = h.buttons().find((b) => b.copy)?.copy ?? ''
  return { h, referrals, url, code: url.split('?start=ref_')[1] ?? '' }
}

describe('invites in Telegram', () => {
  it('shows your permanent invite link with a one-tap copy, and what it brought', async () => {
    const { h, url, code } = await bot()
    expect(url).toMatch(/^https:\/\/t\.me\/NearKitBot\?start=ref_[A-HJ-KM-NP-Z2-9]{8}$/)
    expect(h.last()?.text).toContain(`<code>${url}</code>`)
    expect(h.last()?.text).toContain('Invited <b>0</b>')
    expect(h.last()?.text).toContain('0.08% of what they trade')
    expect(h.last()?.text).toContain('earn only on mainnet')
    await h.say('/referral')
    expect(h.buttons().find((b) => b.copy)?.copy).toBe(`https://t.me/NearKitBot?start=ref_${code}`)
  })

  it('a new user who starts with the link is attributed once; the referrer hears that someone joined, not who', async () => {
    const { h, referrals, code } = await bot()
    await h.say(`/start ref_${code}`, BOB)
    expect(h.fake.messages().some((m) => m.chatId === BOB.id && m.text.includes('You joined NEARKITS with an invite'))).toBe(true)
    const toAlice = h.fake.messages().filter((m) => m.chatId === ALICE.id && m.text.includes('Someone new joined NEARKITS'))
    expect(toAlice).toHaveLength(1)
    expect(toAlice[0]?.text).not.toContain('Bob')
    expect((await referrals.store.attribution(BOB.id))?.referrerUserId).toBe(ALICE.id)
    // Again, or with another code: nothing changes, and no second notice.
    await h.say(`/start ref_${code}`, BOB)
    expect(h.fake.messages().filter((m) => m.chatId === ALICE.id && m.text.includes('Someone new joined'))).toHaveLength(1)
    await h.say('/referral')
    expect(h.last()?.text).toContain('Invited <b>1</b>')
  })

  it('your own link, or an old account, is not attributed', async () => {
    const { h, referrals, code } = await bot()
    await h.say(`/start ref_${code}`)
    expect(h.fake.messages().some((m) => m.chatId === ALICE.id && m.text.includes('That’s your own invite link'))).toBe(true)
    expect(await referrals.store.attribution(ALICE.id)).toBeNull()
    await h.say('/start', CAROL)
    h.advance(60 * 60_000)
    await h.say(`/start ref_${code}`, CAROL)
    expect(await referrals.store.attribution(CAROL.id)).toBeNull()
  })

  it('claims: available earnings are requested to the linked wallet, once, and the owner pays them', async () => {
    const { h, referrals, code } = await bot()
    await h.say(`/start ref_${code}`, BOB)
    // Earnings as mainnet trades would bring them (testnet has no fee; the fee account is set for this test).
    const r = await import('../referrals/service')
    const earn = r.createReferrals({
      db: h.db,
      store: h.store,
      custody: h.custody.store,
      network: h.config.network,
      feeRecipient: 'fees.testnet',
      now: h.deps.now,
    })
    expect(
      await earn.recordTrade({
        source: 'intent',
        sourceId: 't1',
        userId: BOB.id,
        fee: { token: USDT, raw: '4000000', recipient: 'fees.testnet' },
        txHash: 'x',
        trader: 'bob.testnet',
      }),
    ).toBe(true)
    await h.say('/referral')
    expect(h.last()?.text).toContain('Available 0.8 USDT')
    expect(h.last()?.text).toContain('Earned 0.8 USDT')
    // A wallet linked moments ago can't receive payouts yet (someone in the Telegram account could have linked it).
    await h.press('ref:claim')
    expect(h.last()?.text).toContain('Payouts go to a wallet linked at least 48 hours ago')
    h.advance(48 * 3_600_000)
    await h.press('ref:claim')
    await h.press(h.button('💸'))
    expect(h.last()?.text).toContain(`To your linked wallet <code>${LINKED}</code>`)
    await h.press(h.button('Request payout'))
    expect(h.last()?.text).toContain('Payout requested')
    const [claim] = await referrals.store.claims('testnet')
    expect(claim).toMatchObject({ referrerUserId: ALICE.id, token: USDT, amount: 800_000n, destination: LINKED, status: 'requested' })
    await h.say('/referral')
    expect(h.last()?.text).toMatch(/Payout requested .*0\.8 USDT/)
    expect(h.buttons().some((b) => b.data === 'ref:claim')).toBe(false)
  })
})
