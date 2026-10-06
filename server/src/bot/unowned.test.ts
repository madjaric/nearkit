import { describe, expect, it } from 'vitest'
import { RecoveryApiError } from '../custody/recovery'
import type { TradingWallet } from '../custody/store'
import { ChallengeError, DestinationNotApprovedError } from '../signer/errors'
import { ownerKeypair } from '../signer/testing'
import { ALICE } from './testing'
import { LINKED, ONE, USDT, WRAP, walletBot } from './walletTesting'

/**
 * NearKit wallets with no owner wallet: created, funded, traded and withdrawn from without
 * ever linking an external wallet. The Telegram account that created one controls it; a new
 * withdrawal address (and, optionally, a first owner wallet later) is approved in NearKit's
 * Mini App, and the signer checks Telegram's own signature on that approval.
 */

const EVE = { ...ALICE, id: 202, first_name: 'Eve', username: 'eve' }
const BOB = 'bob.testnet'

/** A user who never linked a wallet, with a funded NearKit wallet. */
async function unlinked(near = 3n * ONE) {
  const h = await walletBot({ link: false })
  await h.press('cw:home')
  await h.press(h.button('Create NEARKITS wallet'))
  const w = (await h.wallet()) as TradingWallet
  h.chain.fund(w.accountId, near)
  h.chain.accounts.set(BOB, { amount: ONE })
  return { h, w }
}

/** Withdraw `amount` NEAR to `to` from the wallet screen, up to the review or the approval screen. */
async function startWithdraw(h: Awaited<ReturnType<typeof walletBot>>, to: string, amount = '1') {
  await h.press('cw:wd')
  await h.press(h.button('NEAR ·'))
  await h.say(amount)
  await h.say(to)
}

describe('without ever linking a wallet', () => {
  it('create: one tap makes a NEARKITS wallet this Telegram account controls, with no owner wallet', async () => {
    const h = await walletBot({ link: false })
    await h.press('cw:home')
    const offer = h.last()?.text ?? ''
    expect(offer).toContain('optional')
    expect(offer).not.toContain('Link your own wallet first')
    expect(h.buttons().some((b) => b.text.includes('Create NEARKITS wallet'))).toBe(true)
    await h.press(h.button('Create NEARKITS wallet'))
    expect(h.last()?.text).toContain('NEARKITS wallet created')
    const w = (await h.wallet()) as TradingWallet
    expect(w.ownerAccount).toBeNull()
    expect((await h.signerVault?.key('testnet', w.accountId))?.ownerAccount).toBeNull()
    expect(await h.store.linksOf(ALICE.id, 'testnet')).toEqual([])
  })

  it('deposit: the address to send to, then the balance read from chain', async () => {
    const h = await walletBot({ link: false })
    await h.press('cw:home')
    await h.press(h.button('Create NEARKITS wallet'))
    const w = (await h.wallet()) as TradingWallet
    await h.press('cw:dep')
    expect(h.last()?.text).toContain(w.accountId)
    h.chain.fund(w.accountId, 2n * ONE)
    await h.press('cw:home')
    expect(h.last()?.text).toContain('2.00')
  })

  it('trade: buy and sell from the NEARKITS wallet', async () => {
    const { h, w } = await unlinked()
    await h.say('/buy USDT 0.1')
    await h.press(h.button('Confirm buy'))
    expect(h.last()?.text).toContain('Buy confirmed')
    await h.say('/sell USDT')
    await h.press(h.button('100%'))
    await h.press(h.button('Confirm sell'))
    expect(h.last()?.text).toContain('Sell confirmed')
    expect(h.chain.tokens.get(USDT)?.balances.get(w.accountId)).toBe(0n)
    expect(h.chain.sent.map((s) => s.tx.receiverId)).toEqual([USDT, WRAP, USDT])
  })

  it('withdraw: a new address is approved once in Telegram, then it goes through; the user is never told to link', async () => {
    const { h } = await unlinked()
    await startWithdraw(h, BOB)
    const ask = h.last()?.text ?? ''
    expect(ask).toContain('Approve a new address')
    expect(ask.toLowerCase()).not.toContain('link')
    expect(h.buttons().find((b) => b.text.includes('Approve in Telegram'))?.url).toMatch(/^https:\/\/t\.me\/NearKitBot\?startapp=[A-Za-z0-9_-]{43}$/)
    await h.approveInTelegram()
    expect(h.last()?.text).toContain(`${BOB}</code> can now receive withdrawals`)
    await h.press(h.button('Continue withdrawal'))
    expect(h.last()?.text).toContain('Review withdrawal')
    await h.press(h.button('Confirm withdraw'))
    expect(h.last()?.text).toContain('Withdrawal confirmed')
    expect(h.chain.accounts.get(BOB)?.amount).toBe(2n * ONE)
    // The address is approved now: the next withdrawal goes straight to its review.
    await startWithdraw(h, BOB, '0.5')
    expect(h.last()?.text).toContain('Review withdrawal')
  })

  it('a compromised app can’t withdraw anywhere its Telegram account didn’t approve', async () => {
    const { h, w } = await unlinked()
    const plan = [{ receiverId: 'mallory.testnet', actions: [{ kind: 'transfer' as const, deposit: ONE.toString() }], label: 'x' }]
    await expect(
      h.custody.signer.sign({
        wallet: w,
        intentId: 'forged',
        step: 0,
        op: { kind: 'withdraw-near', to: 'mallory.testnet', amount: ONE },
        plan,
        nonce: 7n,
        blockHash: new Uint8Array(32),
      }),
    ).rejects.toThrow(DestinationNotApprovedError)
    // Nor with an approval opened by another Telegram account.
    await startWithdraw(h, BOB)
    await expect(h.approveInTelegram(EVE)).rejects.toThrow(RecoveryApiError)
    expect((await h.custody.signer.destinations(w.accountId)).destinations).toEqual([])
  })

  it('recovery and export: none of the owner wallet’s powers while there is no owner wallet', async () => {
    const { h, w } = await unlinked()
    await h.press(`cr:show:${w.id}`)
    const text = h.last()?.text ?? ''
    expect(text).toContain('No owner wallet')
    expect(h.buttons().some((b) => /Export|backup key|Remove NEARKITS/i.test(b.text))).toBe(false)
    await expect(h.custody.recovery.exportLink(ALICE.id, w.id)).rejects.toThrow(RecoveryApiError)
  })
})

