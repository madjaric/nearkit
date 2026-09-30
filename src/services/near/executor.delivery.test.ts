import { describe, expect, it, vi } from 'vitest'
import type { OperationPlan, OperationProgress, PlannedTransaction, TokenRef } from '@/types/operations'
import aggRefundInput from './fixtures/agg-refund-input.json'
import nearToNearly from './fixtures/agg-near-to-nearly-final.json'
import { createExecutor, PROCESSING_NOTE, type ExecutionPolicy } from './executor'
import type { SignedTx } from './locate'
import { RpcError, type RpcTxResult, type WaitUntil } from './rpc'
import type { WalletAdapter } from './wallet'

/**
 * A swap is done for the user when its tokens arrive, not when the chain's last settlement
 * callback runs, and never "failed" on the wallet's word: the chain decides (2026-09-30:
 * 1 NEAR → NEARLY delivered at 115 s, settled at 203 s, the wallet timed out in between).
 */

const incident = nearToNearly as unknown as RpcTxResult
const HASH = incident.transaction.hash
const SIGNER = 'bottest.near'
const KEY = 'ed25519:7Y3n1aBoMY6b2dGwHuMe3QNKsEjCbyycUbaD9MstxrVQ'
const NEARLY: TokenRef = { id: 'nearly-993927.nearlytrade.near', symbol: 'NEARLY', decimals: 18, contract: 'nearly-993927.nearlytrade.near' }
const NEAR: TokenRef = { id: 'near', symbol: 'NEAR', decimals: 24, contract: null }
const WNEAR: TokenRef = { id: 'wrap.near', symbol: 'wNEAR', decimals: 24, contract: 'wrap.near' }

function plannedFrom(r: RpcTxResult): PlannedTransaction {
  const actions = (r.transaction.actions ?? []).map((a) => {
    const f = (a as { FunctionCall: { method_name: string; args: string; gas: number; deposit: string } }).FunctionCall
    return { kind: 'call' as const, method: f.method_name, args: JSON.parse(atob(f.args)) as Record<string, unknown>, gas: String(f.gas), deposit: f.deposit }
  })
  return { index: 0, signerId: r.transaction.signer_id, receiverId: r.transaction.receiver_id, actions, lineIds: [], label: 'NEAR → NEARLY', gas: '0', deposit: '0' }
}

const amount = (raw: string) => ({ raw, display: raw })
function swapPlan(tx: PlannedTransaction, tokenOut: TokenRef = NEARLY): OperationPlan {
  return {
    id: `swap-${Math.random()}`,
    kind: 'swap',
    mode: 'near',
    network: 'mainnet',
    title: 'Buy NEARLY · 1 NEAR',
    token: NEAR,
    signers: [tx.signerId],
    lines: [],
    transactions: [tx],
    groups: [[0]],
    totals: { amount: amount('1'), storage: amount('0'), upfrontNear: amount('0') },
    fee: null,
    swap: {
      router: 'aggregator',
      tokenIn: NEAR,
      tokenOut,
      amountIn: amount('1'),
      expectedOut: amount('912'),
      minOut: amount('900'),
      slippagePct: 1,
      priceImpactPct: null,
      route: ['NEAR', tokenOut.symbol],
      routeTokens: [WNEAR, tokenOut],
      quotedAt: 0,
    },
    warnings: [],
    expiresAt: null,
    createdAt: 0,
  }
}

/** The transaction as the RPC shows it while it runs: outcomes up to the first that logs `text`. */
function upTo(r: RpcTxResult, text: string): RpcTxResult {
  const end = r.receipts_outcome.findIndex((o) => o.outcome.logs.some((l) => l.includes(text)))
  return { ...r, final_execution_status: 'INCLUDED_FINAL', status: 'Started', receipts_outcome: r.receipts_outcome.slice(0, end + 1) }
}
const onTheWay = upTo(incident, '"withdraw_started"')
const delivered = upTo(incident, '"withdraw_succeeded"')

const policy: ExecutionPolicy = { network: 'mainnet', enabled: true, reason: null, feeRecipient: null }

interface Harness {
  /** What the chain answers for the swap, by how it is asked. */
  status: (waitUntil: WaitUntil | undefined) => RpcTxResult | 'unknown'
  /** The wallet's answer; it broadcasts first unless `broadcast` is false. */
  wallet: () => Promise<unknown[]>
  broadcast?: boolean
  deadlineMs?: number
}

