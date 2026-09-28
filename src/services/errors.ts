import { NearKitError } from './near/errors'
import { ServiceError } from './mock/state'

/**
 * UI-safe view of any service error: a readable message, an optional code and
 * technical detail for the diagnostics disclosure. Components use this instead
 * of inspecting raw RPC, wallet or contract errors.
 */
export interface ErrorView {
  code: string | null
  message: string
  detail: string | null
}

export function describeError(error: unknown): ErrorView {
  if (error instanceof NearKitError) return { code: error.code, message: error.message, detail: error.detail ?? null }
  if (error instanceof ServiceError) return { code: error.code, message: error.message, detail: null }
  if (error instanceof Error) return { code: null, message: error.message || 'Something went wrong', detail: null }
  return { code: null, message: 'Something went wrong', detail: typeof error === 'string' ? error : null }
}
