import type { NetworkConfig } from '@/config/networks'
import { base58Decode, base58Encode, base64Decode, base64Encode } from '@/lib/encoding'
import { exportKeyFingerprint, sealExport } from '@/lib/exportCrypto'
import { accountKind, isForeignToNetwork } from '@/lib/validation'
import { parseEd25519PublicKey, verifyNep413 } from '@/services/near/nep413'
import { deserializeSignedTransaction, serializeSignedTransaction, serializeTransaction, transactionDigest, type NearTransaction } from '@/services/near/transaction'
import { generateKey, implicitAccountId, nearPublicKey, secretKeyText, signWithSeed } from '../custody/keys'
import { checkPlan, PolicyViolation, type WalletOperation, type WalletTxPlan } from '../custody/policy'
import { KeyUnavailableError, type Keyring } from '../custody/vault'
import { randomBytesArray, randomToken } from '../ids'
import { silentLogger, type Logger } from '../log'
import type { SignerChain } from './chain'
import { BadRequestError, decodeOp, decodePlan, int, obj, str, uint } from './codec'
import { openWalletKey, sealWalletKey } from './envelope'
import { AlreadySignedError, ChallengeError, DestinationNotApprovedError, SignerPausedError } from './errors'
import { probeKek } from './kms'
import { challengeMessage, readMessage } from './messages'
import { verifySwapRoute, type RouteOracle } from './routes'
import type { Challenge, ChallengeKind, SignerKey, SignerStore } from './store'
import { sameTransaction, toTxActions } from './tx'

/**
 * NearKit's signer: the only code that opens a NearKit wallet key. It runs as its own
 * service in production (signer/http.ts), holds no Telegram token and no app database
 * credentials, and decides everything itself:
 *
 * - Keys: made here, sealed at once with the owner bound into the sealing (v2 envelope),
 *   the KEK in a KMS. A key is open only for the one signature or export it serves.
 * - Signing: only typed operations with their planned transactions. The policy runs here
 *   over the whole plan (receivers, methods, arguments, deposits, gas, action count), and
 *   so do the checks that need facts the app can't vouch for: a withdrawal goes only to the
 *   owner wallet or a destination the owner approved with a signature (re-verified at every
 *   use); a backup key must be a full-access key of the owner on chain; a swap's route is
 *   verified against Rhea's signature, NearKit's fee account and the signer's own price
 *   quote. Each (intent, step) is signed as one transaction, ever.
 * - Owner requests (list my wallets, export, approve a destination): a one-time message
 *   written here, signed by a full-access key of the owner wallet (checked on chain by a
 *   quorum of RPC providers), within minutes, once. An export is sealed to the browser key
 *   named in the signed message: nothing in between sees the key.
 * - A pause switch refuses all of that at once (fail closed); health says why.
 */

export interface SignerConfig {
  network: NetworkConfig
  /** The one account NearKit's fee may go to on this network (the canonical one on mainnet), or null where no fee is charged. */
  feeRecipient: string | null
  /** NEP-413 recipient every owner signature must name: the NearKit web app's host. */
  recipient: string
  /** The most a swap's minimum may sit below the signer's own quote, in parts per million. */
  maxSlippagePpm: number
  /** How long an owner request (challenge) stays valid. */
  challengeTtlMs?: number
  /** The host's own pause switch (environment or file), checked on every request. */
  pausedByHost?: () => boolean
}

export interface SignerDeps {
  store: SignerStore
  keys: Keyring
  chain: SignerChain
  oracle: RouteOracle
  config: SignerConfig
  now?: () => number
  log?: Logger
}

export const CHALLENGE_TTL_MS = 5 * 60_000
export const MAX_CHALLENGE_ATTEMPTS = 5
const CHALLENGES_PER_WINDOW = 20
const CHALLENGE_WINDOW_MS = 10 * 60_000
const HEALTH_CACHE_MS = 60_000

export interface ChallengeView {
  id: string
  kind: ChallengeKind
  message: string
  nonce: string
  recipient: string
  expiresAt: number
  ownerAccount: string
  accountId: string | null
  destination: string | null
}

