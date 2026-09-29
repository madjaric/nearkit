import { base58Encode } from '@/lib/encoding'
import type { SealedExport } from '@/lib/exportCrypto'
import type { ChallengeView, SignerCore, SignerMethod } from '../signer/core'
import { encodeOp } from '../signer/codec'
import { SignerUnavailableError } from '../signer/errors'
import type { WalletOperation, WalletTxPlan } from './policy'
import type { TradingWallet } from './store'

/**
 * The app's side of NearKit's signer (signer/core.ts). The app never holds a wallet key:
 * it asks the signer for typed things (a new key bound to its owner, one signature of one
 * planned step, an owner-signed export or approval) and the signer decides. The transport
 * is the signer service over authenticated HTTP in production (signer/client.ts), or the
 * same core in this process on testnet; either way requests and answers cross as JSON,
 * validated on arrival.
 */

export interface SignerTransport {
  call(method: SignerMethod, body: Record<string, unknown>): Promise<unknown>
}

export interface SignRequest {
  wallet: Pick<TradingWallet, 'accountId' | 'network'>
  /** The intent and the step of its plan: the signer signs each (intent, step) once, ever. */
  intentId: string
  step: number
  op: WalletOperation
  plan: readonly WalletTxPlan[]
  nonce: bigint
  blockHash: Uint8Array
}

export interface SignedTx {
  hash: string
  base64: string
}

export interface OwnerProof {
  challengeId: string
  /** The owner wallet's key that signed (NEP-413). */
  publicKey: string
  signature: string
}

export type ChallengeRequest =
  { kind: 'owner-session'; owner: string } | { kind: 'export'; accountId: string; recipientKey: string } | { kind: 'approve-destination'; accountId: string; destination: string }

export interface SignerHealth {
  ok: boolean
  paused: boolean
  network: string
  keyRef: string
  kek: string
  db: string
}

export interface TradingSigner {
  createKey(req: { userId: number; owner: { accountId: string; publicKey: string } }): Promise<{ accountId: string; publicKey: string; keyRef: string }>
  sign(req: SignRequest): Promise<SignedTx>
  /** Erases the signer's copy once the chain shows it controls nothing: a never-funded wallet, or NearKit's key removed. */
  eraseKey(req: { accountId: string; reason: 'deleted' | 'revoked' }): Promise<boolean>
  keyInfo(accountId: string): Promise<{ held: boolean; publicKey: string | null; ownerAccount: string | null; keyRef: string | null }>
  challenge(req: ChallengeRequest): Promise<ChallengeView>
  ownerWallets(proof: OwnerProof): Promise<{ ownerAccount: string; wallets: { accountId: string; publicKey: string; createdAt: number }[] }>
  approveDestination(proof: OwnerProof): Promise<{ accountId: string; destination: string; approvedAt: number }>
  revokeDestination(req: { accountId: string; destination: string }): Promise<boolean>
  destinations(accountId: string): Promise<{ ownerAccount: string | null; destinations: { destination: string; approvedAt: number }[] }>
  /** The key, sealed to the browser key the owner signed for: the app can't open it. */
  exportKey(proof: OwnerProof): Promise<{ accountId: string; publicKey: string; sealed: SealedExport }>
  /** Pausing only stops things, so the app may ask for it; only the signer's operator resumes. */
  pause(reason: string): Promise<void>
  health(): Promise<SignerHealth>
}

/** The same core in this process (testnet). Requests and answers are copied as JSON, as over the wire. */
export function inProcessTransport(core: SignerCore): SignerTransport {
  const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
  return { call: async (method, body) => copy(await core.handle(method, copy(body))) }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function answer<T>(v: unknown, keys: readonly string[]): T {
  if (!isObj(v) || keys.some((k) => !(k in v))) throw new SignerUnavailableError('The signer answered something unexpected')
  return v as T
}

export function createSignerClient(transport: SignerTransport): TradingSigner {
  const call = (method: SignerMethod, body: Record<string, unknown>) => transport.call(method, body)
  return {
    async createKey(req) {
      const r = answer<{ accountId: string; publicKey: string; keyRef: string }>(await call('create-key', { owner: req.owner, userId: req.userId }), [
        'accountId',
        'publicKey',
        'keyRef',
      ])
      return { accountId: String(r.accountId), publicKey: String(r.publicKey), keyRef: String(r.keyRef) }
    },
    async sign(req) {
      const r = answer<{ hash: string; signed: string }>(
        await call('sign', {
          accountId: req.wallet.accountId,
          intentId: req.intentId,
          step: req.step,
          op: encodeOp(req.op),
          plan: req.plan.map((t) => ({ receiverId: t.receiverId, actions: t.actions, label: t.label })),
          nonce: req.nonce.toString(),
          blockHash: base58Encode(req.blockHash),
        }),
        ['hash', 'signed'],
      )
      if (typeof r.hash !== 'string' || typeof r.signed !== 'string') throw new SignerUnavailableError('The signer answered something unexpected')
      return { hash: r.hash, base64: r.signed }
    },
    async eraseKey(req) {
      return Boolean(answer<{ erased: boolean }>(await call('erase-key', { ...req }), ['erased']).erased)
    },
    async keyInfo(accountId) {
      return answer(await call('key-info', { accountId }), ['held', 'publicKey', 'ownerAccount', 'keyRef'])
    },
    async challenge(req) {
      return answer<ChallengeView & Record<string, unknown>>(await call('challenge', { ...req }), ['id', 'kind', 'message', 'nonce', 'recipient', 'expiresAt', 'ownerAccount'])
    },
    async ownerWallets(proof) {
      return answer(await call('owner-wallets', { ...proof }), ['ownerAccount', 'wallets'])
    },
    async approveDestination(proof) {
      return answer(await call('approve-destination', { ...proof }), ['accountId', 'destination', 'approvedAt'])
    },
    async revokeDestination(req) {
      return Boolean(answer<{ revoked: boolean }>(await call('revoke-destination', { ...req }), ['revoked']).revoked)
    },
    async destinations(accountId) {
      return answer(await call('destinations', { accountId }), ['ownerAccount', 'destinations'])
    },
    async exportKey(proof) {
      return answer(await call('export', { ...proof }), ['accountId', 'publicKey', 'sealed'])
    },
    async pause(reason) {
      await call('pause', { reason })
    },
    async health() {
      return answer(await call('health', {}), ['ok', 'paused', 'network', 'keyRef', 'kek', 'db'])
    },
  }
}