function harness(h: Harness) {
  let clock = 1_000_000
  let height = 1000
  let sent = false
  const statusCalls: { waitUntil: WaitUntil | undefined; at: number }[] = []
  const updates: OperationProgress[] = []
  const sign = vi.fn(async () => {
    if (h.broadcast !== false) sent = true
    return h.wallet()
  })
  const adapter: WalletAdapter = {
    kind: 'e2e-test',
    listWallets: async () => [],
    connect: async () => {
      throw new Error('unused')
    },
    restore: async () => null,
    session: async () => ({ walletId: 'test', walletName: 'Test', accounts: [SIGNER], batch: true }),
    disconnect: async () => undefined,
    signAndSendTransactions: sign,
    signMessage: async () => {
      throw new Error('unused')
    },
  }
  const found: SignedTx = { hash: HASH, publicKey: KEY, nonce: 101n, receiverId: 'wrap.near', actions: incident.transaction.actions ?? [], height: 1003 }
  const locator = { signedSince: vi.fn(async (_a: string, _b: unknown, from: number, to: number) => (sent && from < 1003 && to >= 1003 ? [found] : [])) }
  const executor = createExecutor({
    rpc: {
      txStatus: async (hash, _sender, waitUntil) => {
        statusCalls.push({ waitUntil, at: clock })
        const r = hash === HASH ? h.status(waitUntil) : 'unknown'
        if (r === 'unknown') throw new RpcError('handler', 'Transaction not found', 'UNKNOWN_TRANSACTION')
        return r
      },
      call: (async (method: string, params: { request_type?: string }) => {
        if (method === 'query' && params.request_type === 'view_access_key_list') {
          height += 2
          return { keys: [{ public_key: KEY, access_key: { nonce: sent ? 101 : 100 } }], block_height: height, block_hash: 'h' }
        }
        throw new Error(`unexpected ${method}`)
      }) as never,
    },
    wallet: async () => adapter,
    policy,
    explorerTxUrl: (hash) => `https://nearblocks.io/txns/${hash}`,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
      await new Promise((r) => setTimeout(r, 0))
    },
    confirmDeadlineMs: h.deadlineMs,
    locator,
    onUpdate: (_plan, p) => void updates.push(p),
  })
  return { executor, sign, locator, statusCalls, updates, clock: () => clock }
}

const phases = (seen: OperationProgress[]) => seen.map((p) => p.txs[0]?.phase)

describe('delivery-based success', () => {
  it('a normal swap: success as soon as the tokens arrive, and final settlement is still followed in the background', async () => {
    let finalAvailable = false
    const h = harness({
      wallet: async () => [{ transaction: { hash: HASH } }],
      // The node can show the delivery at once; the final record only later.
      status: (w) => (w === 'FINAL' ? (finalAvailable ? incident : 'unknown') : delivered),
    })
    const plan = swapPlan(plannedFrom(incident))
    const seen: OperationProgress[] = []
    const result = await h.executor.run(plan, null, (p) => seen.push(p))

    expect(result.phase).toBe('success')
    expect(result.txs[0]).toMatchObject({ phase: 'success', hash: HASH, note: 'Received 912.43759 NEARLY · NearKit fee 0.004 wNEAR', settling: true })
    expect(phases(seen)).not.toContain('processing')
    expect(phases(seen)).not.toContain('failed')

    // Settlement lands later: recorded for Activity, without touching the finished run's progress callback.
    const reportedBefore = seen.length
    finalAvailable = true
    await vi.waitFor(() => expect(h.updates.at(-1)?.txs[0]?.settling).toBe(false))
    expect(h.updates.at(-1)?.txs[0]).toMatchObject({ phase: 'success', note: 'Received 912.43759 NEARLY · NearKit fee 0.004 wNEAR' })
    expect(seen.length).toBe(reportedBefore)
    expect(h.statusCalls.some((c) => c.waitUntil === 'FINAL')).toBe(true)
  })

  it('final settlement arriving after delivery changes nothing the user saw', async () => {
    let polls = 0
    let finalPolls = 0
    const h = harness({
      wallet: async () => [{ transaction: { hash: HASH } }],
      status: (w) => {
        // The final record only after a few more asks.
        if (w === 'FINAL') return (finalPolls += 1) > 2 ? incident : 'unknown'
        polls += 1
        return polls === 1 ? onTheWay : delivered
      },
    })
    const result = await h.executor.run(swapPlan(plannedFrom(incident)), null, () => undefined)
    expect(result.txs[0]).toMatchObject({ phase: 'success', settling: true })
    await vi.waitFor(() => expect(h.updates.at(-1)?.txs[0]).toMatchObject({ phase: 'success', settling: false }))
  })
})

