import { describe, expect, it, vi } from 'vitest'
import type { OperationPlan, OperationProgress, PlannedTransaction } from '@/types/operations'
import { NearKitError } from './errors'
import { createExecutor, type ExecutionPolicy } from './executor'
import { RpcError, type RpcTxResult } from './rpc'
import type { WalletAdapter, WalletSession } from './wallet'

const tx = (index: number, signerId = 'alice.testnet'): PlannedTransaction => ({
  index,
  signerId,
  receiverId: 'usdc.testnet',
  actions: [{ kind: 'call', method: 'ft_transfer', args: { receiver_id: `r${index}.testnet`, amount: '5' }, gas: '10000000000000', deposit: '1' }],
  lineIds: [`l${index}`],
  label: `tx ${index}`,
  gas: '10000000000000',
  deposit: '1',
})

const plan = (txs: PlannedTransaction[], groups: number[][], extra: Partial<OperationPlan> = {}): OperationPlan => ({
  id: 'p1',
  kind: 'batch-send',
  mode: 'near',
  network: 'testnet',
  title: 'Send',
  token: { id: 'usdc.testnet', symbol: 'USDC', decimals: 6, contract: 'usdc.testnet' },
  signers: [...new Set(txs.map((t) => t.signerId))],
  lines: [],
  transactions: txs,
  groups,
  totals: { amount: { raw: '0', display: '0' }, storage: { raw: '0', display: '0' }, upfrontNear: { raw: '0', display: '0' } },
  fee: null,
  swap: null,
  warnings: [],
  expiresAt: null,
  createdAt: 0,
  ...extra,
})

const okPolicy: ExecutionPolicy = { network: 'testnet', enabled: true, reason: null, feeRecipient: null }

function wallet(session: WalletSession | null, sign: (signerId: string, n: number) => Promise<unknown[]>) {
  const adapter: WalletAdapter = {
    kind: 'e2e-test',
    listWallets: async () => [],
    connect: async () => {
      throw new Error('unused')
    },
    restore: async () => session,
    session: async () => session,
    disconnect: async () => undefined,
    signAndSendTransactions: vi.fn(async (signerId: string, txs: unknown[]) => sign(signerId, txs.length)),
    signMessage: async () => {
      throw new Error('unused')
    },
  }
  return adapter
}

const session: WalletSession = { walletId: 'test', walletName: 'Test', accounts: ['alice.testnet'], batch: true }
let hashSeq = 0
const outcomes = (n: number, signer = 'alice.testnet') => Array.from({ length: n }, () => ({ transaction: { hash: `H${(hashSeq += 1)}`, signer_id: signer } }))

const success = (hash: string, signer = 'alice.testnet'): RpcTxResult => ({
  final_execution_status: 'FINAL',
  status: { SuccessValue: '' },
  transaction: { hash, signer_id: signer, receiver_id: 'usdc.testnet' },
  transaction_outcome: { id: hash, outcome: { logs: [], receipt_ids: [], gas_burnt: 1, tokens_burnt: '0', executor_id: signer, status: {} } },
  receipts_outcome: [],
})

const failed = (hash: string): RpcTxResult => ({
  ...success(hash),
  status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: boom' } } } } },
})

const keys = (nonce: number) => ({ keys: [{ public_key: 'ed25519:A', access_key: { nonce, permission: 'FullAccess' } }] })

function executor(adapter: WalletAdapter, txStatus: (hash: string) => Promise<unknown>, policy = okPolicy, nonces: () => Promise<unknown> = async () => keys(7)) {
  return createExecutor({
    rpc: { txStatus: (hash) => txStatus(hash) as Promise<RpcTxResult>, call: (() => nonces()) as never },
    wallet: async () => adapter,
    policy,
    explorerTxUrl: (h) => `https://testnet.nearblocks.io/txns/${h}`,
    sleep: async () => undefined,
    confirmDeadlineMs: 50,
  })
}

