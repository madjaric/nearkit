import { describe, expect, it } from 'vitest'
import { classifyFailure, NearKitError, toNearKitError } from './errors'
import { RpcError } from './rpc'

describe('toNearKitError', () => {
  it('passes NEARKITS errors through unchanged', () => {
    const e = new NearKitError('QUOTE_EXPIRED', 'Quote expired')
    expect(toNearKitError(e)).toBe(e)
  })

  it('recognises wallet rejections in every wording the wallets use', () => {
    for (const text of ['User rejected', 'Wallet closed', 'User closed the window', 'User rejected the transaction', 'User cancelled the action', 'User rejected the connection']) {
      expect(toNearKitError(new Error(text)).code, text).toBe('USER_REJECTED')
      expect(toNearKitError(text).code, text).toBe('USER_REJECTED')
    }
  })

  it('recognises the cancel wording of each wallet in the vendored manifest', () => {
    const wording = {
      meteor: 'Action was cancelled',
      intear: 'User closed the modal',
      ledger: 'User cancelled',
      mynearwallet: 'User closed the window',
      nearMobile: 'Request rejected by user',
      trezu: 'User closed the window',
    }
    for (const [wallet, text] of Object.entries(wording)) expect(toNearKitError(new Error(text)).code, wallet).toBe('USER_REJECTED')
  })

  it('does not mistake a dropped request for a rejection: the wallet may have sent it', () => {
    for (const text of ['The user aborted a request.', 'Request failed with status 429', 'Operation failed', 'Proposal 12 was rejected']) {
      expect(toNearKitError(new Error(text)).code, text).not.toBe('USER_REJECTED')
    }
  })

  it('maps RPC failures and keeps the original for diagnostics', () => {
    const transport = new RpcError('transport', 'All RPC endpoints failed')
    const normal = toNearKitError(transport)
    expect(normal.code).toBe('RPC_ERROR')
    expect(normal.cause).toBe(transport)
    expect(toNearKitError(new RpcError('handler', 'Server error', 'UNKNOWN_ACCOUNT')).code).toBe('INVALID_ACCOUNT')
  })

  it('never loses a thrown non-Error value', () => {
    const odd = toNearKitError({ weird: true })
    expect(odd.code).toBe('UNKNOWN')
    expect(odd.detail).toContain('weird')
  })
})

describe('classifyFailure: transaction outcome failures', () => {
  const exec = (text: string) => ({ ActionError: { index: 1, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${text}` } } } })

  it('reads contract panics', () => {
    expect(classifyFailure(exec('The account bob.near is not registered')).code).toBe('STORAGE_REQUIRED')
    expect(classifyFailure(exec("The account doesn't have enough balance")).code).toBe('INSUFFICIENT_BALANCE')
    expect(classifyFailure(exec('E68: slippage error')).code).toBe('SLIPPAGE_EXCEEDED')
    expect(classifyFailure(exec('E204: slippage error')).code).toBe('SLIPPAGE_EXCEEDED')
    expect(classifyFailure(exec('something else')).code).toBe('TRANSACTION_FAILED')
  })

  it('reads protocol-level failures', () => {
    expect(classifyFailure({ InvalidTxError: { NotEnoughBalance: { signer_id: 'a.near', balance: '1', cost: '2' } } }).code).toBe('INSUFFICIENT_BALANCE')
    expect(classifyFailure({ InvalidTxError: { LackBalanceForState: { signer_id: 'a.near', amount: '1' } } }).code).toBe('INSUFFICIENT_BALANCE')
    expect(classifyFailure({ ActionError: { index: 0, kind: { AccountDoesNotExist: { account_id: 'ghost.near' } } } }).code).toBe('INVALID_ACCOUNT')
    expect(classifyFailure({ ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Exceeded the prepaid gas.' } } } }).code).toBe('INSUFFICIENT_GAS')
  })

  it('keeps the raw failure as detail', () => {
    const failure = exec('E68: slippage error')
    expect(classifyFailure(failure).detail).toContain('E68')
  })
})