describe('wallet errors after broadcast', () => {
  it('a wallet timeout never fails the swap: it shows Processing, finds the transaction on chain and reports success when the tokens arrive', async () => {
    let polls = 0
    const h = harness({
      wallet: async () => {
        throw new Error('Transaction timed out while waiting for its result')
      },
      status: (w) => {
        if (w === 'FINAL') return 'unknown'
        polls += 1
        return polls < 4 ? onTheWay : delivered
      },
    })
    const seen: OperationProgress[] = []
    const result = await h.executor.run(swapPlan(plannedFrom(incident)), null, (p) => seen.push(p))

    expect(result.phase).toBe('success')
    expect(result.txs[0]).toMatchObject({ phase: 'success', hash: HASH, note: 'Received 912.43759 NEARLY · NearKit fee 0.004 wNEAR' })
    const processing = seen.find((p) => p.txs[0]?.phase === 'processing')
    expect(processing?.txs[0]?.note).toBe(PROCESSING_NOTE)
    expect(processing?.txs[0]?.error).toBeNull()
    expect(phases(seen)).not.toContain('failed')
    expect(phases(seen)).not.toContain('unknown')
    expect(h.locator.signedSince).toHaveBeenCalled()
  })

  it('never asks the wallet again, and the same plan can’t be sent a second time', async () => {
    const h = harness({
      wallet: async () => {
        throw new Error('Request timed out')
      },
      status: (w) => (w === 'FINAL' ? 'unknown' : delivered),
    })
    const plan = swapPlan(plannedFrom(incident))
    await h.executor.run(plan, null, () => undefined)
    await expect(h.executor.run(plan, null, () => undefined)).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' })
    expect(h.sign).toHaveBeenCalledTimes(1)
  })

  it('reports delivery while a wallet that waits for every callback is still waiting', async () => {
    let answer: (v: unknown[]) => void = () => undefined
    const h = harness({
      wallet: () => new Promise<unknown[]>((resolve) => (answer = resolve)),
      status: (w) => (w === 'FINAL' ? 'unknown' : delivered),
    })
    const result = await h.executor.run(swapPlan(plannedFrom(incident)), null, () => undefined)
    expect(result.txs[0]).toMatchObject({ phase: 'success', hash: HASH })
    // The wallet's late answer (the same transaction) changes nothing.
    answer([{ transaction: { hash: HASH } }])
    await new Promise((r) => setTimeout(r, 0))
    expect(h.sign).toHaveBeenCalledTimes(1)
  })

  it('a rejection with nothing on chain is still “not sent”', async () => {
    const h = harness({
      broadcast: false,
      wallet: async () => {
        throw new Error('User rejected the transaction')
      },
      status: () => 'unknown',
    })
    const result = await h.executor.run(swapPlan(plannedFrom(incident)), null, () => undefined)
    expect(result.txs[0]?.phase).toBe('not_sent')
    expect(result.phase).toBe('failed')
  })
})

describe('what the chain decides', () => {
  it('a genuinely failed swap is reported as failed, with the refund', async () => {
    const refund = aggRefundInput as unknown as RpcTxResult
    const action = (refund.transaction.actions?.[0] as { FunctionCall: { args: string } }).FunctionCall
    const tx: PlannedTransaction = {
      index: 0,
      signerId: refund.transaction.signer_id,
      receiverId: refund.transaction.receiver_id,
      actions: [{ kind: 'call', method: 'ft_transfer_call', args: JSON.parse(atob(action.args)) as Record<string, unknown>, gas: '300000000000000', deposit: '1' }],
      lineIds: [],
      label: 'Swap',
      gas: '0',
      deposit: '0',
    }
    expect(refund.final_execution_status).toBe('FINAL')
    const plan = { ...swapPlan(tx, { id: 'blackdragon.tkn.near', symbol: 'BLACKDRAGON', decimals: 24, contract: 'blackdragon.tkn.near' }), signers: [tx.signerId] }
    const executor = createExecutor({
      rpc: { txStatus: async () => refund },
      wallet: async () => ({
        kind: 'e2e-test',
        listWallets: async () => [],
        connect: async () => {
          throw new Error('unused')
        },
        restore: async () => null,
        session: async () => ({ walletId: 't', walletName: 'T', accounts: [tx.signerId], batch: true }),
        disconnect: async () => undefined,
        signAndSendTransactions: async () => [{ transaction: { hash: refund.transaction.hash } }],
        signMessage: async () => {
          throw new Error('unused')
        },
      }),
      policy,
      explorerTxUrl: (x) => x,
      sleep: async () => undefined,
    })
    const result = await executor.run(plan, null, () => undefined)
    expect(result.phase).toBe('failed')
    expect(result.txs[0]).toMatchObject({ phase: 'failed', error: { code: 'SLIPPAGE_EXCEEDED' } })
    expect(result.txs[0]?.note).toMatch(/refunded/i)
  })

  it('a swap still running keeps showing Processing, and is never called failed', async () => {
    const h = harness({
      wallet: async () => [{ transaction: { hash: HASH } }],
      status: (w) => (w === 'FINAL' ? 'unknown' : onTheWay),
      deadlineMs: 5 * 60_000,
    })
    const seen: OperationProgress[] = []
    const result = await h.executor.run(swapPlan(plannedFrom(incident)), null, (p) => seen.push(p))
    expect(result.phase).toBe('processing')
    expect(result.txs[0]).toMatchObject({ phase: 'processing', hash: HASH, error: null })
    expect(result.txs[0]?.note).toMatch(/still processing/i)
    // Processing shows once the swap takes longer than usual, well before NearKit stops following it.
    const firstProcessing = seen.findIndex((p) => p.txs[0]?.phase === 'processing')
    expect(firstProcessing).toBeGreaterThan(0)
    expect(seen[firstProcessing]?.txs[0]?.note).toBe(PROCESSING_NOTE)
    expect(phases(seen)).not.toContain('failed')
    expect(phases(seen)).not.toContain('unknown')
  })
})
