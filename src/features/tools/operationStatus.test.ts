import { describe, expect, it } from 'vitest'
import type { OperationPlan, OperationProgress, TxPhase } from '@/types/operations'
import { canCloseWhileRunning, headline, settledToast } from './operationStatus'

const amount = { raw: '1', display: '1' }
const plan = (n = 1): OperationPlan => ({
  id: 'p',
  kind: 'swap',
  mode: 'near',
  network: 'mainnet',
  title: 'Buy NEARLY · 1 NEAR',
  token: { id: 'near', symbol: 'NEAR', decimals: 24, contract: null },
  signers: ['bottest.near'],
  lines: [],
  transactions: Array.from({ length: n }, (_, i) => ({
    index: i,
    signerId: 'bottest.near',
    receiverId: 'wrap.near',
    actions: [],
    lineIds: [],
    label: `tx ${i}`,
    gas: '0',
    deposit: '0',
  })),
  groups: [Array.from({ length: n }, (_, i) => i)],
  totals: { amount, storage: amount, upfrontNear: amount },
  fee: null,
  swap: null,
  warnings: [],
  expiresAt: null,
  createdAt: 0,
})
const progress = (phase: OperationProgress['phase'], txPhases: TxPhase[]): OperationProgress => ({
  planId: 'p',
  phase,
  txs: txPhases.map((p, index) => ({ index, phase: p, hash: null, explorerUrl: null, error: null, note: null })),
  groupIndex: 0,
  pause: null,
  simulated: false,
  startedAt: 0,
  finishedAt: null,
})

describe('headline', () => {
  it('says the network is slow while a step is processing, and never that something failed', () => {
    expect(headline(plan(), progress('running', ['processing']))).toBe('Processing — NEAR network is taking longer than usual')
    expect(headline(plan(), progress('processing', ['processing']))).toBe('Still processing on chain')
  })

  it('keeps the other states as they were', () => {
    expect(headline(plan(), progress('running', ['awaiting_signature']))).toBe('Waiting for your approval in the wallet')
    expect(headline(plan(), progress('running', ['confirming']))).toBe('Confirming on chain')
    expect(headline(plan(), progress('success', ['success']))).toBe('Confirmed')
    expect(headline(plan(2), progress('success', ['success', 'success']))).toBe('All 2 transactions confirmed')
    expect(headline(plan(), progress('failed', ['unknown']))).toBe('Outcome not confirmed')
    expect(headline(plan(), progress('failed', ['not_sent']))).toBe('Nothing was sent')
  })
})

describe('canCloseWhileRunning', () => {
  it('lets the dialog close once only following the chain is left: tracking goes on without it', () => {
    expect(canCloseWhileRunning(progress('running', ['processing']))).toBe(true)
    expect(canCloseWhileRunning(progress('running', ['success', 'confirming']))).toBe(true)
  })

  it('keeps it open while the wallet is asked, or another approval is still to come', () => {
    expect(canCloseWhileRunning(progress('running', ['awaiting_signature']))).toBe(false)
    expect(canCloseWhileRunning(progress('running', ['success', 'queued']))).toBe(false)
  })
})

describe('settledToast', () => {
  it('confirms a success', () => {
    expect(settledToast(plan(), progress('success', ['success']), 'Mainnet')).toMatchObject({ tone: 'accent', title: 'Confirmed · Buy NEARLY · 1 NEAR' })
  })

  it('tells a trade still processing apart from a failure', () => {
    const t = settledToast(plan(), progress('processing', ['processing']), 'Mainnet')
    expect(t.tone).toBe('warn')
    expect(t.title).toBe('Still processing · Buy NEARLY · 1 NEAR')
    expect(t.detail).toMatch(/Activity/)
    expect(t.detail).not.toMatch(/wrong|failed/i)
  })

  it('reports what didn’t complete', () => {
    expect(settledToast(plan(2), progress('partial', ['success', 'failed']), 'Mainnet')).toMatchObject({ tone: 'neg', title: 'Not completed · Buy NEARLY · 1 NEAR' })
  })
})
