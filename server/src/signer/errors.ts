import { PolicyViolation } from '../custody/policy'
import { KeyUnavailableError } from '../custody/vault'
import { ChainUncertainError } from './chain'
import { BadRequestError } from './codec'
import { KmsUnavailableError } from './kms'

/**
 * Everything the signer refuses with, as the same classes on both sides of the wire: the
 * signer service answers `{ error: { code, message } }` and the app's client throws the
 * class for that code again. Messages are plain sentences for the user; none carries a
 * secret.
 */

/** A withdrawal to a destination the wallet's owner has not approved (and that is not the owner itself). */
export class DestinationNotApprovedError extends PolicyViolation {
  constructor(readonly destination: string) {
    super(`${destination} is not an approved destination for this wallet: approve it with your owner wallet first`)
    this.name = 'DestinationNotApprovedError'
  }
}

/** The signer is paused (kill switch): nothing is signed, exported, approved or erased. */
export class SignerPausedError extends Error {
  constructor(message = 'NEARKITS’ signer is paused. Nothing was signed.') {
    super(message)
    this.name = 'SignerPausedError'
  }
}

/** This step of this intent was already signed as a different transaction: never a second one. */
export class AlreadySignedError extends Error {
  constructor(message = 'This step was already signed as another transaction. Nothing new was signed.') {
    super(message)
    this.name = 'AlreadySignedError'
  }
}

export type ChallengeProblem =
  | 'unknown'
  | 'expired'
  | 'used'
  | 'locked'
  | 'bad-signature'
  | 'not-owner'
  | 'rate-limited'
  | 'wallet'
  /** A Telegram approval for a wallet that has an owner wallet (its owner approves instead). */
  | 'owned'
  /** A Telegram approval by another account than the one that controls the wallet. */
  | 'not-controller'
  /** A Telegram approval opened outside its request's lifetime. */
  | 'stale'
  /** This signer can't check Telegram's signature (not configured). */
  | 'telegram-off'

/** An owner-signed request that doesn't hold up. */
export class ChallengeError extends Error {
  constructor(
    readonly problem: ChallengeProblem,
    message: string,
  ) {
    super(message)
    this.name = 'ChallengeError'
  }
}

/** The signer service could not be reached or answered nonsense: nothing is known to have happened. */
export class SignerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SignerUnavailableError'
  }
}

export type SignerErrorCode = 'destination' | 'policy' | 'paused' | 'already-signed' | 'key' | 'kms' | 'chain' | 'bad-request' | `challenge:${ChallengeProblem}` | 'internal'

export function errorToWire(e: unknown): { status: number; code: SignerErrorCode; message: string; detail?: string } {
  if (e instanceof DestinationNotApprovedError) return { status: 403, code: 'destination', message: e.message, detail: e.destination }
  if (e instanceof PolicyViolation) return { status: 403, code: 'policy', message: e.message }
  if (e instanceof SignerPausedError) return { status: 503, code: 'paused', message: e.message }
  if (e instanceof AlreadySignedError) return { status: 409, code: 'already-signed', message: e.message }
  if (e instanceof KeyUnavailableError) return { status: 410, code: 'key', message: e.message }
  if (e instanceof KmsUnavailableError) return { status: 503, code: 'kms', message: e.message }
  if (e instanceof ChainUncertainError) return { status: 503, code: 'chain', message: e.message }
  if (e instanceof BadRequestError) return { status: 400, code: 'bad-request', message: e.message }
  if (e instanceof ChallengeError) return { status: e.problem === 'rate-limited' ? 429 : 403, code: `challenge:${e.problem}`, message: e.message }
  return { status: 500, code: 'internal', message: 'The signer failed. Nothing was signed.' }
}

export function errorFromWire(code: string, message: string, detail?: string): Error {
  if (code === 'destination') return new DestinationNotApprovedError(detail ?? 'that destination')
  if (code === 'policy') return new PolicyViolation(message.replace(/^(?:NearKit|NEARKITS) refused to sign: /, ''))
  if (code === 'paused') return new SignerPausedError(message)
  if (code === 'already-signed') return new AlreadySignedError(message)
  if (code === 'key') return new KeyUnavailableError(message)
  if (code === 'kms') return new KmsUnavailableError(message)
  if (code === 'chain') return new ChainUncertainError(message)
  if (code === 'bad-request') return new BadRequestError(message.replace(/^malformed request: /, ''))
  if (code.startsWith('challenge:')) return new ChallengeError(code.slice('challenge:'.length) as ChallengeProblem, message)
  return new SignerUnavailableError(message || 'The signer failed')
}
