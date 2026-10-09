import { describe, expect, it } from 'vitest'
import { ONE, USDT, walletBot } from './walletTesting'

/**
 * /token's Buy and Sell keys. From a NEARKITS wallet they open the buy or sell flow on that very
 * wallet (the key carries the wallet it was made for, as every other trade key does), never the
 * Wallet screen; for someone trading from a linked wallet they open the linked wallet's flow, as before.
 */

describe('/token’s Buy and Sell', () => {
  it('from a NEARKITS wallet: Buy and Sell open the flow on that wallet, at its amount step', async () => {
    const h = await walletBot()
    const w = await h.funded(3n * ONE, 50_000_000n)
    await h.say(`/token ${USDT}`)
    const buy = h.button('🟢 Buy')
    const sell = h.button('🔴 Sell')
    expect(buy).toMatch(/^tr:start:/)
    await h.press(buy)
    const buying = h.last()?.text ?? ''
    expect(buying).toContain('🟢 <b>Buy USDT</b>')
    expect(buying).not.toContain(`<code>${w.accountId}</code>`)
    await h.say(`/token ${USDT}`)
    await h.press(h.button('🔴 Sell'))
    expect(h.last()?.text ?? '').toContain('🔴 <b>Sell USDT</b>')
    expect(sell).toMatch(/^tr:start:/)
  })

  it('from a linked wallet only (no NEARKITS wallet): Buy opens the linked wallet’s flow, as before', async () => {
    const h = await walletBot()
    await h.say(`/token ${USDT}`)
    await h.press(h.button('🟢 Buy'))
    expect(h.last()?.text ?? '').toContain('🟢 <b>Buy USDT</b>')
  })
})
