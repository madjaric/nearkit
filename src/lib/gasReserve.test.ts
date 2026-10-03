import { describe, expect, it } from 'vitest'
import { gasCostBoundYocto, gasPurchaseYocto } from '@/services/near/gas'
import { peakNeedYocto, txStorageYocto } from '@/services/near/plans'
import { buildSwapTransactions } from '@/services/rhea/swapTransactions'
import { ACTUAL_NETWORK_FEE_LABEL, GAS_RESERVE_LABEL, GAS_RESERVE_NOT_FEE, GAS_RESERVE_NOTE, GAS_RESERVE_TOOLTIP, gasReserveYocto } from './gasReserve'
import { GLOSSARY } from './glossary'

const ONE = 10n ** 24n
const REG = 1_250_000_000_000_000_000_000n
const WALLET = 'f'.repeat(64)

describe('the gas reserve, as NearKit names it', () => {
  it('is a reserve that is refunded, explained as held and refunded, and never a NearKit fee', () => {
    expect(GAS_RESERVE_LABEL).toBe('Gas reserve (refunded)')
    expect(GAS_RESERVE_NOTE).toBe('Temporarily held while the transaction runs. Unused gas is refunded automatically.')
    expect(GAS_RESERVE_NOT_FEE).toBe('This is not an additional NearKit fee.')
    expect(GAS_RESERVE_TOOLTIP).toBe(
      'NEAR temporarily holds the attached gas amount while the transaction runs. Unused gas is automatically refunded to your wallet. This is not an additional NearKit fee.',
    )
    expect(GLOSSARY.gasReserveRefunded).toEqual({ term: GAS_RESERVE_LABEL, text: GAS_RESERVE_TOOLTIP })
  })

  it('the fee line next to it is the actual network fee, and says it is apart from the reserve', () => {
    expect(ACTUAL_NETWORK_FEE_LABEL).toBe('Actual network fee (est.)')
    expect(GLOSSARY.networkFee.text).toMatch(/gas reserve/)
    expect(GLOSSARY.networkFee.text).toMatch(/refunded/)
  })

  it('is exactly what the planner already holds beyond the amount and the registrations: the swap’s gas purchase and the bounded cost of the steps before it', () => {
    // A wallet's first 1 NEAR buy through Rhea: the token's registration, Rhea's entries, then wrap and swap.
    const txs = buildSwapTransactions({
      signerId: WALLET,
      wrap: { contract: 'wrap.near', amount: ONE, registerDeposit: REG },
      registrations: [{ contract: 'usdt.tether-token.near', accountId: WALLET, deposit: REG }],
      aggregatorDeposits: { contract: 'aggregatedex.near', entries: [{ user: WALLET, tokens: ['wrap.near', 'usdt.tether-token.near'], deposit: 10n ** 22n }] },
      swap: { tokenContract: 'wrap.near', receiverId: 'aggregatedex.near', amount: ONE, msg: JSON.stringify({ msg: 'x'.repeat(1100), signature: 'y'.repeat(128) }) },
      label: 'buy',
    })
    expect(txs.map((t) => t.receiverId)).toEqual(['usdt.tether-token.near', 'aggregatedex.near', 'wrap.near'])
    const [reg, agg, swap] = txs as [(typeof txs)[number], (typeof txs)[number], (typeof txs)[number]]
    const need = peakNeedYocto(txs)
    const registration = txs.reduce((s, t) => s + txStorageYocto(t), 0n)
    const reserve = gasReserveYocto(need, ONE, registration)
    expect(reserve).toBe(need - ONE - registration)
    expect(reserve).toBe(gasCostBoundYocto(reg) + gasCostBoundYocto(agg) + gasPurchaseYocto(swap) + 1n)
    // About a third of a NEAR: 320 TGas of attached gas held at 0.001 NEAR per TGas, and the bound of the two steps before.
    expect(reserve > 32n * 10n ** 22n && reserve < 34n * 10n ** 22n).toBe(true)
  })

  it('is the need less the registrations for a sell (no NEAR in), and never negative', () => {
    expect(gasReserveYocto(400n, 0n, 25n)).toBe(375n)
    expect(gasReserveYocto(5n, 3n, 3n)).toBe(0n)
  })
})
