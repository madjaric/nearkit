import { describe, expect, it } from 'vitest'
import type { PlannedTransaction } from '@/types/operations'
import { classifyOutcome, extractHash, sameActions, swapDelivered } from './outcome'
import type { RpcTxResult } from './rpc'

const b64 = (value: unknown) => btoa(JSON.stringify(value))

const ftTx: PlannedTransaction = {
  index: 0,
  signerId: 'alice.testnet',
  receiverId: 'usdc.testnet',
  actions: [{ kind: 'call', method: 'ft_transfer', args: { receiver_id: 'bob.testnet', amount: '5' }, gas: '10000000000000', deposit: '1' }],
  lineIds: ['l0'],
  label: '1 recipient',
  gas: '10000000000000',
  deposit: '1',
}

const swapTx: PlannedTransaction = {
  ...ftTx,
  receiverId: 'wrap.testnet',
  actions: [
    { kind: 'call', method: 'near_deposit', args: {}, gas: '10000000000000', deposit: '1000' },
    { kind: 'call', method: 'ft_transfer_call', args: { receiver_id: 'ref-finance-101.testnet', amount: '1000', msg: '{}' }, gas: '300000000000000', deposit: '1' },
  ],
}

function result(status: unknown, overrides: Partial<RpcTxResult> = {}): RpcTxResult {
  return {
    final_execution_status: 'FINAL',
    status,
    transaction: { hash: 'H1', signer_id: 'alice.testnet', receiver_id: 'usdc.testnet' },
    transaction_outcome: {
      id: 'H1',
      outcome: { logs: [], receipt_ids: ['r1'], gas_burnt: 1, tokens_burnt: '0', executor_id: 'alice.testnet', status: { SuccessReceiptId: 'r1' } },
    },
    receipts_outcome: [],
    ...overrides,
  }
}

describe('extractHash', () => {
  it('reads the hash from a wallet FinalExecutionOutcome', () => {
    expect(extractHash({ transaction: { hash: 'ABC' } })).toBe('ABC')
    expect(extractHash({ transaction_outcome: { id: 'DEF' } })).toBe('DEF')
    expect(extractHash('GHI')).toBe('GHI')
    expect(extractHash(undefined)).toBeNull()
    expect(extractHash({})).toBeNull()
  })
})

