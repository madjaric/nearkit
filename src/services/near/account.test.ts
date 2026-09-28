import { describe, expect, it } from 'vitest'
import { accountState, spendableYocto } from './account'
import { RpcError, type RpcClient, type ViewAccountResult } from './rpc'
import { estimateUpfrontYocto, GAS, TGAS } from './gas'

const NEAR = 10n ** 24n
const PRICE = 10n ** 19n

describe('spendableYocto (protocol rule, nearcore verifier.rs)', () => {
  it('needs no storage stake at or below 770 bytes', () => {
    expect(spendableYocto({ amount: 5n * NEAR, locked: 0n, storageUsage: 182 })).toBe(5n * NEAR)
    expect(spendableYocto({ amount: 5n * NEAR, locked: 0n, storageUsage: 770 })).toBe(5n * NEAR)
  })

  it('stakes the whole usage once above 770 bytes', () => {
    expect(spendableYocto({ amount: 5n * NEAR, locked: 0n, storageUsage: 771 })).toBe(5n * NEAR - 771n * PRICE)
    // wrap.near: 162,397,338 bytes locks about 1,623.97 NEAR
    const wrap = spendableYocto({ amount: 38_124_835n * NEAR, locked: 0n, storageUsage: 162_397_338 })
    expect(wrap).toBe(38_124_835n * NEAR - 162_397_338n * PRICE)
  })

  it('lets staked (locked) balance cover storage first and never goes negative', () => {
    expect(spendableYocto({ amount: NEAR, locked: 100_000n * PRICE, storageUsage: 100_000 })).toBe(NEAR)
    expect(spendableYocto({ amount: 1n, locked: 0n, storageUsage: 10_000 })).toBe(0n)
  })
})

describe('accountState', () => {
  const rpc = (result: ViewAccountResult | Error): RpcClient =>
    ({
      urls: [],
      call: async () => {
        throw new Error('unused')
      },
      viewAccount: async () => {
        if (result instanceof Error) throw result
        return result
      },
      viewFunction: async () => null,
      txStatus: async () => {
        throw new Error('unused')
      },
    }) as RpcClient

  it('reads balances and whether a contract is deployed', async () => {
    const s = await accountState(
      rpc({ amount: (3n * NEAR).toString(), locked: '0', code_hash: '11111111111111111111111111111111', storage_usage: 182, block_height: 9, block_hash: 'h' }),
      'alice.testnet',
    )
    expect(s).toMatchObject({ exists: true, totalYocto: 3n * NEAR, availableYocto: 3n * NEAR, hasContract: false })
    const c = await accountState(rpc({ amount: '0', locked: '0', code_hash: 'DL2f5xmZ', storage_usage: 900, block_height: 9, block_hash: 'h' }), 'token.testnet')
    expect(c.hasContract).toBe(true)
    const g = await accountState(
      rpc({ amount: '0', locked: '0', code_hash: '11111111111111111111111111111111', global_contract_hash: 'X', storage_usage: 200, block_height: 9, block_hash: 'h' }),
      'eth.testnet',
    )
    expect(g.hasContract).toBe(true)
  })

  it('reports a missing account instead of throwing', async () => {
    const s = await accountState(rpc(new RpcError('handler', 'does not exist', 'UNKNOWN_ACCOUNT')), 'ghost.testnet')
    expect(s).toMatchObject({ exists: false, totalYocto: 0n, availableYocto: 0n, hasContract: false })
  })

  it('does not hide transport failures as a missing account', async () => {
    await expect(accountState(rpc(new RpcError('transport', 'down')), 'alice.testnet')).rejects.toBeInstanceOf(RpcError)
  })
})

describe('upfront cost (NEP-642: gas bought at 1e9 yocto/gas, refunded after)', () => {
  it('matches the verified 20 × ft_transfer figure of about 0.216 NEAR', () => {
    const cost = estimateUpfrontYocto({ transactions: 1, actions: 20, attachedGas: 20n * GAS.FT_TRANSFER, deposits: 20n })
    expect(cost).toBeGreaterThanOrEqual(216n * 10n ** 21n) // ≥ 0.216 NEAR
    expect(cost).toBeLessThan(230n * 10n ** 21n) // and not wildly above it
  })

  it('adds deposits exactly and prices attached gas at 0.001 NEAR per TGas', () => {
    const base = estimateUpfrontYocto({ transactions: 1, actions: 1, attachedGas: 0n, deposits: 0n })
    const withGas = estimateUpfrontYocto({ transactions: 1, actions: 1, attachedGas: 10n * TGAS, deposits: 0n })
    expect(withGas - base).toBe(10n * 10n ** 21n) // 10 TGas × 0.001 NEAR
    const withDeposit = estimateUpfrontYocto({ transactions: 1, actions: 1, attachedGas: 0n, deposits: NEAR })
    expect(withDeposit - base).toBe(NEAR)
  })

  it('keeps the recommended gas per action', () => {
    expect(GAS.FT_TRANSFER).toBe(10n * TGAS)
    expect(GAS.STORAGE_DEPOSIT).toBe(10n * TGAS)
    expect(GAS.SWAP_CALL).toBe(300n * TGAS)
  })
})
