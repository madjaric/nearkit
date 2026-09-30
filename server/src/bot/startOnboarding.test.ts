import { describe, expect, it } from 'vitest'
import type { TradingWallet } from '../custody/store'
import { LINKED, ONE, walletBot } from './walletTesting'

/**
 * /start for someone with no NearKit wallet yet: creating one comes first, linking an
 * external NEAR wallet is the optional alternative, and nothing says a link is needed.
 */

describe('/start with no NearKit wallet yet', () => {
  it('leads with Create wallet, then Link wallet; the text never says a link is needed', async () => {
    const h = await walletBot({ link: false })
    await h.say('/start')
    const text = h.last()?.text ?? ''
    expect(text).toContain('👜 <b>No NearKit wallet yet</b>')
    expect(text).toContain('Create a wallet instantly and start trading.')
    expect(text).toContain('🔒 NearKit never asks for your seed phrase or private key.')
    expect(text).not.toContain('No wallet linked yet')
    const [first, second] = h.buttons()
    expect(first?.text).toBe('💼 Create wallet')
    expect(first?.data).toMatch(/^cw:new:[A-Za-z0-9_-]{8,}$/)
    expect(second).toMatchObject({ text: '🔗 Link wallet', data: 'acct:link' })
    // The rest of the menu is as it was.
    expect(h.buttons().map((b) => b.text)).toEqual(expect.arrayContaining(['⚙️ Settings', '❓ Help']))
  })

  it('Create wallet makes the NearKit wallet in one tap, with no link', async () => {
    const h = await walletBot({ link: false })
    await h.say('/start')
    await h.press(h.button('Create wallet'))
    expect(h.last()?.text).toContain('NearKit wallet created')
    const w = (await h.wallet()) as TradingWallet
    expect(w.ownerAccount).toBeNull()
  })

  it('a linked user still sees Create wallet first, with the linked wallet named; no second Link button', async () => {
    const h = await walletBot()
    await h.say('/start')
    const text = h.last()?.text ?? ''
    expect(text).toContain('No NearKit wallet yet')
    expect(text).toContain(`🔗 Linked wallet <code>${LINKED}</code>`)
    expect(h.buttons()[0]?.text).toBe('💼 Create wallet')
    expect(h.buttons().some((b) => b.data === 'acct:link')).toBe(false)
  })

  it('with a NearKit wallet, /start is as before: the wallet, no Create or Link button', async () => {
    const h = await walletBot()
    await h.funded(2n * ONE)
    await h.say('/start')
    expect(h.last()?.text).toContain('<b>NearKit</b> · NEAR trading')
    expect(h.last()?.text).toContain('NearKit wallet')
    expect(h.buttons().some((b) => b.text === '💼 Create wallet' || b.data === 'acct:link')).toBe(false)
  })

  it('where wallets can’t be made without a link (no Telegram approvals on this server), linking comes first as before', async () => {
    const h = await walletBot({ link: false, telegramApprovals: false })
    await h.say('/start')
    expect(h.last()?.text).toContain('No wallet linked yet')
    expect(h.buttons()[0]).toMatchObject({ text: '🔗 Link wallet', data: 'acct:link' })
    expect(h.buttons().some((b) => b.text === '💼 Create wallet')).toBe(false)
  })

  it('/link still works from the onboarding', async () => {
    const h = await walletBot({ link: false })
    await h.say('/start')
    await h.press(h.button('Link wallet'))
    expect(h.last()?.text).toMatch(/link/i)
    expect(h.buttons().some((b) => b.url?.includes('/telegram'))).toBe(true)
  })
})
