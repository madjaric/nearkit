import { base58Encode } from '@/lib/encoding'
import { parseEd25519PublicKey } from './nep413'

/**
 * NEAR transactions in their wire format (borsh, nearcore `Transaction` V0 and
 * `SignedTransaction`), for the NearKit trading-wallet signer on the server and
 * the fake chain in tests. Only the actions NearKit's own operations use exist
 * here: Transfer, FunctionCall, AddKey and DeleteKey. Anything else can be
 * neither built nor read, so it can never be signed by accident.
 *
 * The signature covers SHA-256 of `serializeTransaction(tx)`; that digest in
 * base58 is the transaction hash.
 */

export type KeyPermission = 'FullAccess' | { receiverId: string; methodNames: string[]; allowance: bigint | null }

export type TxAction =
  | { type: 'Transfer'; deposit: bigint }
  | { type: 'FunctionCall'; methodName: string; args: Uint8Array; gas: bigint; deposit: bigint }
  | { type: 'AddKey'; publicKey: string; permission: KeyPermission }
  | { type: 'DeleteKey'; publicKey: string }

export interface NearTransaction {
  signerId: string
  /** `ed25519:<base58>`, the key that signs. */
  publicKey: string
  nonce: bigint
  receiverId: string
  /** 32 bytes: the block the transaction is anchored to. It expires a fixed number of blocks after it. */
  blockHash: Uint8Array
  actions: TxAction[]
}

export class TransactionFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransactionFormatError'
  }
}

const U64_MAX = 2n ** 64n - 1n
const U128_MAX = 2n ** 128n - 1n
/** nearcore `Action` variant indexes. */
const ACTION = { FunctionCall: 2, Transfer: 3, AddKey: 5, DeleteKey: 6 } as const
const ED25519 = 0

class Writer {
  private readonly out: number[] = []
  u8(v: number) {
    this.out.push(v & 0xff)
  }
  u32(v: number) {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new TransactionFormatError(`u32 out of range: ${v}`)
    for (let i = 0; i < 4; i++) this.out.push((v >>> (8 * i)) & 0xff)
  }
  uint(v: bigint, bytes: number, max: bigint) {
    if (v < 0n || v > max) throw new TransactionFormatError(`integer out of range: ${v}`)
    let x = v
    for (let i = 0; i < bytes; i++) {
      this.out.push(Number(x & 0xffn))
      x >>= 8n
    }
  }
  fixed(b: Uint8Array) {
    for (const x of b) this.out.push(x)
  }
  vec(b: Uint8Array) {
    this.u32(b.length)
    this.fixed(b)
  }
  string(s: string) {
    this.vec(new TextEncoder().encode(s))
  }
  bytes(): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(this.out)
  }
}

class Reader {
  private offset = 0
  constructor(private readonly buf: Uint8Array) {}
  private need(n: number) {
    if (this.offset + n > this.buf.length) throw new TransactionFormatError('Transaction bytes end too early')
  }
  get position() {
    return this.offset
  }
  u8(): number {
    this.need(1)
    return this.buf[this.offset++] as number
  }
  u32(): number {
    this.need(4)
    let v = 0
    for (let i = 3; i >= 0; i--) v = v * 256 + (this.buf[this.offset + i] as number)
    this.offset += 4
    return v
  }
  uint(bytes: number): bigint {
    this.need(bytes)
    let v = 0n
    for (let i = bytes - 1; i >= 0; i--) v = (v << 8n) | BigInt(this.buf[this.offset + i] as number)
    this.offset += bytes
    return v
  }
  fixed(n: number): Uint8Array<ArrayBuffer> {
    this.need(n)
    const out = Uint8Array.from(this.buf.subarray(this.offset, this.offset + n))
    this.offset += n
    return out
  }
  vec(): Uint8Array<ArrayBuffer> {
    return this.fixed(this.u32())
  }
  string(): string {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(this.vec())
    } catch (e) {
      if (e instanceof TransactionFormatError) throw e
      throw new TransactionFormatError('A string in the transaction is not UTF-8')
    }
  }
  end() {
    if (this.offset !== this.buf.length) throw new TransactionFormatError('Unexpected bytes after the transaction')
  }
}

function writeKey(w: Writer, key: string) {
  const raw = parseEd25519PublicKey(key)
  if (!raw) throw new TransactionFormatError(`Only ed25519 public keys are supported, got ${key.slice(0, 12)}…`)
  w.u8(ED25519)
  w.fixed(raw)
}

function readKey(r: Reader): string {
  const type = r.u8()
  if (type !== ED25519) throw new TransactionFormatError(`Unsupported key type ${type}`)
  return `ed25519:${base58Encode(r.fixed(32))}`
}

