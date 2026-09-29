import type { NetworkConfig } from '@/config/networks'
import { base58Encode, base64Encode } from '@/lib/encoding'
import {
  deserializeSignedTransaction,
  jsonArgs,
  serializeSignedTransaction,
  serializeTransaction,
  transactionDigest,
  type NearTransaction,
  type TxAction,
} from '@/services/near/transaction'
import { generateKey, implicitAccountId, nearPublicKey, publicKeyOf, secretKeyText, signWithSeed } from './keys'
import { checkPlan, PolicyViolation, type WalletAction, type WalletOperation, type WalletTxPlan } from './policy'
import type { CustodyStore, TradingWallet } from './store'
import { KeyUnavailableError, openSecret, parseSealed, sealSecret, type KeyWrapper } from './vault'

/**
 * The only code that opens a trading-wallet key. It has no "sign these bytes"
 * entry point: `sign` takes a typed operation with its planned transactions,
 * runs the policy over the whole plan, builds the transaction itself, opens the
 * key just long enough to sign, reads the signed bytes back and compares them to
 * the plan. A KMS-backed signer implements the same interface.
 */

export interface SignRequest {
  wallet: TradingWallet
  op: WalletOperation
  plan: readonly WalletTxPlan[]
  /** Which transaction of the plan to sign. */
  index: number
  nonce: bigint
  blockHash: Uint8Array
}

export interface SignedTx {
  hash: string
  base64: string
}

export interface TradingSigner {
  /** KEK reference new wallets are sealed with. */
  readonly keyRef: string
  createKey(network: string): Promise<{ accountId: string; publicKey: string; sealedKey: string }>
  sign(req: SignRequest): Promise<SignedTx>
  /**
   * Recovery export only. `codeHash` names a request the recovery service already
   * verified with the owner's wallet signature; each request exports once.
   */
  exportSecret(wallet: TradingWallet, codeHash: string): Promise<string>
}

/** Additional data both encryption layers are bound to. */
export const walletAad = (network: string, accountId: string) => `${network}:${accountId}`

/** A verified export request must be used within this long. */
export const EXPORT_WINDOW_MS = 5 * 60_000

