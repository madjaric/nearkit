import { describe, expect, it } from 'vitest'
import { NETWORKS } from '@/config/networks'
import nearToNearly from '@/services/near/fixtures/agg-near-to-nearly-final.json'
import type { RpcTxResult } from '@/services/near/rpc'
import type { WalletTxPlan } from './policy'
import { deliveredTrade, type SwapParams } from './swap'

/**
 * Telegram buys are reported as bought when the tokens arrive, not when the chain's last
 * settlement callbacks run (the 1 NEAR → NEARLY buy of 2026-09-30: tokens at 115 s,
 * settlement at 203 s).
 */

const incident = nearToNearly as unknown as RpcTxResult
const NEARLY = 'nearly-993927.nearlytrade.near'
const WALLET = 'bottest.near'

const plan: WalletTxPlan = {
  receiverId: 'wrap.near',
  label: 'NEAR → NEARLY',
  actions: (incident.transaction.actions ?? []).map((a) => {
    const f = (a as { FunctionCall: { method_name: string; args: string; gas: number; deposit: string } }).FunctionCall
    return { kind: 'call' as const, method: f.method_name, args: JSON.parse(atob(f.args)) as Record<string, unknown>, gas: String(f.gas), deposit: f.deposit }
  }),
}

function upTo(text: string): RpcTxResult {
  const end = incident.receipts_outcome.findIndex((o) => o.outcome.logs.some((l) => l.includes(text)))
  return { ...incident, final_execution_status: 'INCLUDED_FINAL', status: 'Started', receipts_outcome: incident.receipts_outcome.slice(0, end + 1) }
}

const buy: SwapParams = { side: 'buy', token: NEARLY, symbol: 'NEARLY', decimals: 18, amountIn: '1', slippagePct: 1 }
const registration = { plan: { receiverId: NEARLY, actions: [], label: 'Register' }, hash: 'J5iPfKpJGXWfSxzUuskKAJhiUfUEhe97adQXCNnzzXiU', result: incident }

describe('deliveredTrade', () => {
  it('reports a buy as done once the tokens reached the wallet, with what was spent, received and the fee', () => {
    const r = deliveredTrade(buy, WALLET, [registration], { plan, hash: incident.transaction.hash, result: upTo('"withdraw_succeeded"') }, NETWORKS.mainnet)
    expect(r).toMatchObject({
      ok: true,
      message: 'Buy confirmed.',
      hashes: [registration.hash, incident.transaction.hash],
      facts: {
        token: NEARLY,
        tokenAmount: '912437590771706887485',
        nearAmount: '1000000000000000000000000',
        fee: { token: 'wrap.near', raw: '4000000000000000000000', recipient: 'nearkitfee.near' },
        delivered: true,
      },
    })
  })

  it('is not done while the tokens are still on their way', () => {
    expect(deliveredTrade(buy, WALLET, [], { plan, hash: incident.transaction.hash, result: upTo('"withdraw_started"') }, NETWORKS.mainnet)).toBeNull()
  })

  it('leaves sells (NEAR out) and other tokens to the final record', () => {
    const partial = { plan, hash: incident.transaction.hash, result: upTo('"withdraw_succeeded"') }
    expect(deliveredTrade({ ...buy, side: 'sell' }, WALLET, [], partial, NETWORKS.mainnet)).toBeNull()
    expect(deliveredTrade({ ...buy, token: 'usdt.tether-token.near' }, WALLET, [], partial, NETWORKS.mainnet)).toBeNull()
    expect(deliveredTrade(buy, 'someone.near', [], partial, NETWORKS.mainnet)).toBeNull()
  })

  it('needs Rhea’s aggregator (testnet’s classic router reports only when final)', () => {
    expect(deliveredTrade(buy, WALLET, [], { plan, hash: incident.transaction.hash, result: upTo('"withdraw_succeeded"') }, NETWORKS.testnet)).toBeNull()
  })
})
