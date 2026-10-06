import { describe, expect, it, vi } from 'vitest'
import type { RpcTxResult } from '@/services/near/rpc'
import { successOutcome } from './testing/fakeChain'
import { activityStatus, reconcile } from './activity'
import type { NearContext } from './context'
import type { ActivityRecord, ActivityTx } from './stores'

const swapTx = (over: Partial<ActivityTx> = {}): ActivityTx => ({
  hash: 'H1',
  signerId: 'bottest.near',
  receiverId: 'wrap.near',
  phase: 'processing',
  last: { kind: 'call', method: 'near_deposit', args: {}, gas: '10000000000000', deposit: '1' },
  note: 'Processing — NEAR network is taking longer than usual.',
  ...over,
})

const record = (txs: ActivityTx[], over: Partial<ActivityRecord> = {}): ActivityRecord => ({
  id: 'p1',
  planId: 'p1',
  kind: 'swap',
  title: 'Buy NEARLY',
  detail: '',
  at: 0,
  origin: 'nearkit',
  status: activityStatus(txs, false),
  network: 'mainnet',
  accountId: 'bottest.near',
  txHashes: txs.flatMap((t) => (t.hash ? [t.hash] : [])),
  explorerUrl: null,
  txs,
  checkedAt: 0,
  ...over,
})

const ctxWith = (txStatus: (hash: string) => Promise<RpcTxResult>, now: number) => ({ rpc: { txStatus: vi.fn(txStatus) }, now: () => now }) as unknown as NearContext

describe('activity: a transaction still processing on chain', () => {
  it('is pending, never unknown or failed', () => {
    expect(activityStatus([swapTx()], false)).toBe('pending')
    expect(activityStatus([swapTx({ phase: 'success' }), swapTx()], false)).toBe('pending')
  })

  it('is checked again, and settles when the chain’s final record arrives', async () => {
    const ctx = ctxWith(async (h) => successOutcome(h, 'bottest.near', 'wrap.near'), 60_000)
    const r = await reconcile(ctx, record([swapTx()]), new Set())
    expect(ctx.rpc.txStatus).toHaveBeenCalledWith('H1', 'bottest.near', 'FINAL')
    expect(r.txs[0]?.phase).toBe('success')
    expect(r.status).toBe('success')
  })

  it('stays pending while the chain has no final record yet', async () => {
    const ctx = ctxWith(async () => Promise.reject(new Error('TIMEOUT_ERROR')), 60_000)
    const r = await reconcile(ctx, record([swapTx()]), new Set())
    expect(r.txs[0]?.phase).toBe('processing')
    expect(r.status).toBe('pending')
  })

  it('without a hash (NEARKITS closed while looking for it) becomes unknown once the run is gone', async () => {
    const ctx = ctxWith(async (h) => successOutcome(h, 'bottest.near', 'wrap.near'), 60 * 60_000)
    const r = await reconcile(ctx, record([swapTx({ hash: null })], { status: 'pending', checkedAt: 0 }), new Set())
    expect(r.txs[0]?.phase).toBe('unknown')
    expect(r.txs[0]?.note).toMatch(/wallet activity/)
  })
})
