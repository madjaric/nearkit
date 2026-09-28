import type { NearKitErrorCode, NearKitErrorInfo } from '@/types/operations'
import { RpcError } from './rpc'

export type { NearKitErrorCode, NearKitErrorInfo }

/**
 * Normalized blockchain errors. Everything that can go wrong in a NEAR flow is
 * mapped to one of these codes with a readable message; the original error is
 * kept (`cause`, `detail`) for the expandable diagnostics in the UI. The UI never
 * parses raw RPC or wallet strings itself.
 */
export class NearKitError extends Error {
  readonly code: NearKitErrorCode
  /** Technical detail for diagnostics. Never contains secrets. */
  readonly detail: string | undefined
  override readonly cause: unknown
  constructor(code: NearKitErrorCode, message: string, options: { detail?: string; cause?: unknown } = {}) {
    super(message)
    this.name = 'NearKitError'
    this.code = code
    this.detail = options.detail
    this.cause = options.cause
  }
}

export function errorInfo(error: NearKitError): NearKitErrorInfo {
  return error.detail ? { code: error.code, message: error.message, detail: error.detail } : { code: error.code, message: error.message }
}

// Wording taken from NEAR Connect and the executors in the vendored manifest
// (Meteor: "Action was cancelled"; NEAR Mobile: "Request rejected by user").
const REJECTION =
  /(user|wallet)\s+(rejected|cancel+ed|closed|denied)|wallet closed|closed the window|rejected the (transaction|connection|request)|(action|request) was cancel+ed|(rejected|cancel+ed|denied) by (the )?user/i

function describe(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function toNearKitError(error: unknown, fallback: NearKitErrorCode = 'UNKNOWN'): NearKitError {
  if (error instanceof NearKitError) return error
  const text = describe(error)
  if (REJECTION.test(text)) return new NearKitError('USER_REJECTED', 'You rejected the request in your wallet', { detail: text, cause: error })
  if (error instanceof RpcError) {
    if (error.causeName === 'UNKNOWN_ACCOUNT') return new NearKitError('INVALID_ACCOUNT', 'That account does not exist on this network', { detail: text, cause: error })
    return new NearKitError('RPC_ERROR', 'The NEAR network could not be reached. Try again in a moment.', { detail: text, cause: error })
  }
  return new NearKitError(fallback, fallback === 'UNKNOWN' ? 'Something went wrong' : text, { detail: text, cause: error })
}

/**
 * Classify a transaction or receipt `Failure` value from an execution outcome.
 * Contract panics arrive as `ActionError.kind.FunctionCallError.ExecutionError`.
 */
export function classifyFailure(failure: unknown): NearKitError {
  const detail = describe(failure)
  const make = (code: NearKitErrorCode, message: string) => new NearKitError(code, message, { detail, cause: failure })
  if (/NotEnoughBalance|LackBalanceForState/.test(detail)) return make('INSUFFICIENT_BALANCE', 'Not enough NEAR to pay for this transaction and keep the account’s storage covered')
  if (/AccountDoesNotExist/.test(detail)) return make('INVALID_ACCOUNT', 'A receiving account does not exist on this network')
  if (/panicked: EXPIRED\b/.test(detail)) return make('QUOTE_EXPIRED', 'The quote expired before the swap ran, so it was refunded')
  if (/INVALID_TOKEN_STORAGE/.test(detail)) return make('STORAGE_REQUIRED', 'Rhea’s aggregator needs a storage registration for a token on this route')
  if (/is not registered/.test(detail)) return make('STORAGE_REQUIRED', 'A recipient is not registered with the token contract')
  if (/doesn't have enough balance|does not have enough balance|not enough balance/i.test(detail))
    return make('INSUFFICIENT_BALANCE', 'The token balance was too low when the transaction ran')
  if (/slippage/i.test(detail)) return make('SLIPPAGE_EXCEEDED', 'The price moved beyond your slippage limit, so the swap was refunded')
  if (/prepaid gas|GasExceeded|GasLimitExceeded/i.test(detail)) return make('INSUFFICIENT_GAS', 'The transaction ran out of gas')
  return make('TRANSACTION_FAILED', 'The transaction failed on chain')
}