describe('linking later: the linked wallet becomes the owner, approved in Telegram', () => {
  it('link after creation, then make it the owner: the wallet is owned for good, with export and the backup key', async () => {
    const owner = await ownerKeypair()
    const { h, w } = await unlinked()
    await h.link(LINKED, owner.publicKey)
    await h.press(`cr:show:${w.id}`)
    await h.press(h.button(`Make ${LINKED} the owner`))
    expect(h.last()?.text).toContain(`Make ${LINKED} the owner`)
    await h.approveInTelegram()
    expect(h.last()?.text).toContain(`${LINKED}</code> is now the owner`)
    expect((await h.custody.store.wallet(w.id))?.ownerAccount).toBe(LINKED)
    expect((await h.signerVault?.key('testnet', w.accountId))?.ownerAccount).toBe(LINKED)
    expect(JSON.parse((await h.signerVault?.key('testnet', w.accountId))?.sealedKey as string)).toMatchObject({ v: 2 })
    await h.press(`cr:show:${w.id}`)
    expect(h.buttons().some((b) => b.text.includes('Export key'))).toBe(true)
    expect(h.buttons().some((b) => b.text.includes('Add backup key'))).toBe(true)
    expect((await h.custody.recovery.exportLink(ALICE.id, w.id)).url).toContain(w.accountId)
  })

  it('owner hijacks fail: another Telegram account, a later link, or a second binding', async () => {
    const owner = await ownerKeypair()
    const eve = await ownerKeypair()
    const { h, w } = await unlinked()
    await h.link(LINKED, owner.publicKey)
    await h.press(`cr:show:${w.id}`)
    await h.press(h.button(`Make ${LINKED} the owner`))
    // Eve opens the approval link from her own Telegram account: refused, nothing bound.
    await expect(h.approveInTelegram(EVE)).rejects.toThrow(RecoveryApiError)
    expect((await h.custody.store.wallet(w.id))?.ownerAccount).toBeNull()
    await h.approveInTelegram()
    // Someone in the Telegram account links their own wallet afterwards: the wallet stays bound to its owner.
    await h.link('eve.testnet', eve.publicKey)
    await h.press(`cr:show:${w.id}`)
    expect(h.buttons().some((b) => b.text.includes('the owner'))).toBe(false)
    await expect(h.custody.signer.telegramRequest({ kind: 'bind-owner', accountId: w.accountId, owner: 'eve.testnet', ownerKey: eve.publicKey })).rejects.toThrow(ChallengeError)
    await expect(h.custody.signer.telegramRequest({ kind: 'destination', accountId: w.accountId, destination: BOB })).rejects.toThrow(ChallengeError)
    expect((await h.signerVault?.key('testnet', w.accountId))?.ownerAccount).toBe(LINKED)
  })
})

describe('owned wallets, as before', () => {
  it('a wallet created while a wallet is linked is owned by it; new addresses need the owner’s signature, never Telegram’s', async () => {
    const owner = await ownerKeypair()
    const h = await walletBot({ linkedKey: owner.publicKey })
    const w = (await h.funded(3n * ONE)) as TradingWallet
    expect(w.ownerAccount).toBe(LINKED)
    h.chain.accounts.set(BOB, { amount: ONE })
    await startWithdraw(h, BOB)
    expect(h.last()?.text).toContain('Approve a new destination')
    expect(h.buttons().some((b) => b.text.includes('Approve in NEARKITS web'))).toBe(true)
    expect(h.buttons().some((b) => b.text.includes('Approve in Telegram'))).toBe(false)
    await expect(h.custody.signer.telegramRequest({ kind: 'destination', accountId: w.accountId, destination: BOB })).rejects.toThrow(ChallengeError)
    expect(h.chain.accounts.get(BOB)?.amount).toBe(ONE)
  })
})
