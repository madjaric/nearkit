import { beforeAll, describe, expect, it } from 'vitest'
import { TOKEN_IDS } from '@/mocks/tokens'
import type { OperationProgress } from '@/types/operations'
import { createMockServices, setMockLatencyScale, setSimulationLatency } from './index'

beforeAll(() => {
  setMockLatencyScale(0)
  setSimulationLatency(0)
})

const { near, blackdragon, kit, shitzu } = TOKEN_IDS

describe('demo trading', () => {
  it('charges 2.00% on the NEAR leg of a buy', async () => {
    const s = createMockServices()
    const quote = await s.trading.quote({ tokenIn: near, tokenOut: blackdragon, amountIn: '10', slippagePct: 1, walletId: 'w01' })
    expect(quote.nearkitFee.amountNear).toBeCloseTo(0.2, 10)
    expect(quote.minAmountOut).toBeCloseTo(quote.amountOut * 0.99, 6)
    expect(quote.path).toEqual(['NEAR', 'BLACKDRAGON'])
    expect(quote.router).toBe('demo')
  })

  it('charges the fee on proceeds for a sell and hops through NEAR for token pairs', async () => {
    const s = createMockServices()
    const sell = await s.trading.quote({ tokenIn: shitzu, tokenOut: near, amountIn: '1000', slippagePct: 1, walletId: 'w01' })
    const feeNear = sell.nearkitFee.amountNear ?? Number.NaN
    expect(feeNear / (sell.amountOut + feeNear)).toBeCloseTo(0.02, 10)
    const pair = await s.trading.quote({ tokenIn: kit, tokenOut: shitzu, amountIn: '1000', slippagePct: 1, walletId: 'w01' })
    expect(pair.path).toEqual(['KIT', 'NEAR', 'SHITZU'])
  })

  it('refuses swaps above the wallet balance and malformed amounts', async () => {
    const s = createMockServices()
    await expect(s.trading.prepareSwap({ tokenIn: near, tokenOut: kit, amountIn: '1000000', slippagePct: 1, walletId: 'w01' })).rejects.toThrow(/holds/)
    await expect(s.trading.prepareSwap({ tokenIn: near, tokenOut: kit, amountIn: '1e3', slippagePct: 1, walletId: 'w01' })).rejects.toThrow()
  })

  it('plans multi-buy legs only for wallets that can cover them, one approval each', async () => {
    const s = createMockServices()
    const request = {
      side: 'buy' as const,
      tokenId: blackdragon,
      slippagePct: 1,
      legs: [
        { walletId: 'w01', amountIn: '2' },
        { walletId: 'w12', amountIn: '20' },
      ],
    }
    const quote = await s.trading.quoteMulti(request)
    expect(quote.legs[1]?.shortfall).toBeGreaterThan(0)
    expect(quote.totalIn).toBe(2)
    const plan = await s.trading.prepareMulti(request)
    expect(plan.mode).toBe('demo')
    expect(plan.lines.map((l) => l.amount.display)).toEqual(['2'])
    expect(plan.groups).toEqual([[0]])
  })

  it('simulates a swap without changing balances or producing hashes', async () => {
    const s = createMockServices()
    const before = await s.wallets.listHoldings()
    const plan = await s.trading.prepareSwap({ tokenIn: near, tokenOut: kit, amountIn: '5', slippagePct: 1, walletId: 'w01' })
    expect(plan.swap?.amountIn.display).toBe('5')
    expect(plan.fee?.charged).toBe(false)
    const updates: OperationProgress[] = []
    const result = await s.execution.run(plan, null, (p) => updates.push(p))
    expect(result.phase).toBe('success')
    expect(result.simulated).toBe(true)
    expect(result.txs.every((t) => t.hash === null)).toBe(true)
    expect(updates.length).toBeGreaterThan(2)
    expect(await s.wallets.listHoldings()).toEqual(before)
  })
})

