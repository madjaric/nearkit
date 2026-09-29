import { describe, expect, it } from 'vitest'
import aggBuyFast from './fixtures/flows/aggregator-buy-with-rhea.fastnear.json'
import aggBuyRpc from './fixtures/flows/aggregator-buy-with-rhea.rpc.json'
import aggSellRpc from './fixtures/flows/aggregator-sell.rpc.json'
import directBuyFast from './fixtures/flows/direct-buy-wrap-dcl.fastnear.json'
import directBuyRpc from './fixtures/flows/direct-buy-wrap-dcl.rpc.json'
import directSellRpc from './fixtures/flows/direct-sell-dcl.rpc.json'
import taxRpc from './fixtures/flows/launchpad-tax.rpc.json'
import storageRpc from './fixtures/flows/storage-deposit.rpc.json'
import { balanceChanges, detectTrades, flowsOf, fromFastnear, fromRpc, isComplete, parseLegacyFtLog, type NormalizedTx } from './flows'
import type { RpcTxResult } from './rpc'

// Real mainnet transactions (2026-09-29), saved in both the RPC and FastNEAR formats.
const SING = 'singularty.nearlytrade.near'
const RHEA = 'token.rhealab.near'
const opts = { wrapContract: 'wrap.near' }
const rpc = (x: unknown) => fromRpc(x as RpcTxResult)

describe('legacy NEP-141 logs (wrap.near predates events)', () => {
  it('reads deposit, transfer, withdraw and refund lines', () => {
    expect(parseLegacyFtLog('Deposit 1000 NEAR to alice.near')).toEqual({ kind: 'mint', from: null, to: 'alice.near', amount: 1000n })
    expect(parseLegacyFtLog('Transfer 5 from alice.near to dclv2.ref-labs.near')).toEqual({ kind: 'transfer', from: 'alice.near', to: 'dclv2.ref-labs.near', amount: 5n })
    expect(parseLegacyFtLog('Withdraw 7 NEAR from dclv2.ref-labs.near')).toEqual({ kind: 'burn', from: 'dclv2.ref-labs.near', to: null, amount: 7n })
    expect(parseLegacyFtLog('Refund 3 from bob.near to alice.near')).toEqual({ kind: 'transfer', from: 'bob.near', to: 'alice.near', amount: 3n })
    expect(parseLegacyFtLog('Swapped 1 a.near for 2 b.near')).toBeNull()
  })
})

describe('normalizing transactions', () => {
  it('gives the same receipts and flows from the RPC and from FastNEAR', () => {
    for (const [a, b] of [
      [rpc(directBuyRpc), fromFastnear(directBuyFast)],
      [rpc(aggBuyRpc), fromFastnear(aggBuyFast)],
    ] as [NormalizedTx, NormalizedTx][]) {
      expect(b.hash).toBe(a.hash)
      expect(b.signerId).toBe(a.signerId)
      expect(b.gasBurnt).toBe(a.gasBurnt)
      expect(flowsOf(b, opts)).toEqual(flowsOf(a, opts))
    }
    expect(fromFastnear(directBuyFast).blockHeight).toBeGreaterThan(0)
  })
})

describe('completeness', () => {
  it('knows a transaction whose receipts are all in the record from one still executing', () => {
    const tx = fromFastnear(directBuyFast)
    expect(isComplete(tx)).toBe(true)
    // Drop the last receipt (a refund) as an index would before it executed.
    const partial = { ...tx, receipts: tx.receipts.slice(0, -1) }
    expect(isComplete(partial)).toBe(false)
    expect(isComplete({ ...tx, receipts: [] })).toBe(false)
  })
})

describe('trades from real transactions', () => {
  it('a direct buy: wrap 1 NEAR, swap on the DCL pool, receive SINGULARTY after the 1% tax', () => {
    const tx = rpc(directBuyRpc)
    const trades = detectTrades(tx, SING, opts)
    expect(trades).toEqual([
      {
        account: 'mort1705.tg',
        side: 'buy',
        token: SING,
        amount: 69099416000669574619652n,
        // 1 NEAR wrapped. The 1 yoctoNEAR security deposit of ft_transfer_call is not trade value.
        paid: [{ asset: 'near', amount: 1000000000000000000000000n }],
        received: [],
      },
    ])
    // The tax went to the token contract itself: that is not a buyer.
    expect(balanceChanges(flowsOf(tx, opts)).get(SING)?.get(SING)).toBe(697973898996662369895n)
  })

  it('a buy through Rhea’s aggregator paid in RHEA', () => {
    const trades = detectTrades(rpc(aggBuyRpc), SING, opts)
    expect(trades).toHaveLength(1)
    expect(trades[0]).toMatchObject({ account: 'alijay3637.tg', side: 'buy', token: SING, paid: [{ asset: RHEA, amount: 15000000000000000000n }] })
    expect(trades[0]?.amount).toBeGreaterThan(0n)
  })

  it('a failed aggregator sell refunds the tokens: no trade', () => {
    expect(detectTrades(rpc(aggSellRpc), SING, opts)).toEqual([])
  })

  it('a direct sell for native NEAR', () => {
    const trades = detectTrades(rpc(directSellRpc), SING, opts)
    expect(trades).toHaveLength(1)
    expect(trades[0]).toMatchObject({ account: 'iwillwin.user.intear.near', side: 'sell', token: SING })
    expect(trades[0]?.received[0]?.asset).toBe('near')
    expect(trades[0]?.received[0]?.amount).toBeGreaterThan(0n)
  })

  it('launchpad tax processing and a storage registration are not trades', () => {
    // The launchpad pays tax tokens out and gets a storage-deposit refund back: neither is a sale.
    expect(detectTrades(rpc(taxRpc), SING, opts)).toEqual([])
    expect(detectTrades(rpc(storageRpc), SING, opts)).toEqual([])
  })

  it('tags a storage deposit’s refund as storage too, so it never reads as income', () => {
    const flows = flowsOf(rpc(taxRpc), opts)
    const nearIn = flows.filter((f) => f.asset === 'near' && f.to === 'nearlytrade.near')
    expect(nearIn.length).toBeGreaterThan(0)
    expect(nearIn.every((f) => f.kind === 'storage')).toBe(true)
  })

  it('never counts gas refunds from the system as income', () => {
    const flows = flowsOf(rpc(directBuyRpc), opts)
    expect(flows.some((f) => f.from === 'system')).toBe(false)
  })
})