function writeAction(w: Writer, a: TxAction) {
  switch (a.type) {
    case 'FunctionCall':
      w.u8(ACTION.FunctionCall)
      w.string(a.methodName)
      w.vec(a.args)
      w.uint(a.gas, 8, U64_MAX)
      w.uint(a.deposit, 16, U128_MAX)
      return
    case 'Transfer':
      w.u8(ACTION.Transfer)
      w.uint(a.deposit, 16, U128_MAX)
      return
    case 'AddKey':
      w.u8(ACTION.AddKey)
      writeKey(w, a.publicKey)
      // AccessKey { nonce, permission }: the runtime sets the new key's nonce itself.
      w.uint(0n, 8, U64_MAX)
      if (a.permission === 'FullAccess') {
        w.u8(1)
      } else {
        w.u8(0)
        if (a.permission.allowance === null) w.u8(0)
        else {
          w.u8(1)
          w.uint(a.permission.allowance, 16, U128_MAX)
        }
        w.string(a.permission.receiverId)
        w.u32(a.permission.methodNames.length)
        for (const m of a.permission.methodNames) w.string(m)
      }
      return
    case 'DeleteKey':
      w.u8(ACTION.DeleteKey)
      writeKey(w, a.publicKey)
      return
  }
}

function readAction(r: Reader): TxAction {
  const tag = r.u8()
  switch (tag) {
    case ACTION.FunctionCall:
      return { type: 'FunctionCall', methodName: r.string(), args: r.vec(), gas: r.uint(8), deposit: r.uint(16) }
    case ACTION.Transfer:
      return { type: 'Transfer', deposit: r.uint(16) }
    case ACTION.AddKey: {
      const publicKey = readKey(r)
      r.uint(8)
      const perm = r.u8()
      if (perm === 1) return { type: 'AddKey', publicKey, permission: 'FullAccess' }
      if (perm !== 0) throw new TransactionFormatError(`Unknown access key permission ${perm}`)
      const hasAllowance = r.u8()
      const allowance = hasAllowance === 1 ? r.uint(16) : null
      const receiverId = r.string()
      const count = r.u32()
      const methodNames: string[] = []
      for (let i = 0; i < count; i++) methodNames.push(r.string())
      return { type: 'AddKey', publicKey, permission: { receiverId, methodNames, allowance } }
    }
    case ACTION.DeleteKey:
      return { type: 'DeleteKey', publicKey: readKey(r) }
    default:
      throw new TransactionFormatError(`Action type ${tag} is not one NearKit builds`)
  }
}

export function serializeTransaction(tx: NearTransaction): Uint8Array<ArrayBuffer> {
  if (tx.blockHash.length !== 32) throw new TransactionFormatError('A block hash is 32 bytes')
  if (tx.actions.length === 0) throw new TransactionFormatError('A transaction needs at least one action')
  const w = new Writer()
  w.string(tx.signerId)
  writeKey(w, tx.publicKey)
  w.uint(tx.nonce, 8, U64_MAX)
  w.string(tx.receiverId)
  w.fixed(tx.blockHash)
  w.u32(tx.actions.length)
  for (const a of tx.actions) writeAction(w, a)
  return w.bytes()
}

function readTransaction(r: Reader): NearTransaction {
  const signerId = r.string()
  const publicKey = readKey(r)
  const nonce = r.uint(8)
  const receiverId = r.string()
  const blockHash = r.fixed(32)
  const count = r.u32()
  if (count > 100) throw new TransactionFormatError(`Too many actions: ${count}`)
  const actions: TxAction[] = []
  for (let i = 0; i < count; i++) actions.push(readAction(r))
  return { signerId, publicKey, nonce, receiverId, blockHash, actions }
}

export function deserializeTransaction(bytes: Uint8Array): NearTransaction {
  const r = new Reader(bytes)
  const tx = readTransaction(r)
  r.end()
  return tx
}

/** Transaction bytes followed by the ed25519 signature (64 bytes). */
export function serializeSignedTransaction(tx: NearTransaction, signature: Uint8Array): Uint8Array<ArrayBuffer> {
  if (signature.length !== 64) throw new TransactionFormatError('An ed25519 signature is 64 bytes')
  const body = serializeTransaction(tx)
  const out = new Uint8Array(body.length + 65)
  out.set(body, 0)
  out[body.length] = ED25519
  out.set(signature, body.length + 1)
  return out
}

export function deserializeSignedTransaction(bytes: Uint8Array): { transaction: NearTransaction; signature: Uint8Array<ArrayBuffer>; transactionBytes: Uint8Array<ArrayBuffer> } {
  const r = new Reader(bytes)
  const transaction = readTransaction(r)
  const transactionBytes = Uint8Array.from(bytes.subarray(0, r.position))
  const type = r.u8()
  if (type !== ED25519) throw new TransactionFormatError(`Unsupported signature type ${type}`)
  const signature = r.fixed(64)
  r.end()
  return { transaction, signature, transactionBytes }
}

/** SHA-256 of the transaction bytes: what the key signs, and (in base58) the transaction hash. */
export async function transactionDigest(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))
}

export async function transactionHash(tx: NearTransaction): Promise<string> {
  return base58Encode(await transactionDigest(serializeTransaction(tx)))
}

/** Function-call arguments as the chain stores them: the JSON text, UTF-8. */
export const jsonArgs = (args: Record<string, unknown>): Uint8Array<ArrayBuffer> => new TextEncoder().encode(JSON.stringify(args))