describe('classifyOutcome', () => {
  it('confirms a successful transfer', () => {
    expect(classifyOutcome(result({ SuccessValue: '' }), ftTx)).toMatchObject({ phase: 'success', error: null })
  })

  it('reads a failed transfer with its reason', () => {
    const failure = { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: The account bob.testnet is not registered' } } } }
    const v = classifyOutcome(result({ Failure: failure }), ftTx)
    expect(v.phase).toBe('failed')
    expect(v.error?.code).toBe('STORAGE_REQUIRED')
  })

  it('treats a transaction that does not match the plan as failed', () => {
    const v = classifyOutcome(result({ SuccessValue: '' }, { transaction: { hash: 'H1', signer_id: 'mallory.testnet', receiver_id: 'usdc.testnet' } }), ftTx)
    expect(v.phase).toBe('failed')
    expect(v.error?.message).toMatch(/does not match/)
  })

  it('reads ft_transfer_call used amounts: full, refunded and partial', () => {
    const swapResult = (used: string, receipts: RpcTxResult['receipts_outcome'] = []) =>
      result({ SuccessValue: b64(used) }, { transaction: { hash: 'H1', signer_id: 'alice.testnet', receiver_id: 'wrap.testnet' }, receipts_outcome: receipts })
    expect(classifyOutcome(swapResult('1000'), swapTx)).toMatchObject({ phase: 'success' })

    const refunded = classifyOutcome(
      swapResult('0', [
        {
          id: 'r2',
          outcome: {
            logs: [],
            receipt_ids: [],
            gas_burnt: 1,
            tokens_burnt: '0',
            executor_id: 'ref-finance-101.testnet',
            status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E68: slippage error' } } } } },
          },
        },
      ]),
      swapTx,
    )
    expect(refunded.phase).toBe('failed')
    expect(refunded.error?.code).toBe('SLIPPAGE_EXCEEDED')
    expect(refunded.note).toMatch(/refunded/i)

    const partial = classifyOutcome(swapResult('400'), swapTx)
    expect(partial.phase).toBe('success')
    expect(partial.note).toMatch(/600/)
  })

  it('does not call an unfinished transaction a success', () => {
    expect(classifyOutcome(result('Started'), ftTx).phase).toBe('unknown')
  })
})

// ─── aggregator swaps (real mainnet transactions, trimmed) ──────────────────

import aggExpired from './fixtures/agg-rejected-expired.json'
import aggRefundIntermediate from './fixtures/agg-refund-intermediate.json'
import aggRefundInput from './fixtures/agg-refund-input.json'
import aggSuccess from './fixtures/agg-success-fee-from-input.json'
import aggNativeOut from './fixtures/agg-success-native-near-out.json'

function aggPlan(r: RpcTxResult): PlannedTransaction {
  const action = (r.transaction.actions?.[0] as { FunctionCall: { args: string } }).FunctionCall
  const args = JSON.parse(atob(action.args)) as { receiver_id: string; amount: string; msg: string }
  return {
    index: 0,
    signerId: r.transaction.signer_id,
    receiverId: r.transaction.receiver_id,
    actions: [{ kind: 'call', method: 'ft_transfer_call', args, gas: '300000000000000', deposit: '1' }],
    lineIds: [],
    label: 'Swap',
    gas: '300000000000000',
    deposit: '1',
  }
}

const TOKENS = {
  'wrap.near': { symbol: 'wNEAR', decimals: 24 },
  'blackdragon.tkn.near': { symbol: 'BLACKDRAGON', decimals: 24 },
}
const describeToken = (id: string) => TOKENS[id as keyof typeof TOKENS] ?? null

describe('classifyOutcome: Rhea aggregator swaps', () => {
  // ft_transfer_call reports the full amount "used" both on success and on a DEX
  // refund (the refund is a separate transfer), so the aggregator's events decide.
  it('reads a completed swap from single_swap_success and reports what arrived and the app fee', () => {
    const r = aggSuccess as unknown as RpcTxResult
    const v = classifyOutcome(r, aggPlan(r), { describeToken })
    expect(v.phase).toBe('success')
    expect(v.swap?.received).toEqual({ token: 'blackdragon.tkn.near', raw: '9167818240094576153812048503987295' })
    expect(v.swap?.appFee).toEqual({ token: 'wrap.near', raw: '120000000000000000000000', recipient: 'meteor-fees.near' })
    expect(v.note).toContain('BLACKDRAGON')
  })

  it('reads native NEAR delivery (withdraw via near_withdraw) as success', () => {
    const r = aggNativeOut as unknown as RpcTxResult
    const v = classifyOutcome(r, aggPlan(r), { describeToken })
    expect(v.phase).toBe('success')
    expect(v.swap?.received?.raw).toBe('47822422698048349167026157')
  })

  it('reads a DEX slippage failure as refunded in full, even though the call reports the amount used', () => {
    const r = aggRefundInput as unknown as RpcTxResult
    const v = classifyOutcome(r, aggPlan(r), { describeToken })
    expect(v.phase).toBe('failed')
    expect(v.error?.code).toBe('SLIPPAGE_EXCEEDED')
    expect(v.swap?.refunded).toEqual({ token: 'wrap.near', raw: '15000000000000000000000000' })
    expect(v.note).toMatch(/refunded/i)
  })

  it('says so when a later hop failed and the refund is the intermediate token', () => {
    const r = aggRefundIntermediate as unknown as RpcTxResult
    const v = classifyOutcome(r, aggPlan(r), { describeToken })
    expect(v.phase).toBe('failed')
    expect(v.swap?.refunded?.token).toBe('wrap.near')
    expect(v.note).toMatch(/instead/i)
  })

  it('reads an aggregator rejection (expired route) as refunded, with the reason', () => {
    const r = aggExpired as unknown as RpcTxResult
    const v = classifyOutcome(r, aggPlan(r), { describeToken })
    expect(v.phase).toBe('failed')
    expect(v.error?.code).toBe('QUOTE_EXPIRED')
    expect(v.note).toMatch(/refunded/i)
  })
})

describe('classifyOutcome: the confirmed transaction must be the planned one', () => {
  const b64json = (v: unknown) => btoa(JSON.stringify(v))
  const chainTx = (receiver: string, amount: string) => ({
    FunctionCall: { method_name: 'ft_transfer', args: b64json({ amount, receiver_id: receiver }), gas: 10000000000000, deposit: '1' },
  })

  it('accepts a transaction whose actions match the plan (argument order does not matter)', () => {
    const r = result({ SuccessValue: '' }, { transaction: { hash: 'H1', signer_id: 'alice.testnet', receiver_id: 'usdc.testnet', actions: [chainTx('bob.testnet', '5')] } })
    expect(classifyOutcome(r, ftTx).phase).toBe('success')
  })

  it('refuses success for a transaction that paid someone else or another amount', () => {
    const other = result({ SuccessValue: '' }, { transaction: { hash: 'H1', signer_id: 'alice.testnet', receiver_id: 'usdc.testnet', actions: [chainTx('mallory.testnet', '5')] } })
    expect(classifyOutcome(other, ftTx)).toMatchObject({ phase: 'failed', error: { code: 'TRANSACTION_FAILED' } })
    const more = result({ SuccessValue: '' }, { transaction: { hash: 'H1', signer_id: 'alice.testnet', receiver_id: 'usdc.testnet', actions: [chainTx('bob.testnet', '6')] } })
    expect(classifyOutcome(more, ftTx).phase).toBe('failed')
  })
})

describe('classifyOutcome: a swap is complete only when the output reached the user', () => {
  it('needs the NEAR transfer to the user for native output', () => {
    const r = structuredClone(aggNativeOut) as unknown as RpcTxResult
    const withoutDelivery = { ...r, receipts: (r.receipts ?? []).filter((x) => !(x.predecessor_id === 'aggregatedex.near' && x.receiver_id === 'kilsdfkndancws.near')) }
    const v = classifyOutcome(withoutDelivery, aggPlan(r), { describeToken })
    expect(v.phase).toBe('unknown')
    expect(v.note).toMatch(/couldn’t confirm/)
  })

  it('needs withdraw_succeeded for a token output', () => {
    const r = structuredClone(aggSuccess) as unknown as RpcTxResult
    const stripped = {
      ...r,
      receipts_outcome: r.receipts_outcome.map((o) => ({ ...o, outcome: { ...o.outcome, logs: o.outcome.logs.filter((l) => !l.includes('"withdraw_succeeded"')) } })),
    }
    expect(classifyOutcome(stripped, aggPlan(r), { describeToken }).phase).toBe('unknown')
  })
})

// ─── delivery before settlement (the 1 NEAR → NEARLY swap of 2026-09-30) ─────

import nearToNearly from './fixtures/agg-near-to-nearly-final.json'

/** The plan the chain transaction was signed from: every action, as NearKit plans it. */
function planOf(r: RpcTxResult): PlannedTransaction {
  const actions = (r.transaction.actions ?? []).map((a) => {
    const f = (a as { FunctionCall: { method_name: string; args: string; gas: number; deposit: string } }).FunctionCall
    return { kind: 'call' as const, method: f.method_name, args: JSON.parse(atob(f.args)) as Record<string, unknown>, gas: String(f.gas), deposit: f.deposit }
  })
  return { index: 0, signerId: r.transaction.signer_id, receiverId: r.transaction.receiver_id, actions, lineIds: [], label: 'Swap', gas: '0', deposit: '0' }
}

/** The transaction as the RPC shows it while it still runs: outcomes up to the first that matches, nothing final. */
function upTo(r: RpcTxResult, last: (o: RpcTxResult['receipts_outcome'][number]) => boolean): RpcTxResult {
  const end = r.receipts_outcome.findIndex(last)
  if (end < 0) throw new Error('no such outcome')
  return { ...r, final_execution_status: 'INCLUDED_FINAL', status: 'Started', receipts_outcome: r.receipts_outcome.slice(0, end + 1) }
}

const logged = (text: string) => (o: RpcTxResult['receipts_outcome'][number]) => o.outcome.logs.some((l) => l.includes(text))
const NEARLY = 'nearly-993927.nearlytrade.near'
const incident = nearToNearly as unknown as RpcTxResult
const nearlyNames = (id: string) => (id === NEARLY ? { symbol: 'NEARLY', decimals: 18 } : id === 'wrap.near' ? { symbol: 'wNEAR', decimals: 24 } : null)

describe('swapDelivered: the output reached the user, before the settlement callbacks', () => {
  const expect_ = { token: NEARLY, recipient: 'bottest.near' }

  it('reports delivery as soon as the aggregator’s transfer to the user succeeded (withdraw_succeeded), without single_swap_success', () => {
    const partial = upTo(incident, logged('"withdraw_succeeded"'))
    expect(partial.receipts_outcome.some(logged('single_swap_success'))).toBe(false)
    const v = swapDelivered(partial, planOf(incident), expect_, { describeToken: nearlyNames })
    expect(v?.phase).toBe('success')
    expect(v?.swap?.received).toEqual({ token: NEARLY, raw: '912437590771706887485' })
    expect(v?.swap?.appFee).toEqual({ token: 'wrap.near', raw: '4000000000000000000000', recipient: 'nearkitfee.near' })
    expect(v?.note).toBe('Received 912.43759 NEARLY · NearKit fee 0.004 wNEAR')
    // The final classifier can't say yet: the last callbacks haven't run.
    expect(classifyOutcome(partial, planOf(incident)).phase).toBe('unknown')
  })

  it('is not delivered while the output is still on its way to the user', () => {
    expect(swapDelivered(upTo(incident, logged('"withdraw_started"')), planOf(incident), expect_)).toBeNull()
    expect(swapDelivered(upTo(incident, logged('Deposit 1000000000000000000000000 NEAR')), planOf(incident), expect_)).toBeNull()
  })

  it('counts only the expected token reaching the expected account', () => {
    const partial = upTo(incident, logged('"withdraw_succeeded"'))
    expect(swapDelivered(partial, planOf(incident), { token: 'usdt.tether-token.near', recipient: 'bottest.near' })).toBeNull()
    expect(swapDelivered(partial, planOf(incident), { token: NEARLY, recipient: 'someone.near' })).toBeNull()
  })

  it('never calls a refund a delivery', () => {
    for (const fixture of [aggRefundInput, aggRefundIntermediate, aggExpired]) {
      const r = fixture as unknown as RpcTxResult
      expect(swapDelivered(r, aggPlan(r), { token: 'blackdragon.tkn.near', recipient: r.transaction.signer_id })).toBeNull()
      expect(swapDelivered(r, aggPlan(r), { token: 'wrap.near', recipient: r.transaction.signer_id })).toBeNull()
    }
  })

  it('never reports delivery for a transaction that differs from the plan', () => {
    const plan = planOf(incident)
    const other = { ...plan, actions: plan.actions.map((a) => (a.kind === 'call' && a.method === 'near_deposit' ? { ...a, deposit: '2000000000000000000000000' } : a)) }
    expect(swapDelivered(upTo(incident, logged('"withdraw_succeeded"')), other, expect_)).toBeNull()
  })

  it('reads the finished transaction the same way, and the final classifier agrees', () => {
    expect(swapDelivered(incident, planOf(incident), expect_)?.swap?.received?.raw).toBe('912437590771706887485')
    expect(classifyOutcome(incident, planOf(incident)).phase).toBe('success')
  })
})

describe('sameActions: a transaction found on chain is the planned one', () => {
  it('matches the chain’s actions to the plan, and nothing else', () => {
    const plan = planOf(incident)
    expect(sameActions(incident.transaction.actions ?? [], plan.actions)).toBe(true)
    expect(sameActions((incident.transaction.actions ?? []).slice(1), plan.actions)).toBe(false)
    const cheaper = plan.actions.map((a) => (a.kind === 'call' && a.method === 'near_deposit' ? { ...a, deposit: '1' } : a))
    expect(sameActions(incident.transaction.actions ?? [], cheaper)).toBe(false)
  })
})
