import { describe, expect, it } from 'vitest'
import type { TradingWallet } from '../custody/store'
import { shortAccount } from '../telegram/html'
import { ONE, walletBot } from './walletTesting'

/**
 * Wallet addresses in Telegram: shown shortened where space is short, copied in full. A copy
 * key (Telegram's copy_text) carries the wallet record's own account id, never the shortened
 * display, and never another wallet's. Copying is not switching: a copy key has no callback.
 */

type Harness = Awaited<ReturnType<typeof walletBot>>
const HEX64 = /^[0-9a-f]{64}$/

/** Creates a wallet with the New/Create button shown right now (a fresh one-time key each time). */
async function newWallet(h: Harness): Promise<TradingWallet> {
  h.advance(10_000)
  await h.press('cw:list')
  const create = h.button('New wallet') || h.button('Create NEARKITS wallet')
  if (!create) {
    await h.say('/wallet')
    await h.press(h.button('Create NEARKITS wallet'))
  } else {
    await h.press(create)
  }
  return (await h.wallet()) as TradingWallet
}

describe('wallet addresses in Telegram: shown short, copied in full', () => {
  it('My wallets lists each wallet with its shortened address and a copy key carrying that wallet’s full account id, never another’s', async () => {
    const h = await walletBot()
    const first = await h.funded(ONE)
    const second = await newWallet(h)
    const third = await newWallet(h)
    const wallets = [first, second, third]
    for (const w of wallets) expect(w.accountId).toMatch(HEX64)
    expect(new Set(wallets.map((w) => w.accountId)).size).toBe(3)
    await h.press('cw:list')
    const text = h.last()?.text ?? ''
    for (const w of wallets) {
      expect(text).toContain(`${w.slot}. <b>`)
      // Shown shortened as plain text: nothing copies the short form.
      expect(text).toContain(shortAccount(w.accountId))
      expect(text).not.toContain(`<code>${shortAccount(w.accountId)}</code>`)
      expect(text).not.toContain(w.accountId)
    }
    expect(text).not.toMatch(/<code>|<pre>/)
    const copies = h.buttons().filter((b) => b.copy !== undefined)
    expect(copies.map((b) => b.copy)).toEqual(wallets.map((w) => w.accountId))
    for (const b of copies) {
      expect(b.text).toBe('📋 Copy')
      expect(b.copy).toMatch(HEX64)
      expect(b.copy).not.toContain('…')
    }
    // Each copy key sits right after its wallet's switch key.
    const all = h.buttons()
    for (const w of wallets) {
      const at = all.findIndex((b) => b.data === `cw:sel:${w.id}`)
      expect(at).toBeGreaterThanOrEqual(0)
      expect(all[at + 1]).toMatchObject({ copy: w.accountId })
    }
  })

  it('the ✅ marks the active wallet in the text and on its switch key; a copy key has no callback, and switching works as before', async () => {
    const h = await walletBot()
    const first = await h.funded(ONE)
    const second = await newWallet(h)
    await h.press('cw:list')
    expect(h.last()?.text).toMatch(/^✅ 2\. /m)
    expect(h.last()?.text).toMatch(/^▫️ 1\. /m)
    const keys = h.buttons()
    expect(keys.find((b) => b.data === `cw:sel:${second.id}`)?.text.startsWith('✅ ')).toBe(true)
    expect(keys.find((b) => b.data === `cw:sel:${first.id}`)?.text.startsWith('✅ ')).toBe(false)
    // Copy keys carry text to copy and nothing to press: no callback, no link.
    const copies = keys.filter((b) => b.copy !== undefined)
    expect(copies).toHaveLength(2)
    expect(copies.every((b) => b.data === undefined && b.url === undefined)).toBe(true)
    // The switch key switches, as before; the copy keys follow the wallets, unchanged.
    await h.press(`cw:sel:${first.id}`)
    expect((await h.wallet())?.id).toBe(first.id)
    await h.press('cw:list')
    expect(h.last()?.text).toMatch(/^✅ 1\. /m)
    const after = h.buttons()
    expect(after.find((b) => b.data === `cw:sel:${first.id}`)?.text.startsWith('✅ ')).toBe(true)
    expect(after.filter((b) => b.copy !== undefined).map((b) => b.copy)).toEqual([first.accountId, second.accountId])
  })

  it('the created-wallet screen and Deposit show the full address and offer it as a copy key', async () => {
    const h = await walletBot()
    const w = await newWallet(h)
    expect(w.accountId).toMatch(HEX64)
    expect(h.last()?.text).toContain(`<code>${w.accountId}</code>`)
    expect(h.buttons().find((b) => b.text === '📋 Copy address')).toMatchObject({ copy: w.accountId })
    await h.press('cw:dep')
    expect(h.last()?.text).toContain(`<code>${w.accountId}</code>`)
    const copy = h.buttons().find((b) => b.text === '📋 Copy address')
    expect(copy).toMatchObject({ copy: w.accountId })
    expect(copy?.copy).not.toContain('…')
  })
})
