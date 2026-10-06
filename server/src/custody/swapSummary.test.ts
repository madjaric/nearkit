import { describe, expect, it } from 'vitest'
import { NETWORKS } from '@/config/networks'
import singBuy from '@/services/near/fixtures/flows/direct-buy-wrap-dcl.rpc.json'
import bdBuy from '@/services/near/fixtures/flows/legacy-log-buy-blackdragon.rpc.json'
import bdSell from '@/services/near/fixtures/flows/legacy-log-sell-blackdragon.rpc.json'
import type { RpcTxResult } from '@/services/near/rpc'
import type { ServerNear } from '../near'
import type { WalletTxPlan } from './policy'
import type { Intent, TradingWallet } from './store'
import { createSwapService, type SwapParams } from './swap'

/**
 * How a NearKit wallet's swap is judged from the chain's final record, on real mainnet swaps.
 * BLACKDRAGON's contract predates NEP-141 events: it logs each transfer as a text line, and a
 * swap of it that went through is confirmed like any other, never reported as failed.
 */

const BLACKDRAGON = 'blackdragon.tkn.near'
const SING = 'singularty.nearlytrade.near'

// Summarizing reads only the transaction's own record: nothing here reaches a network.
const offline = () => Promise.reject(new Error('offline'))
const near = { ctx: { network: NETWORKS.mainnet, fetch: offline, now: () => 0, rpc: { call: offline } } } as unknown as ServerNear
const { handler } = createSwapService(near)

const planOf = (tx: RpcTxResult): WalletTxPlan => ({
  receiverId: tx.transaction.receiver_id,
  label: 'swap',
  actions: (tx.transaction.actions ?? []).map((a) => {
    const f = (a as { FunctionCall: { method_name: string; args: string; gas: number; deposit: string } }).FunctionCall
    return { kind: 'call' as const, method: f.method_name, args: JSON.parse(atob(f.args)) as Record<string, unknown>, gas: String(f.gas), deposit: f.deposit }
  }),
})

function summarize(record: unknown, params: Omit<SwapParams, 'amountIn' | 'slippagePct'>, accountId: string) {
  const result = record as RpcTxResult
  const intent = { params: { ...params, amountIn: '1', slippagePct: 1 } } as unknown as Intent
  const wallet = { accountId } as unknown as TradingWallet
  return handler.summarize(intent, wallet, [{ plan: planOf(result), hash: result.transaction.hash, result }])
}

describe('a NEARKITS wallet’s swap, judged from its final record', () => {
  it('a buy of a token that logs its transfers as text lines (BLACKDRAGON) is confirmed, with the tokens received and the NEAR paid', async () => {
    const r = await summarize(bdBuy, { side: 'buy', token: BLACKDRAGON, symbol: 'BLACKDRAGON', decimals: 24 }, 'blackdragonmeme.near')
    expect(r).toMatchObject({
      ok: true,
      message: 'Buy confirmed.',
      facts: { token: BLACKDRAGON, tokenAmount: '32826022038988341595633215922069281', nearAmount: '134000000000000000000000000' },
    })
  })

  it('a sell of it is confirmed with the NEAR it brought', async () => {
    const r = await summarize(bdSell, { side: 'sell', token: BLACKDRAGON, symbol: 'BLACKDRAGON', decimals: 24 }, 'blackdragonmeme.near')
    expect(r).toMatchObject({
      ok: true,
      message: 'Sell confirmed.',
      facts: { token: BLACKDRAGON, tokenAmount: '33300000000000000000000000000000000', nearAmount: '133930913650008363905892289' },
    })
  })

  it('a token with NEP-141 events reads as it always has (SINGULARTY)', async () => {
    const r = await summarize(singBuy, { side: 'buy', token: SING, symbol: 'SINGULARTY', decimals: 18 }, 'mort1705.tg')
    expect(r).toMatchObject({ ok: true, message: 'Buy confirmed.', facts: { token: SING, tokenAmount: '69099416000669574619652', nearAmount: (10n ** 24n).toString() } })
  })
})