const viewOf = (c: Challenge): ChallengeView => ({
  id: c.id,
  kind: c.kind,
  message: c.message,
  nonce: c.nonce,
  recipient: c.recipient,
  expiresAt: c.expiresAt,
  ownerAccount: c.ownerAccount,
  accountId: c.accountId,
  destination: c.destination,
})

export type SignerMethod =
  'create-key' | 'sign' | 'erase-key' | 'key-info' | 'challenge' | 'owner-wallets' | 'approve-destination' | 'revoke-destination' | 'destinations' | 'export' | 'pause' | 'health'

export const SIGNER_METHODS: readonly SignerMethod[] = [
  'create-key',
  'sign',
  'erase-key',
  'key-info',
  'challenge',
  'owner-wallets',
  'approve-destination',
  'revoke-destination',
  'destinations',
  'export',
  'pause',
  'health',
]

export function createSignerCore(deps: SignerDeps) {
  const { store, keys, chain, oracle, config } = deps
  const network = config.network
  const now = deps.now ?? Date.now
  const log = deps.log ?? silentLogger
  const ttl = config.challengeTtlMs ?? CHALLENGE_TTL_MS
  let health: { at: number; kek: string } | null = null

  async function paused(): Promise<boolean> {
    return (config.pausedByHost?.() ?? false) || (await store.getState('paused')) === 'true'
  }

  async function open(): Promise<void> {
    if (await paused()) throw new SignerPausedError()
  }

  function account(v: unknown, what: string): string {
    const id = str(v, what, 64)
    if (!accountKind(id)) throw new BadRequestError(`malformed request: ${what} is not a NEAR account`)
    if (isForeignToNetwork(id, network.id)) throw new BadRequestError(`malformed request: ${what} belongs to another network than ${network.id}`)
    return id
  }

  async function liveKey(accountId: string): Promise<SignerKey> {
    const key = await store.key(network.id, accountId)
    if (!key || key.status !== 'active' || !key.sealedKey) throw new KeyUnavailableError('This NearKit wallet is closed or unknown; NearKit holds no key for it')
    return key
  }

  async function withSeed<T>(key: SignerKey, act: (seed: Buffer) => T): Promise<T> {
    const seed = await openWalletKey(keys, key.sealedKey as string, { network: key.network, accountId: key.accountId, publicKey: key.publicKey, owner: key.ownerAccount })
    try {
      return act(seed)
    } finally {
      seed.fill(0)
    }
  }

  // ─── authorization of what a plan does ────────────────────────────────────

  /** The owner's approval of a destination, re-verified in full: every field, the signature, and the approving key on chain today. */
  async function approvalHolds(key: SignerKey, destination: string): Promise<boolean> {
    const d = await store.liveDestination(network.id, key.accountId, destination)
    if (!d || !key.ownerAccount || d.ownerAccount !== key.ownerAccount || d.recipient !== config.recipient) return false
    const read = readMessage(d.message)
    const f = read?.fields
    if (
      read?.kind !== 'approve-destination' ||
      f?.['NearKit wallet'] !== key.accountId ||
      f['Destination'] !== destination ||
      f['Owner wallet'] !== key.ownerAccount ||
      f['Network'] !== network.id ||
      f['Request'] !== d.challengeId
    )
      return false
    const nonce = base64Decode(d.nonce)
    if (!nonce || nonce.length !== 32 || !(await verifyNep413({ message: d.message, nonce, recipient: d.recipient }, d.publicKey, d.signature))) return false
    return (await chain.permission(key.ownerAccount, d.publicKey)) === 'full'
  }

  async function authorize(key: SignerKey, op: WalletOperation, plan: readonly WalletTxPlan[], step: number): Promise<void> {
    switch (op.kind) {
      case 'withdraw-near':
      case 'withdraw-token':
        if (key.ownerAccount && op.to === key.ownerAccount) return
        if (!(await approvalHolds(key, op.to))) throw new DestinationNotApprovedError(op.to)
        return
      case 'add-backup-key':
        if (!key.ownerAccount) throw new PolicyViolation('this wallet has no recorded owner, so no backup key can be added')
        if ((await chain.permission(key.ownerAccount, op.publicKey)) !== 'full') throw new PolicyViolation(`the backup key is not a full-access key of ${key.ownerAccount}`)
        return
      case 'revoke': {
        if (!key.ownerAccount) throw new PolicyViolation('this wallet has no recorded owner, so NearKit keeps its key')
        const others = (await chain.fullAccessKeys(key.accountId)).filter((k) => k !== key.publicKey).slice(0, 8)
        for (const k of others) if ((await chain.permission(key.ownerAccount, k)) === 'full') return
        throw new PolicyViolation(`no other key on this wallet is a full-access key of ${key.ownerAccount}; removing NearKit’s key would leave it to nobody`)
      }
      case 'swap':
        // The route is the swap's last transaction; earlier ones only register storage.
        if (step === plan.length - 1)
          await verifySwapRoute(op.route, key.accountId, { network, feeRecipient: config.feeRecipient, maxSlippagePpm: config.maxSlippagePpm, oracle, now })
        return
      case 'unwrap':
        return
    }
  }

  // ─── owner-signed requests ────────────────────────────────────────────────

  async function verifyProof(body: unknown, kind: ChallengeKind): Promise<{ challenge: Challenge; publicKey: string }> {
    const b = obj(body, 'the request', ['challengeId', 'publicKey', 'signature'])
    const id = str(b.challengeId, 'challengeId', 64)
    const publicKey = str(b.publicKey, 'publicKey', 128)
    const signature = str(b.signature, 'signature', 256)
    await open()
    const c = await store.challenge(id)
    if (!c || c.kind !== kind || c.network !== network.id) throw new ChallengeError('unknown', 'This request is unknown. Start again.')
    if (c.usedAt !== null) throw new ChallengeError('used', 'This request was already used. Start again.')
    if (now() > c.expiresAt) throw new ChallengeError('expired', 'This request expired. Start again.')
    if (c.attempts >= MAX_CHALLENGE_ATTEMPTS) throw new ChallengeError('locked', 'Too many attempts with this request. Start again.')
    await store.bumpAttempt(id)
    const refused = async (reason: string) =>
      store.event('owner-proof-refused', { network: network.id, accountId: c.accountId, detail: { kind, challenge: id, reason, key: publicKey } })
    const nonce = base64Decode(c.nonce)
    const signed = parseEd25519PublicKey(publicKey) !== null && nonce !== null && (await verifyNep413({ message: c.message, nonce, recipient: c.recipient }, publicKey, signature))
    if (!signed) {
      await refused('bad signature')
      throw new ChallengeError('bad-signature', 'The signature does not match this request. Nothing happened.')
    }
    if ((await chain.permission(c.ownerAccount, publicKey)) !== 'full') {
      await refused('not a full-access key of the owner')
      throw new ChallengeError('not-owner', `Sign with a full-access key of ${c.ownerAccount}, the owner wallet. Nothing happened.`)
    }
    if (!(await store.useChallenge(id, publicKey))) throw new ChallengeError('used', 'This request was already used. Start again.')
    return { challenge: c, publicKey }
  }

  /** The wallet a verified request is about, still held and still owned by the same owner. */
  async function ownedKey(c: Challenge): Promise<SignerKey> {
    const key = await liveKey(c.accountId ?? '')
    if (key.ownerAccount !== c.ownerAccount) throw new ChallengeError('wallet', 'This NearKit wallet answers to another owner wallet now. Nothing happened.')
    return key
  }

  // ─── methods ──────────────────────────────────────────────────────────────

  const methods: Record<SignerMethod, (body: unknown) => Promise<unknown>> = {
    async 'create-key'(body) {
      const b = obj(body, 'the request', ['owner', 'userId'])
      const o = obj(b.owner, 'the owner', ['accountId', 'publicKey'])
      const ownerAccount = account(o.accountId, 'the owner account')
      const ownerKey = str(o.publicKey, 'the owner key', 128)
      if (!parseEd25519PublicKey(ownerKey)) throw new BadRequestError('malformed request: the owner key is not an ed25519 key')
      const userId = int(b.userId, 'userId', Number.MAX_SAFE_INTEGER)
      await open()
      const k = generateKey()
      try {
        const accountId = implicitAccountId(k.publicKey)
        const publicKey = nearPublicKey(k.publicKey)
        const sealedKey = await sealWalletKey(keys, k.seed, { network: network.id, accountId, publicKey, owner: ownerAccount })
        await store.insertKey({ network: network.id, accountId, publicKey, ownerAccount, ownerKey, userId, walletId: null, sealedKey, keyRef: keys.current.ref })
        await store.event('key-created', { network: network.id, accountId, detail: { owner: ownerAccount, keyRef: keys.current.ref, userId } })
        return { accountId, publicKey, keyRef: keys.current.ref }
      } finally {
        k.seed.fill(0)
      }
    },

    async sign(body) {
      const b = obj(body, 'the request', ['accountId', 'intentId', 'step', 'op', 'plan', 'nonce', 'blockHash'])
      const accountId = str(b.accountId, 'accountId', 64)
      const intentId = str(b.intentId, 'intentId', 64)
      const step = int(b.step, 'step', 3)
      const op = decodeOp(b.op)
      const plan = decodePlan(b.plan)
      const nonce = uint(b.nonce, 'nonce')
      if (nonce === 0n || nonce >= 2n ** 64n) throw new BadRequestError('malformed request: the nonce is out of range')
      const blockHash = base58Decode(str(b.blockHash, 'blockHash', 64))
      if (!blockHash || blockHash.length !== 32) throw new BadRequestError('malformed request: the block hash is not 32 bytes')
      await open()
      const key = await liveKey(accountId)
      const denied = async (e: PolicyViolation) => {
        await store.event('signer-denied', { network: network.id, accountId, detail: { intent: intentId, step, op: op.kind, reason: e.message } })
        log.warn('signer refused', { account: accountId, intent: intentId, op: op.kind, reason: e.message })
        return e
      }
      const planned = plan[step]
      if (!planned) throw await denied(new PolicyViolation('there is no such transaction in the plan'))
      const tx: NearTransaction = { signerId: accountId, publicKey: key.publicKey, nonce, receiverId: planned.receiverId, blockHash, actions: toTxActions(planned.actions) }
      const digest = await transactionDigest(serializeTransaction(tx))
      const hash = base58Encode(digest)
      // One transaction per (intent, step), ever. The same request again gets the same answer.
      const earlier = await store.signature(intentId, step)
      if (earlier) {
        if (earlier.txHash === hash && earlier.accountId === accountId) return { hash, signed: earlier.signed }
        await store.event('signer-denied', { network: network.id, accountId, detail: { intent: intentId, step, reason: 'step already signed as another transaction' } })
        throw new AlreadySignedError()
      }
      try {
        checkPlan(op, plan, { accountId, publicKey: key.publicKey, network: key.network }, network, config.feeRecipient)
        await authorize(key, op, plan, step)
      } catch (e) {
        throw e instanceof PolicyViolation ? await denied(e) : e
      }
      const signature = await withSeed(key, (seed) => signWithSeed(seed, digest))
      const bytes = serializeSignedTransaction(tx, signature)
      // What leaves is read back and must be exactly the planned transaction.
      if (!sameTransaction(deserializeSignedTransaction(bytes).transaction, tx)) throw new PolicyViolation('the signed transaction differs from the plan')
      const signed = base64Encode(bytes)
      const record = await store.recordSignature({ intentId, step, network: network.id, accountId, txHash: hash, signed, nonce: nonce.toString(), opKind: op.kind })
      // A concurrent request signed this step first: this signature is dropped, never released.
      if (record.txHash !== hash) throw new AlreadySignedError()
      await store.event('tx-signed', { network: network.id, accountId, detail: { intent: intentId, step, hash, op: op.kind, receiver: planned.receiverId } })
      return { hash, signed }
    },

    async 'erase-key'(body) {
      const b = obj(body, 'the request', ['accountId', 'reason'])
      const accountId = str(b.accountId, 'accountId', 64)
      if (b.reason !== 'deleted' && b.reason !== 'revoked') throw new BadRequestError('malformed request: the reason is unknown')
      await open()
      const key = await store.key(network.id, accountId)
      if (!key || key.status !== 'active') return { erased: false }
      // Checked on chain by a quorum of providers: a key is never erased while it still controls funds.
      if (b.reason === 'deleted') {
        if (await chain.accountExists(accountId)) throw new PolicyViolation('the wallet exists on chain (it was funded), so its key is not erased')
      } else {
        if (!(await chain.accountExists(accountId))) throw new PolicyViolation('the wallet does not exist on chain')
        if ((await chain.permission(accountId, key.publicKey)) !== 'missing') throw new PolicyViolation('NearKit’s key is still on the wallet, so its copy is not erased')
      }
      const erased = await store.eraseKey(network.id, accountId, b.reason)
      if (erased) await store.event('key-erased', { network: network.id, accountId, detail: { reason: b.reason } })
      return { erased }
    },

    async 'key-info'(body) {
      const b = obj(body, 'the request', ['accountId'])
      const key = await store.key(network.id, str(b.accountId, 'accountId', 64))
      return key
        ? { held: key.status === 'active', publicKey: key.publicKey, ownerAccount: key.ownerAccount, keyRef: key.keyRef }
        : { held: false, publicKey: null, ownerAccount: null, keyRef: null }
    },

    async challenge(body) {
      const b = obj(body, 'the request', ['kind'], ['owner', 'accountId', 'destination', 'recipientKey'])
      const kind = b.kind
      if (kind !== 'owner-session' && kind !== 'export' && kind !== 'approve-destination') throw new BadRequestError('malformed request: the kind is unknown')
      await open()
      let ownerAccount: string
      let accountId: string | null = null
      let destination: string | null = null
      let recipientKey: string | null = null
      let browserKey: string | null = null
      if (kind === 'owner-session') {
        ownerAccount = account(b.owner, 'the owner')
      } else {
        accountId = str(b.accountId, 'accountId', 64)
        const key = await liveKey(accountId)
        if (!key.ownerAccount) throw new ChallengeError('wallet', 'This NearKit wallet has no recorded owner wallet, so nothing can be authorized for it.')
        ownerAccount = key.ownerAccount
        if (kind === 'export') {
          recipientKey = str(b.recipientKey, 'recipientKey', 128)
          try {
            browserKey = await exportKeyFingerprint(recipientKey)
          } catch {
            throw new BadRequestError('malformed request: the browser key is not a P-256 public key')
          }
        } else {
          destination = account(b.destination, 'the destination')
          if (destination === accountId) throw new BadRequestError('malformed request: the destination is the wallet itself')
          if (destination === ownerAccount) throw new BadRequestError('malformed request: the owner wallet needs no approval')
        }
      }
      if ((await store.countChallengesSince(network.id, ownerAccount, now() - CHALLENGE_WINDOW_MS)) >= CHALLENGES_PER_WINDOW)
        throw new ChallengeError('rate-limited', 'Too many requests for this wallet. Try again in a few minutes.')
      const id = randomToken(18)
      const expiresAt = now() + ttl
      const c = await store.createChallenge({
        id,
        kind,
        network: network.id,
        accountId,
        ownerAccount,
        destination,
        recipientKey,
        message: challengeMessage({ kind, id, network: network.id, ownerAccount, accountId, destination, browserKey, expiresAt }),
        nonce: base64Encode(randomBytesArray(32)),
        recipient: config.recipient,
        expiresAt,
      })
      await store.event('challenge-created', { network: network.id, accountId, detail: { kind, challenge: id, owner: ownerAccount, destination } })
      return viewOf(c)
    },

    async 'owner-wallets'(body) {
      const { challenge: c, publicKey } = await verifyProof(body, 'owner-session')
      const wallets = await store.keysOfOwner(network.id, c.ownerAccount)
      await store.event('owner-session', { network: network.id, detail: { owner: c.ownerAccount, key: publicKey, wallets: wallets.length } })
      return { ownerAccount: c.ownerAccount, wallets: wallets.map((w) => ({ accountId: w.accountId, publicKey: w.publicKey, createdAt: w.createdAt })) }
    },

    async 'approve-destination'(body) {
      const b = obj(body, 'the request', ['challengeId', 'publicKey', 'signature'])
      const { challenge: c, publicKey } = await verifyProof(b, 'approve-destination')
      const key = await ownedKey(c)
      const d = await store.addDestination({
        network: network.id,
        accountId: key.accountId,
        destination: c.destination as string,
        ownerAccount: c.ownerAccount,
        publicKey,
        challengeId: c.id,
        message: c.message,
        nonce: c.nonce,
        recipient: c.recipient,
        signature: b.signature as string,
      })
      await store.event('destination-approved', { network: network.id, accountId: key.accountId, detail: { destination: d.destination, owner: c.ownerAccount, key: publicKey } })
      return { accountId: key.accountId, destination: d.destination, approvedAt: d.approvedAt }
    },

    async 'revoke-destination'(body) {
      const b = obj(body, 'the request', ['accountId', 'destination'])
      // Revoking only takes permission away: it needs no owner signature.
      const accountId = str(b.accountId, 'accountId', 64)
      const destination = str(b.destination, 'destination', 64)
      const revoked = await store.revokeDestination(network.id, accountId, destination)
      if (revoked) await store.event('destination-revoked', { network: network.id, accountId, detail: { destination } })
      return { revoked }
    },

    async destinations(body) {
      const b = obj(body, 'the request', ['accountId'])
      const key = await store.key(network.id, str(b.accountId, 'accountId', 64))
      if (!key) return { ownerAccount: null, destinations: [] }
      const list = await store.destinations(network.id, key.accountId)
      return { ownerAccount: key.ownerAccount, destinations: list.map((d) => ({ destination: d.destination, approvedAt: d.approvedAt })) }
    },

    async export(body) {
      const { challenge: c, publicKey } = await verifyProof(body, 'export')
      const key = await ownedKey(c)
      if (!c.recipientKey) throw new ChallengeError('unknown', 'This export request names no browser key. Start again.')
      const recipientKey = c.recipientKey
      // The key exists in the clear only between opening it and sealing it to the browser key the owner signed for.
      const secret = await withSeed(key, (seed) => secretKeyText(seed))
      const sealed = await sealExport(recipientKey, secret, { challengeId: c.id, network: network.id, accountId: key.accountId })
      await store.event('key-exported', { network: network.id, accountId: key.accountId, detail: { owner: c.ownerAccount, key: publicKey, challenge: c.id } })
      log.info('key exported to its owner', { account: key.accountId, owner: c.ownerAccount })
      return { accountId: key.accountId, publicKey: key.publicKey, sealed }
    },

    async pause(body) {
      const b = obj(body, 'the request', ['reason'])
      // Pausing only stops things, so the app may ask for it; resuming is done on the signer's host.
      await store.setState('paused', 'true')
      await store.event('signer-paused', { detail: { reason: str(b.reason, 'reason', 200), by: 'app' } })
      log.warn('signer paused', { reason: b.reason })
      return { paused: true }
    },

    async health() {
      if (!health || now() - health.at > HEALTH_CACHE_MS) health = { at: now(), kek: await probeKek(keys.current) }
      let db = 'ok'
      let isPaused = true
      try {
        isPaused = await paused()
      } catch (e) {
        db = e instanceof Error ? e.message : 'unavailable'
      }
      return { ok: health.kek === 'ok' && db === 'ok' && !isPaused, paused: isPaused, network: network.id, keyRef: keys.current.ref, kek: health.kek, db }
    },
  }

  return {
    network: network.id,
    keyRef: keys.current.ref,
    /** One request: `body` is untrusted JSON; everything is validated before it is used. */
    async handle(method: string, body: unknown): Promise<unknown> {
      const run = (methods as Record<string, ((b: unknown) => Promise<unknown>) | undefined>)[method]
      if (!run || !SIGNER_METHODS.includes(method as SignerMethod)) throw new BadRequestError(`malformed request: unknown method ${method.slice(0, 40)}`)
      return run(body ?? {})
    },
    /** Operator only (the signer's host): pause or resume. Never reachable through the API. */
    async setPaused(value: boolean, reason: string): Promise<void> {
      await store.setState('paused', value ? 'true' : 'false')
      await store.event(value ? 'signer-paused' : 'signer-resumed', { detail: { reason, by: 'operator' } })
    },
    paused,
  }
}

export type SignerCore = ReturnType<typeof createSignerCore>