export function toTxActions(actions: readonly WalletAction[]): TxAction[] {
  return actions.map((a): TxAction => {
    switch (a.kind) {
      case 'transfer':
        return { type: 'Transfer', deposit: BigInt(a.deposit) }
      case 'call':
        return { type: 'FunctionCall', methodName: a.method, args: jsonArgs(a.args), gas: BigInt(a.gas), deposit: BigInt(a.deposit) }
      case 'add-key':
        return { type: 'AddKey', publicKey: a.publicKey, permission: 'FullAccess' }
      case 'delete-key':
        return { type: 'DeleteKey', publicKey: a.publicKey }
    }
  })
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

function sameAction(a: TxAction, b: TxAction): boolean {
  if (a.type !== b.type) return false
  switch (a.type) {
    case 'Transfer':
      return a.deposit === (b as typeof a).deposit
    case 'FunctionCall': {
      const o = b as typeof a
      return a.methodName === o.methodName && sameBytes(a.args, o.args) && a.gas === o.gas && a.deposit === o.deposit
    }
    case 'AddKey': {
      const o = b as typeof a
      return a.publicKey === o.publicKey && a.permission === 'FullAccess' && o.permission === 'FullAccess'
    }
    case 'DeleteKey':
      return a.publicKey === (b as typeof a).publicKey
  }
}

function sameTransaction(a: NearTransaction, b: NearTransaction): boolean {
  return (
    a.signerId === b.signerId &&
    a.publicKey === b.publicKey &&
    a.nonce === b.nonce &&
    a.receiverId === b.receiverId &&
    sameBytes(a.blockHash, b.blockHash) &&
    a.actions.length === b.actions.length &&
    a.actions.every((x, i) => sameAction(x, b.actions[i] as TxAction))
  )
}

export function createLocalSigner(deps: { wrapper: KeyWrapper; network: NetworkConfig; store: CustodyStore; now?: () => number }): TradingSigner {
  const { wrapper, network, store } = deps
  const now = deps.now ?? Date.now

  async function withSeed<T>(wallet: TradingWallet, act: (seed: Buffer) => T): Promise<T> {
    if (wallet.status !== 'active' || !wallet.sealedKey) throw new KeyUnavailableError('This NearKit wallet is closed; NearKit no longer holds its key')
    const seed = await openSecret(wrapper, parseSealed(wallet.sealedKey), walletAad(wallet.network, wallet.accountId))
    try {
      // The stored key must be the one on record for this wallet.
      if (nearPublicKey(publicKeyOf(seed)) !== wallet.publicKey) throw new KeyUnavailableError('The stored key does not match this wallet')
      return act(seed)
    } finally {
      seed.fill(0)
    }
  }

  return {
    keyRef: wrapper.ref,

    async createKey(net) {
      const key = generateKey()
      try {
        const accountId = implicitAccountId(key.publicKey)
        const sealed = await sealSecret(wrapper, key.seed, walletAad(net, accountId))
        return { accountId, publicKey: nearPublicKey(key.publicKey), sealedKey: JSON.stringify(sealed) }
      } finally {
        key.seed.fill(0)
      }
    },

    async sign(req) {
      const { wallet, op, plan, index } = req
      const planned = plan[index]
      try {
        if (!planned) throw new PolicyViolation('there is no such transaction in the plan')
        checkPlan(op, plan, { accountId: wallet.accountId, publicKey: wallet.publicKey, network: wallet.network }, network)
      } catch (e) {
        if (e instanceof PolicyViolation) store.audit({ userId: wallet.userId, walletId: wallet.id, action: 'policy-refused', detail: { op: op.kind, reason: e.message } })
        throw e
      }
      const tx: NearTransaction = {
        signerId: wallet.accountId,
        publicKey: wallet.publicKey,
        nonce: req.nonce,
        receiverId: (planned as WalletTxPlan).receiverId,
        blockHash: req.blockHash,
        actions: toTxActions((planned as WalletTxPlan).actions),
      }
      const digest = await transactionDigest(serializeTransaction(tx))
      const signature = await withSeed(wallet, (seed) => signWithSeed(seed, digest))
      const signed = serializeSignedTransaction(tx, signature)
      // What goes out is read back and must be exactly the planned transaction.
      const read = deserializeSignedTransaction(signed)
      if (!sameTransaction(read.transaction, tx)) throw new PolicyViolation('the signed transaction differs from the plan')
      return { hash: base58Encode(digest), base64: base64Encode(signed) }
    },

    async exportSecret(wallet, codeHash) {
      const req = store.recovery(codeHash)
      const fresh = req?.verifiedAt !== null && req?.verifiedAt !== undefined && now() - req.verifiedAt <= EXPORT_WINDOW_MS
      // Verified by the owner wallet itself: the recovery service checked its signature and key.
      const byOwner = wallet.ownerAccount !== null && req?.verifiedAccount === wallet.ownerAccount
      if (!req || req.walletId !== wallet.id || req.userId !== wallet.userId || !fresh || !byOwner) {
        store.audit({
          userId: wallet.userId,
          walletId: wallet.id,
          action: 'export-refused',
          detail: { reason: fresh && !byOwner ? 'not verified by the owner' : 'no verified request' },
        })
        throw new KeyUnavailableError('Export needs a fresh request verified with your owner wallet')
      }
      if (!store.markExported(codeHash)) throw new KeyUnavailableError('This export request was already used')
      const secret = await withSeed(wallet, (seed) => secretKeyText(seed))
      store.audit({ userId: wallet.userId, walletId: wallet.id, action: 'key-exported', detail: { verifiedBy: req.verifiedAccount } })
      return secret
    },
  }
}
