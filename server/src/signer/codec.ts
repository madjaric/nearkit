import type { SwapRouteFacts, WalletAction, WalletOperation, WalletTxPlan } from '../custody/policy'

/**
 * Operations and plans as they cross into the signer. Amounts travel as decimal strings.
 * Decoding is strict: an unknown field, a wrong type, a negative or fractional amount,
 * an oversized string: the request is refused before anything else looks at it.
 */

export class BadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}

const bad = (what: string): never => {
  throw new BadRequestError(`malformed request: ${what}`)
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

export function obj(v: unknown, what: string, keys: readonly string[], optional: readonly string[] = []): Obj {
  if (!isObj(v)) return bad(`${what} is not an object`)
  for (const k of Object.keys(v)) if (!keys.includes(k) && !optional.includes(k)) bad(`${what} has an unexpected field ${k}`)
  for (const k of keys) if (!(k in v)) bad(`${what} is missing ${k}`)
  return v
}

export function str(v: unknown, what: string, max = 256): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) return bad(`${what} is not a string of 1 to ${max} characters`)
  return v
}

export function uint(v: unknown, what: string): bigint {
  if (typeof v !== 'string' || !/^(0|[1-9]\d{0,77})$/.test(v)) return bad(`${what} is not a whole number`)
  return BigInt(v)
}

export function int(v: unknown, what: string, max: number): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > max) return bad(`${what} is not a whole number up to ${max}`)
  return v
}

function bool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') return bad(`${what} is not true or false`)
  return v
}

function strings(v: unknown, what: string, maxItems: number, max = 128): string[] {
  if (!Array.isArray(v) || v.length > maxItems) return bad(`${what} is not a list of at most ${maxItems}`)
  return v.map((s, i) => str(s, `${what}[${i}]`, max))
}

// ─── operations ─────────────────────────────────────────────────────────────

export function encodeOp(op: WalletOperation): Obj {
  const s = (b: bigint) => b.toString()
  switch (op.kind) {
    case 'swap': {
      const r = op.route
      return {
        kind: 'swap',
        authorizedMinOut: s(op.authorizedMinOut),
        route: {
          router: r.router,
          routeIn: r.routeIn,
          routeOut: r.routeOut,
          nativeIn: r.nativeIn,
          nativeOut: r.nativeOut,
          amountIn: s(r.amountIn),
          receiver: r.receiver,
          msg: r.msg,
          routeTokens: r.routeTokens,
          minOut: s(r.minOut),
          ...(r.signedMin !== undefined ? { signedMin: s(r.signedMin) } : {}),
          ...(r.pools !== undefined ? { pools: r.pools } : {}),
          ...(r.direct !== undefined ? { direct: { swapAmount: s(r.direct.swapAmount), fee: s(r.direct.fee), feeRecipient: r.direct.feeRecipient } } : {}),
        },
      }
    }
    case 'withdraw-near':
      return { kind: op.kind, to: op.to, amount: s(op.amount) }
    case 'withdraw-token':
      return { kind: op.kind, token: op.token, to: op.to, amount: s(op.amount), registration: op.registration === null ? null : s(op.registration) }
    case 'add-backup-key':
    case 'revoke':
      return { kind: op.kind, publicKey: op.publicKey }
    case 'unwrap':
      return { kind: op.kind, amount: s(op.amount) }
  }
}

const ACCOUNT_MAX = 64
const KEY_MAX = 128
const MSG_MAX = 32_768

