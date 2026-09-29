import { describe, expect, it } from 'vitest'
import { ALICE } from './testing'
import { LINKED, ONE, REG, USDT, walletBot } from './walletTesting'

describe('NearKit wallet: create, deposit, balance', () => {
  it('asks to link your own wallet first, then offers to create a NearKit wallet', async () => {
    const unlinked = await walletBot({ link: false })
    await unlinked.say('/wallet')
    expect(unlinked.last()?.text).toContain('Link your own wallet first')
    expect(unlinked.buttons().map((b) => b.data)).toContain('acct:link')

    const h = await walletBot()
    await h.say('/wallet')
    expect(h.last()?.text).toContain('not created yet')
    expect(h.last()?.text).toContain(LINKED)
    expect(h.button('Create NearKit wallet')).toBe('cw:create')
  })

  it('creating twice (a double tap) gives one wallet with the same address', async () => {
    const h = await walletBot()
    await Promise.all([h.press('cw:create'), h.press('cw:create')])
    await h.press('cw:create')
    const w = h.wallet()
    expect(w?.accountId).toMatch(/^[0-9a-f]{64}$/)
    expect(h.custody.store.countWalletsSince(ALICE.id, 0)).toBe(1)
    expect(h.last()?.text).toContain(w?.accountId)
    // The key is stored sealed, never in the clear.
    expect(w?.sealedKey).toMatch(/"ct":/)
    expect(h.custody.store.auditOf(w?.id as string).map((a) => a.action)).toEqual(['wallet-created'])
  })

  it('shows the exact deposit address and network, and balances read from chain', async () => {
    const h = await walletBot()
    await h.press('cw:create')
    const w = h.wallet()
    await h.press('cw:dep')
    expect(h.last()?.text).toContain(w?.accountId)
    expect(h.last()?.text).toContain('NEAR Testnet')
    expect(h.last()?.text).toContain('Send testnet NEAR or testnet tokens only')
    await h.press('cw:home')
    expect(h.last()?.text).toContain('Empty: send testnet NEAR here')
    h.chain.fund(w?.accountId as string, 2n * ONE)
    await h.press('cw:home')
    expect(h.last()?.text).toContain('<b>2.00</b> NEAR')
    expect(h.last()?.text).toContain('Backup key: not added yet')
    await h.say('/start')
    expect(h.last()?.text).toContain('NearKit wallet')
  })
})