describe('demo transfers', () => {
  it('plans exact split amounts from decimal strings', async () => {
    const s = createMockServices()
    const plan = await s.transfers.prepare({
      kind: 'split',
      sourceWalletId: 'w01',
      tokenId: kit,
      lines: [
        { accountId: 'alice.near', amount: '600000' },
        { accountId: 'bob.near', amount: '400000.000000000000000001' },
      ],
    })
    expect(plan.lines.map((l) => l.amount.display)).toEqual(['600000', '400000.000000000000000001'])
    expect(plan.totals.amount.display).toBe('1000000.000000000000000001')
    expect(plan.transactions).toHaveLength(1)
  })

  it('validates recipients, balance and precision', async () => {
    const s = createMockServices()
    await expect(s.transfers.prepare({ kind: 'split', sourceWalletId: 'w01', tokenId: kit, lines: [{ accountId: 'alice.near', amount: '5000000' }] })).rejects.toThrow(/holds/)
    await expect(s.transfers.prepare({ kind: 'split', sourceWalletId: 'w01', tokenId: kit, lines: [{ accountId: 'Bad..near', amount: '10' }] })).rejects.toThrow(/lowercase/)
    await expect(
      s.transfers.prepare({ kind: 'batch-send', sourceWalletId: 'w01', tokenId: TOKEN_IDS.usdc, lines: [{ accountId: 'alice.near', amount: '0.0000001' }] }),
    ).rejects.toThrow(/decimals/)
    await expect(s.transfers.prepare({ kind: 'batch-send', sourceWalletId: 'w01', tokenId: near, lines: [{ accountId: 'demo-trader.near', amount: '1' }] })).rejects.toThrow(
      /source/,
    )
  })

  it('plans a consolidation as one signer per source', async () => {
    const s = createMockServices()
    const plan = await s.transfers.prepare({
      kind: 'consolidate',
      tokenId: kit,
      destinationAccountId: 'demo-trader.near',
      sources: [
        { walletId: 'w02', amount: '100' },
        { walletId: 'w03', amount: '200' },
      ],
    })
    expect(plan.signers).toHaveLength(2)
    expect(plan.groups).toHaveLength(2)
    expect(plan.totals.amount.display).toBe('300')
  })

  it('refuses to simulate a real plan', async () => {
    const s = createMockServices()
    const plan = await s.transfers.prepare({ kind: 'batch-send', sourceWalletId: 'w01', tokenId: near, lines: [{ accountId: 'alice.near', amount: '1' }] })
    await expect(s.execution.run({ ...plan, mode: 'near' }, null, () => undefined)).rejects.toThrow()
  })
})

describe('demo wallets', () => {
  it('manages presets with unique names', async () => {
    const s = createMockServices()
    const created = await s.wallets.createPreset({ name: 'scalp', walletIds: ['w02', 'w03'] })
    expect(created.name).toBe('SCALP')
    await expect(s.wallets.createPreset({ name: 'Scalp', walletIds: ['w02'] })).rejects.toThrow(/already exists/)
    const copy = await s.wallets.duplicatePreset(created.id)
    expect(copy.name).toBe('SCALP COPY')
    await s.wallets.deletePreset(created.id)
    expect((await s.wallets.listPresets()).some((p) => p.id === created.id)).toBe(false)
  })

  it('adds and removes watch-only accounts', async () => {
    const s = createMockServices()
    const w = await s.wallets.addAccount({ accountId: 'watch.near' })
    expect(w.access).toBe('watch')
    await expect(s.wallets.addAccount({ accountId: 'watch.near' })).rejects.toThrow(/already/)
    await s.wallets.removeAccount(w.id)
    expect((await s.wallets.listWallets()).some((x) => x.id === w.id)).toBe(false)
  })
})

describe('demo portfolio', () => {
  it('reports four positions with PnL against cost basis', async () => {
    const s = createMockServices()
    const positions = await s.portfolio.listPositions()
    expect(positions.map((p) => p.token.symbol).sort()).toEqual(['BLACKDRAGON', 'KIT', 'NEAR', 'SHITZU'])
    const summary = await s.portfolio.getSummary()
    expect(summary.activePositions).toBe(4)
    expect(summary.openOrders).toBe(3)
  })

  it('returns an empty portfolio once disconnected', async () => {
    const s = createMockServices()
    await s.wallets.disconnect()
    expect(await s.portfolio.listPositions()).toEqual([])
    expect((await s.portfolio.getSummary()).valueUsd).toBe(0)
  })

  it('keeps PnL history deterministic', async () => {
    const a = await createMockServices().portfolio.getPnl('90d')
    const b = await createMockServices().portfolio.getPnl('90d')
    expect(a?.realizedUsd).toBe(b?.realizedUsd)
    expect(a?.points).toHaveLength(90)
    expect(a?.feesUsd).toBeCloseTo((a?.volumeUsd ?? 0) * 0.02, 6)
  })
})