export function decodeOp(v: unknown): WalletOperation {
  if (!isObj(v)) return bad('the operation is not an object')
  switch (v.kind) {
    case 'swap': {
      const o = obj(v, 'the swap', ['kind', 'route', 'authorizedMinOut'])
      const r = obj(
        o.route,
        'the route',
        ['router', 'routeIn', 'routeOut', 'nativeIn', 'nativeOut', 'amountIn', 'receiver', 'msg', 'routeTokens', 'minOut'],
        ['signedMin', 'pools', 'direct'],
      )
      if (r.router !== 'classic' && r.router !== 'aggregator' && r.router !== 'dcl') return bad('the router is unknown')
      const direct = r.direct === undefined ? undefined : obj(r.direct, 'the direct route', ['swapAmount', 'fee', 'feeRecipient'])
      const route: SwapRouteFacts = {
        router: r.router,
        routeIn: str(r.routeIn, 'routeIn', ACCOUNT_MAX),
        routeOut: str(r.routeOut, 'routeOut', ACCOUNT_MAX),
        nativeIn: bool(r.nativeIn, 'nativeIn'),
        nativeOut: bool(r.nativeOut, 'nativeOut'),
        amountIn: uint(r.amountIn, 'amountIn'),
        receiver: str(r.receiver, 'receiver', ACCOUNT_MAX),
        msg: str(r.msg, 'msg', MSG_MAX),
        routeTokens: strings(r.routeTokens, 'routeTokens', 8, ACCOUNT_MAX),
        minOut: uint(r.minOut, 'minOut'),
        ...(r.signedMin !== undefined ? { signedMin: uint(r.signedMin, 'signedMin') } : {}),
        ...(r.pools !== undefined ? { pools: strings(r.pools, 'pools', 3, 160) } : {}),
        ...(direct
          ? {
              direct: {
                swapAmount: uint(direct.swapAmount, 'swapAmount'),
                fee: uint(direct.fee, 'fee'),
                feeRecipient: direct.feeRecipient === null ? null : str(direct.feeRecipient, 'feeRecipient', ACCOUNT_MAX),
              },
            }
          : {}),
      }
      return { kind: 'swap', route, authorizedMinOut: uint(o.authorizedMinOut, 'authorizedMinOut') }
    }
    case 'withdraw-near': {
      const o = obj(v, 'the withdrawal', ['kind', 'to', 'amount'])
      return { kind: 'withdraw-near', to: str(o.to, 'to', ACCOUNT_MAX), amount: uint(o.amount, 'amount') }
    }
    case 'withdraw-token': {
      const o = obj(v, 'the withdrawal', ['kind', 'token', 'to', 'amount', 'registration'])
      return {
        kind: 'withdraw-token',
        token: str(o.token, 'token', ACCOUNT_MAX),
        to: str(o.to, 'to', ACCOUNT_MAX),
        amount: uint(o.amount, 'amount'),
        registration: o.registration === null ? null : uint(o.registration, 'registration'),
      }
    }
    case 'add-backup-key':
    case 'revoke': {
      const o = obj(v, 'the key operation', ['kind', 'publicKey'])
      return { kind: v.kind, publicKey: str(o.publicKey, 'publicKey', KEY_MAX) }
    }
    case 'unwrap': {
      const o = obj(v, 'the unwrap', ['kind', 'amount'])
      return { kind: 'unwrap', amount: uint(o.amount, 'amount') }
    }
    default:
      return bad('the operation kind is unknown')
  }
}

// ─── plans ──────────────────────────────────────────────────────────────────

/** A JSON value from a call's arguments: plain data only, bounded in depth and size. */
function plainJson(v: unknown, what: string, depth = 0): unknown {
  if (depth > 6) return bad(`${what} is nested too deeply`)
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : bad(`${what} holds a non-finite number`)
  if (Array.isArray(v)) {
    if (v.length > 64) return bad(`${what} is too long`)
    return v.map((x, i) => plainJson(x, `${what}[${i}]`, depth + 1))
  }
  if (isObj(v)) {
    const keys = Object.keys(v)
    if (keys.length > 32) return bad(`${what} has too many fields`)
    return Object.fromEntries(keys.map((k) => [str(k, `${what} key`, 64), plainJson(v[k], `${what}.${k}`, depth + 1)]))
  }
  return bad(`${what} is not plain data`)
}

function decodeAction(v: unknown, what: string): WalletAction {
  if (!isObj(v)) return bad(`${what} is not an object`)
  switch (v.kind) {
    case 'transfer': {
      const o = obj(v, what, ['kind', 'deposit'])
      return { kind: 'transfer', deposit: uint(o.deposit, `${what} deposit`).toString() }
    }
    case 'call': {
      const o = obj(v, what, ['kind', 'method', 'args', 'gas', 'deposit'])
      if (!isObj(o.args)) return bad(`${what} arguments are not an object`)
      return {
        kind: 'call',
        method: str(o.method, `${what} method`, 64),
        args: plainJson(o.args, `${what} arguments`) as Record<string, unknown>,
        gas: uint(o.gas, `${what} gas`).toString(),
        deposit: uint(o.deposit, `${what} deposit`).toString(),
      }
    }
    case 'add-key':
    case 'delete-key': {
      const o = obj(v, what, ['kind', 'publicKey'])
      return { kind: v.kind, publicKey: str(o.publicKey, `${what} key`, KEY_MAX) }
    }
    default:
      return bad(`${what} kind is unknown`)
  }
}

export function decodePlan(v: unknown): WalletTxPlan[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > 4) return bad('the plan is not a list of 1 to 4 transactions')
  return v.map((t, i) => {
    const o = obj(t, `transaction ${i + 1}`, ['receiverId', 'actions', 'label'])
    if (!Array.isArray(o.actions) || o.actions.length === 0 || o.actions.length > 4) return bad(`transaction ${i + 1} does not have 1 to 4 actions`)
    return {
      receiverId: str(o.receiverId, `transaction ${i + 1} receiver`, ACCOUNT_MAX),
      actions: o.actions.map((a, j) => decodeAction(a, `transaction ${i + 1} action ${j + 1}`)),
      label: typeof o.label === 'string' ? o.label.slice(0, 120) : bad(`transaction ${i + 1} label`),
    }
  })
}