describe('NearKit wallet: withdraw', () => {
  it('withdraws NEAR to your linked wallet: a clear review, one Confirm, one transaction', async () => {
    const h = await walletBot()
    const w = await h.funded(3n * ONE)
    await h.press('cw:wd')
    await h.press(h.button('NEAR ·'))
    expect(h.last()?.text).toContain('a little stays for the network fee')
    await h.say('1.5')
    await h.press(h.button('(linked)'))
    const review = h.last()?.text ?? ''
    for (const part of [
      'Review withdrawal',
      'Asset <b>NEAR</b>',
      'Amount <b>1.5 NEAR</b>',
      `To <code>${LINKED}</code> · your linked wallet`,
      'Network NEAR Testnet',
      'Network fee ≈',
    ])
      expect(review).toContain(part)
    const confirm = h.button('Confirm withdraw')
    const before = h.chain.accounts.get(LINKED)?.amount ?? 0n
    await h.press(confirm)
    expect(h.last()?.text).toContain('Withdrawal confirmed')
    expect(h.last()?.text).toContain('Sent <b>1.5 NEAR</b>')
    expect(h.last()?.text).toMatch(/Tx <a href="https:\/\/testnet\.nearblocks\.io\/txns\//)
    expect((h.chain.accounts.get(LINKED)?.amount ?? 0n) - before).toBe((3n * ONE) / 2n)
    // Pressing Confirm again, or replaying the update, sends nothing.
    await h.press(confirm)
    await h.press(confirm)
    expect(h.chain.sent).toHaveLength(1)
    expect(h.chain.sent[0]?.tx.signerId).toBe(w.accountId)
  })

  it('withdraws to any valid address you type, and refuses what can’t be right', async () => {
    const h = await walletBot()
    await h.funded(3n * ONE)
    await h.press('cw:wd')
    await h.press(h.button('NEAR ·'))
    await h.say('1')
    for (const [input, why] of [
      ['Bob.Testnet', 'lowercase'],
      ['bob.near', 'is a NEAR mainnet account'],
      [h.wallet()?.accountId as string, 'this NearKit wallet itself'],
      ['nobody-here.testnet', 'There is no account nobody-here.testnet'],
    ] as const) {
      await h.say(input)
      expect(h.last()?.text).toContain(why)
    }
    await h.say('bob.testnet')
    expect(h.last()?.text).toContain('To <code>bob.testnet</code>')
    expect(h.last()?.text).not.toContain('linked wallet')
    await h.press(h.button('Confirm withdraw'))
    expect(h.chain.accounts.get('bob.testnet')?.amount).toBe(2n * ONE)
  })

  it('warns before sending to an address that has never been used', async () => {
    const h = await walletBot()
    await h.funded(3n * ONE)
    await h.press('cw:wd')
    await h.press(h.button('NEAR ·'))
    await h.say('1')
    const fresh = 'c'.repeat(64)
    await h.say(fresh)
    expect(h.last()?.text).toContain('never been used on testnet')
    await h.press(h.button('Confirm withdraw'))
    expect(h.chain.accounts.get(fresh)?.amount).toBe(ONE)
  })

  it('withdraws tokens, registering the destination when it needs it (shown on the review)', async () => {
    const h = await walletBot()
    await h.funded(ONE, 10_000_000n)
    await h.press('cw:wd')
    await h.press(h.button('USDT'))
    await h.press(h.button('MAX'))
    await h.say('bob.testnet')
    expect(h.last()?.text).toContain('Amount <b>10 USDT</b>')
    expect(h.last()?.text).toContain('Registration 0.00125 NEAR · the address has no USDT account yet')
    await h.press(h.button('Confirm withdraw'))
    expect(h.last()?.text).toContain('Withdrawal confirmed')
    expect(h.chain.tokens.get(USDT)?.balances.get('bob.testnet')).toBe(10_000_000n)
    expect(h.chain.tokens.get(USDT)?.registered.has('bob.testnet')).toBe(true)
    expect(REG).toBe(1_250_000_000_000_000_000_000n)
  })

  it('shows a new review instead of sending when something on it changed', async () => {
    const h = await walletBot()
    await h.funded(ONE, 10_000_000n)
    await h.press('cw:wd')
    await h.press(h.button('USDT'))
    await h.press(h.button('50%'))
    await h.press(h.button('(linked)'))
    expect(h.last()?.text).not.toContain('Registration')
    // The linked wallet's USDT account disappears before Confirm.
    h.chain.tokens.get(USDT)?.registered.delete(LINKED)
    await h.press(h.button('Confirm withdraw'))
    expect(h.last()?.text).toContain('Quote changed. Review the new price.')
    expect(h.last()?.text).toContain('Registration 0.00125 NEAR')
    expect(h.chain.sent).toHaveLength(0)
  })

  it('an amount above what is available, an expired review and Cancel send nothing', async () => {
    const h = await walletBot()
    await h.funded(ONE)
    await h.press('cw:wd')
    await h.press(h.button('NEAR ·'))
    await h.say('5')
    expect(h.last()?.text).toContain('at most')
    await h.say('0.5')
    await h.press(h.button('(linked)'))
    const confirm = h.button('Confirm withdraw')
    h.advance(5 * 60_000 + 1)
    await h.press(confirm)
    expect(h.last()?.text).toContain('expired')
    await h.press('cw:wd')
    await h.press(h.button('NEAR ·'))
    await h.say('0.5')
    await h.press(h.button('(linked)'))
    await h.press(h.button('Cancel'))
    expect(h.last()?.text).toContain('Cancelled. Nothing was sent.')
    expect(h.chain.sent).toHaveLength(0)
  })

  it('MAX keeps enough NEAR back for the network fee', async () => {
    const h = await walletBot()
    await h.funded(ONE)
    await h.press('cw:wd')
    await h.press(h.button('NEAR ·'))
    await h.press(h.button('MAX'))
    await h.press(h.button('(linked)'))
    await h.press(h.button('Confirm withdraw'))
    expect(h.last()?.text).toContain('Withdrawal confirmed')
    const left = h.chain.accounts.get(h.wallet()?.accountId as string)?.amount ?? 0n
    expect(left).toBeGreaterThanOrEqual(0n)
    expect(left).toBeLessThan(10n ** 22n)
  })

  it('positions and PnL include the NearKit wallet', async () => {
    const h = await walletBot()
    const w = await h.funded(ONE)
    await h.say('/positions')
    const calls = h.chain.requests.filter((r) => r.url.includes(w.accountId))
    expect(calls.length).toBeGreaterThan(0)
  })
})
