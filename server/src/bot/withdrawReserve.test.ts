import { describe, expect, it } from 'vitest'
import { gasPurchaseYocto } from '@/services/near/gas'
import type { NearTransaction, TxAction } from '@/services/near/transaction'
import { gasHeld } from '@/services/real/testing/fakeRuntime'
import type { TradingWallet } from '../custody/store'
import { readWallet } from '../custody/wallets'
import { maxNearWithdraw, nearWithdrawUpfront, tokenWithdrawActions, tokenWithdrawUpfront } from '../custody/withdraw'
import { ownerKeypair } from '../signer/testing'
import { ALICE } from './testing'
import { ONE, REG, USDT, walletBot } from './walletTesting'

/**
 * A withdrawal keeps back what the chain itself holds for its transaction when it accepts it
 * (NEP-642: the gas is bought upfront), and a transfer to a 64-character address also pays for
 * creating that account. `gasHeld` is the fake chain's own count, written from nearcore rather than
 * from NearKit's estimate: a reserve below it means the chain refuses the transaction
 * (NotEnoughBalance) and the withdrawal fails.
 */

const IMPLICIT = 'ab'.repeat(32)
const BOB = 'bob.testnet'
/** The fixed reserve NEAR withdrawals kept before: 1.3 TGas at the purchase floor, 0.0013 NEAR. */
const OLD_RESERVE = 13n * 10n ** 20n

const chainTx = (receiverId: string, actions: TxAction[]): NearTransaction => ({
  signerId: 'cd'.repeat(32),
  publicKey: 'ed25519:11111111111111111111111111111111',
  nonce: 1n,
  receiverId,
  blockHash: new Uint8Array(32),
  actions,
})
const transfer = (to: string) => chainTx(to, [{ type: 'Transfer', deposit: ONE }])

describe('the reserve a withdrawal keeps back is the chain’s own hold for its transaction', () => {
  it('a NEAR withdrawal: about 0.0084 NEAR to a 64-character address, under 0.001 to a named one, never less than the chain holds', () => {
    const toImplicit = gasHeld(transfer(IMPLICIT))
    const toNamed = gasHeld(transfer(BOB))
    // The fixed 0.0013 NEAR kept before was below what the chain holds for a 64-character address.
    expect(OLD_RESERVE < toImplicit).toBe(true)
    expect(nearWithdrawUpfront(IMPLICIT)).toBeGreaterThanOrEqual(toImplicit)
    expect(nearWithdrawUpfront(BOB)).toBeGreaterThanOrEqual(toNamed)
    // Counted by the project's gas model, on the planned transfer itself.
    expect(nearWithdrawUpfront(IMPLICIT)).toBe(gasPurchaseYocto({ receiverId: IMPLICIT, actions: [{ kind: 'transfer', deposit: '1' }] }))
    expect(nearWithdrawUpfront(IMPLICIT)).toBeGreaterThan(8n * 10n ** 21n)
    expect(nearWithdrawUpfront(BOB)).toBeLessThan(10n ** 21n)
    // Before the destination is known (Telegram asks for the amount first), the dearer case.
    expect(nearWithdrawUpfront()).toBe(nearWithdrawUpfront(IMPLICIT))
  })

  it('MAX keeps exactly that reserve back, so what it leaves covers the chain’s hold', () => {
    const available = 2n * ONE
    expect(maxNearWithdraw(available)).toBe(available - nearWithdrawUpfront())
    expect(available - maxNearWithdraw(available, IMPLICIT)).toBeGreaterThanOrEqual(gasHeld(transfer(IMPLICIT)))
    expect(available - maxNearWithdraw(available, BOB)).toBeGreaterThanOrEqual(gasHeld(transfer(BOB)))
    expect(maxNearWithdraw(nearWithdrawUpfront() - 1n)).toBe(0n)
  })

  it('a token withdrawal that registers the destination: both calls of its transaction, their bytes and the 1 yocto', () => {
    const amount = 1_500_000n
    const actions = tokenWithdrawActions(BOB, amount, REG)
    expect(actions.map((a) => (a.kind === 'call' ? a.method : a.kind))).toEqual(['storage_deposit', 'ft_transfer'])
    const reserve = tokenWithdrawUpfront(USDT, BOB, amount, REG)
    expect(reserve).toBe(gasPurchaseYocto({ receiverId: USDT, actions }) + 1n)
    const onChain = chainTx(
      USDT,
      actions.flatMap((a) =>
        a.kind === 'call'
          ? [{ type: 'FunctionCall' as const, methodName: a.method, args: new TextEncoder().encode(JSON.stringify(a.args)), gas: BigInt(a.gas), deposit: BigInt(a.deposit) }]
          : [],
      ),
    )
    expect(onChain.actions).toHaveLength(2)
    expect(reserve).toBeGreaterThanOrEqual(gasHeld(onChain) + 1n)
  })
})