describe('executor', () => {
  it('signs, submits, confirms on chain and reports success with explorer links', async () => {
    const adapter = wallet(session, async (_, n) => outcomes(n))
    const phases: string[] = []
    const result = await executor(adapter, async (h) => success(h)).run(plan([tx(0), tx(1)], [[0, 1]]), null, (p) => phases.push(p.txs.map((t) => t.phase).join(',')))
    expect(result.phase).toBe('success')
    expect(result.txs.every((t) => t.phase === 'success' && t.hash && t.explorerUrl?.startsWith('https://testnet.nearblocks.io/txns/'))).toBe(true)
    expect(phases).toContain('awaiting_signature,awaiting_signature')
    expect(phases).toContain('submitted,submitted')
    expect(phases.at(-1)).toBe('success,success')
  })

  it('refuses to run when execution is disabled, before the wallet is asked', async () => {
    const adapter = wallet(session, async (_, n) => outcomes(n))
    const disabled: ExecutionPolicy = { network: 'mainnet', enabled: false, reason: 'Mainnet execution is disabled in this build', feeRecipient: null }
    await expect(executor(adapter, async (h) => success(h), disabled).run(plan([tx(0)], [[0]], { network: 'mainnet' }), null, () => undefined)).rejects.toMatchObject({
      code: 'EXECUTION_DISABLED',
    })
    expect(adapter.signAndSendTransactions).not.toHaveBeenCalled()
  })

  it('refuses a plan built for another network', async () => {
    const adapter = wallet(session, async (_, n) => outcomes(n))
    await expect(executor(adapter, async (h) => success(h)).run(plan([tx(0)], [[0]], { network: 'mainnet' }), null, () => undefined)).rejects.toMatchObject({
      code: 'NETWORK_MISMATCH',
    })
    expect(adapter.signAndSendTransactions).not.toHaveBeenCalled()
  })

  it('refuses a fee-bearing plan when no fee recipient is configured', async () => {
    const adapter = wallet(session, async (_, n) => outcomes(n))
    const p = plan([tx(0)], [[0]], {
      fee: {
        label: 'NearKit fee',
        bps: 10,
        amount: { raw: '1', display: '1' },
        token: { id: 'near', symbol: 'NEAR', decimals: 24, contract: null },
        charged: true,
        recipient: null,
        received: null,
        routerShare: null,
        routerFee: null,
        note: null,
      },
    })
    await expect(executor(adapter, async (h) => success(h)).run(p, null, () => undefined)).rejects.toMatchObject({ code: 'EXECUTION_DISABLED' })
  })

  it('refuses an expired quote-bound plan', async () => {
    const adapter = wallet(session, async (_, n) => outcomes(n))
    await expect(executor(adapter, async (h) => success(h)).run(plan([tx(0)], [[0]], { expiresAt: 1 }), null, () => undefined)).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' })
  })

  it('marks a rejected approval as not sent, and nothing after it runs', async () => {
    const adapter = wallet(session, async () => {
      throw new Error('User rejected the transaction')
    })
    const status = vi.fn(async (h: string) => success(h))
    const r = await executor(adapter, status).run(plan([tx(0), tx(1)], [[0], [1]]), null, () => undefined)
    expect(r.phase).toBe('failed')
    expect(r.txs.map((t) => t.phase)).toEqual(['not_sent', 'not_sent'])
    expect(r.txs[0]?.error?.code).toBe('USER_REJECTED')
    expect(status).not.toHaveBeenCalled()
  })

  it('marks a refusal raised before anything reaches the wallet as not sent', async () => {
    const adapter = wallet(session, async () => {
      throw new NearKitError('WALLET_UNAVAILABLE', 'Your wallet session ended. Connect the wallet again to continue.')
    })
    const r = await executor(adapter, async (h) => success(h)).run(plan([tx(0), tx(1)], [[0], [1]]), null, () => undefined)
    expect(r.txs.map((t) => t.phase)).toEqual(['not_sent', 'not_sent'])
    expect(r.txs[0]?.error?.code).toBe('WALLET_UNAVAILABLE')
  })

  it('treats a rejection as unknown when the account’s transaction counter moved anyway', async () => {
    let reads = 0
    const adapter = wallet(session, async () => {
      throw new Error('Wallet closed')
    })
    const r = await executor(
      adapter,
      async (h) => success(h),
      okPolicy,
      async () => keys(reads++ === 0 ? 7 : 8),
    ).run(plan([tx(0)], [[0]]), null, () => undefined)
    expect(r.txs[0]?.phase).toBe('unknown')
    expect(r.txs[0]?.note).toMatch(/may still have been sent/)
  })

  it('treats a rejection as unknown when the counter can’t be read', async () => {
    const adapter = wallet(session, async () => {
      throw new Error('User rejected the transaction')
    })
    const r = await executor(
      adapter,
      async (h) => success(h),
      okPolicy,
      async () => {
        throw new Error('RPC down')
      },
    ).run(plan([tx(0)], [[0]]), null, () => undefined)
    expect(r.txs[0]?.phase).toBe('unknown')
  })

  it('never throws after the wallet answered: a malformed RPC answer leaves the transaction unknown', async () => {
    const adapter = wallet(session, async (_, n) => outcomes(n))
    const r = await executor(adapter, async () => ({ final_execution_status: 'INCLUDED' })).run(plan([tx(0), tx(1)], [[0], [1]]), null, () => undefined)
    // It pauses: the next approval waits for the user's decision instead of running.
    expect(r.phase).toBe('paused')
    expect(r.txs.map((t) => t.phase)).toEqual(['unknown', 'queued'])
    expect(r.txs[0]?.hash).toBeTruthy()
  })

  it('treats a wallet result that is not a list as unknown', async () => {
    const adapter = wallet(session, async () => undefined as unknown as unknown[])
    const r = await executor(adapter, async (h) => success(h)).run(plan([tx(0), tx(1)], [[0, 1]]), null, () => undefined)
    expect(r.txs.map((t) => t.phase)).toEqual(['unknown', 'unknown'])
  })

  it('a plan that reached the wallet can’t be started again from scratch', async () => {
    const adapter = wallet(session, async (_, n) => outcomes(n))
    const run = executor(adapter, async (h) => success(h))
    const p = plan([tx(0)], [[0]])
    await run.run(p, null, () => undefined)
    await expect(run.run(p, null, () => undefined)).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' })
    expect(adapter.signAndSendTransactions).toHaveBeenCalledTimes(1)
  })

  it('refuses to resume with progress from another plan or a group mixing signers', async () => {
    const adapter = wallet({ ...session, accounts: ['alice.testnet', 'bob.testnet'] }, async (_, n) => outcomes(n))
    const run = executor(adapter, async (h) => success(h))
    const p = plan([tx(0)], [[0]])
    const foreign = { planId: 'other', phase: 'paused' as const, txs: [], groupIndex: 0, pause: null, simulated: false, startedAt: 0, finishedAt: null }
    await expect(run.run(p, foreign, () => undefined)).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' })
    await expect(run.run(plan([tx(0), tx(1, 'bob.testnet')], [[0, 1]]), null, () => undefined)).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' })
    expect(adapter.signAndSendTransactions).not.toHaveBeenCalled()
  })

  it('reports an ambiguous wallet error as unknown, never as failed or success', async () => {
    const adapter = wallet(session, async () => {
      throw new Error('Network request failed')
    })
    const r = await executor(adapter, async (h) => success(h)).run(plan([tx(0)], [[0]]), null, () => undefined)
    expect(r.txs[0]?.phase).toBe('unknown')
    expect(r.phase).toBe('failed')
  })

  it('pauses after a failed group and only continues when asked, never re-sending', async () => {
    const signed: number[] = []
    const adapter = wallet(session, async (_, n) => {
      signed.push(n)
      return outcomes(n)
    })
    const statuses = new Map<string, RpcTxResult>()
    const run = executor(adapter, async (h) => statuses.get(h) ?? (h === 'H' + String(hashSeq - 1) ? failed(h) : success(h)))
    const p = plan([tx(0), tx(1), tx(2)], [[0, 1], [2]])
    const first = await run.run(p, null, () => undefined)
    expect(first.phase).toBe('paused')
    expect(first.pause?.reason).toBe('failure')
    expect(first.groupIndex).toBe(1)
    expect(first.txs.map((t) => t.phase)).toEqual(['failed', 'success', 'queued'])
    const second = await run.run(p, first, () => undefined)
    expect(signed).toEqual([2, 1])
    expect(second.phase).toBe('partial')
    expect(second.txs.map((t) => t.phase)).toEqual(['failed', 'success', 'success'])
  })

  it('pauses for a fresh quote when a quote-bound plan expires between approvals, without sending the rest', async () => {
    let clock = 1000
    const adapter = wallet(session, async (_, n) => {
      clock = 5000 // the user took a while in the wallet
      return outcomes(n)
    })
    const run = createExecutor({
      rpc: { txStatus: async (h) => success(h) },
      wallet: async () => adapter,
      policy: okPolicy,
      explorerTxUrl: (h) => h,
      sleep: async () => undefined,
      confirmDeadlineMs: 50,
      now: () => clock,
    })
    const r = await run.run(plan([tx(0), tx(1)], [[0], [1]], { expiresAt: 4000 }), null, () => undefined)
    expect(r.phase).toBe('paused')
    expect(r.pause?.reason).toBe('requote')
    expect(r.txs.map((t) => t.phase)).toEqual(['success', 'queued'])
    expect(adapter.signAndSendTransactions).toHaveBeenCalledTimes(1)
  })

  it('pauses for an account switch when the signer is not in the wallet session', async () => {
    const adapter = wallet(session, async (_, n) => outcomes(n))
    const r = await executor(adapter, async (h) => success(h)).run(plan([tx(0, 'bob.testnet')], [[0]]), null, () => undefined)
    expect(r.phase).toBe('paused')
    expect(r.pause).toMatchObject({ reason: 'switch-account', signerId: 'bob.testnet' })
    expect(adapter.signAndSendTransactions).not.toHaveBeenCalled()
  })

  it('leaves a transaction unknown when confirmation never arrives', async () => {
    const adapter = wallet(session, async (_, n) => outcomes(n))
    const r = await executor(adapter, async () => {
      throw new RpcError('handler', 'Transaction doesn’t exist', 'UNKNOWN_TRANSACTION')
    }).run(plan([tx(0)], [[0]]), null, () => undefined)
    expect(r.txs[0]?.phase).toBe('unknown')
    expect(r.txs[0]?.hash).toBeTruthy()
  })

  it('does not trust a wallet result without a hash', async () => {
    const adapter = wallet(session, async () => [{}])
    const r = await executor(adapter, async (h) => success(h)).run(plan([tx(0)], [[0]]), null, () => undefined)
    expect(r.txs[0]?.phase).toBe('unknown')
  })

  it('emits a fresh object on every update so React sees each state', async () => {
    const adapter = wallet(session, async (_, n) => outcomes(n))
    const seen: OperationProgress[] = []
    await executor(adapter, async (h) => success(h)).run(plan([tx(0)], [[0]]), null, (p) => seen.push(p))
    expect(new Set(seen).size).toBe(seen.length)
  })
})