/** A NearKit wallet whose owner approves destinations, and a withdrawal run the way Confirm runs it. */
async function owned(near = 2n * ONE, usdt = 0n) {
  const owner = await ownerKeypair()
  const h = await walletBot({ linkedKey: owner.publicKey })
  const w = (await h.funded(near, usdt)) as TradingWallet
  const withdraw = async (input: { asset?: string; symbol?: string; decimals?: number; amount: bigint; to: string }, quote: { registration: string | null; fresh: boolean }) => {
    const i = await h.custody.store.createIntent({
      walletId: w.id,
      userId: ALICE.id,
      chatId: ALICE.id,
      kind: 'withdraw',
      params: { asset: input.asset ?? 'near', symbol: input.symbol ?? 'NEAR', decimals: input.decimals ?? 24, amount: input.amount.toString(), to: input.to, linked: false },
      quote: { feeNear: '1', ...quote },
      ttlMs: 60_000,
    })
    return h.custody.engine.execute(i.id, ALICE.id)
  }
  const available = async () => {
    const near = (await readWallet(h.deps.near, w)).near
    if (near === null) throw new Error('unread')
    return near
  }
  return { h, w, owner, withdraw, available }
}

describe('withdrawals on chain with the reserve', () => {
  it('MAX to a 64-character address goes through on chain; the old MAX left less than the chain holds and is now refused before anything is signed', async () => {
    const { h, w, owner, withdraw, available } = await owned()
    await h.approve(w.accountId, IMPLICIT, owner)
    const have = await available()
    const sent = h.chain.sent.length
    // What the old reserve offered as MAX would leave 0.0013 NEAR, below the chain's hold for this transfer.
    const oldMax = have - OLD_RESERVE
    expect(have - oldMax < gasHeld(transfer(IMPLICIT))).toBe(true)
    expect(await withdraw({ amount: oldMax, to: IMPLICIT }, { registration: null, fresh: true })).toMatchObject({ kind: 'finished', intent: { status: 'failed' } })
    expect(h.chain.sent.length).toBe(sent)
    // MAX now: the chain accepts it and the new account receives exactly that.
    const max = maxNearWithdraw(have)
    expect(await withdraw({ amount: max, to: IMPLICIT }, { registration: null, fresh: true })).toMatchObject({ kind: 'finished', intent: { status: 'done' } })
    expect(h.chain.accounts.get(IMPLICIT)?.amount).toBe(max)
  })

  it('a normal NEAR withdrawal to a named account goes through, and its MAX keeps back only that transfer’s hold', async () => {
    const { h, w, owner, withdraw, available } = await owned()
    await h.approve(w.accountId, BOB, owner)
    const bob = () => h.chain.accounts.get(BOB)?.amount ?? 0n
    let before = bob()
    expect(await withdraw({ amount: ONE / 2n, to: BOB }, { registration: null, fresh: false })).toMatchObject({ kind: 'finished', intent: { status: 'done' } })
    expect(bob() - before).toBe(ONE / 2n)
    const have = await available()
    const max = maxNearWithdraw(have, BOB)
    expect(have - max).toBe(nearWithdrawUpfront(BOB))
    before = bob()
    expect(await withdraw({ amount: max, to: BOB }, { registration: null, fresh: false })).toMatchObject({ kind: 'finished', intent: { status: 'done' } })
    expect(bob() - before).toBe(max)
  })

  it('a token withdrawal that registers the destination goes through with exactly the NEAR its transaction needs; 1 yocto less is refused before anything is signed', async () => {
    const { h, w, owner, withdraw, available } = await owned(ONE, 5_000_000n)
    await h.approve(w.accountId, BOB, owner)
    const amount = 1_500_000n
    const need = REG + tokenWithdrawUpfront(USDT, BOB, amount, REG)
    const setAvailable = async (target: bigint) => {
      const a = h.chain.accounts.get(w.accountId)
      if (!a) throw new Error('no wallet account')
      a.amount += target - (await available())
    }
    const input = { asset: USDT, symbol: 'USDT', decimals: 6, amount, to: BOB }
    await setAvailable(need - 1n)
    const sent = h.chain.sent.length
    expect(await withdraw(input, { registration: REG.toString(), fresh: false })).toMatchObject({ kind: 'finished', intent: { status: 'failed' } })
    expect(h.chain.sent.length).toBe(sent)
    await setAvailable(need)
    expect(await withdraw(input, { registration: REG.toString(), fresh: false })).toMatchObject({ kind: 'finished', intent: { status: 'done' } })
    const usdt = h.chain.tokens.get(USDT)
    expect(usdt?.registered.has(BOB)).toBe(true)
    expect(usdt?.balances.get(BOB)).toBe(amount)
  })
})
