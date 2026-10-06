import type { NetworkConfig } from '@/config/networks'
import { base58Decode, base58Encode, base64Decode, base64Encode } from '@/lib/encoding'
import { exportKeyFingerprint, sealExport } from '@/lib/exportCrypto'
import { telegramApprovalDigest } from '@/lib/telegramApproval'
import { accountKind, isForeignToNetwork } from '@/lib/validation'
import { parseEd25519PublicKey, verifyNep413 } from '@/services/near/nep413'
import { deserializeSignedTransaction, serializeSignedTransaction, serializeTransaction, transactionDigest, type NearTransaction, type TxAction } from '@/services/near/transaction'
import { generateKey, implicitAccountId, nearPublicKey, publicKeyOf, secretKeyText, signWithSeed } from '../custody/keys'
import { checkPlan, MAX_REGISTRATIONS_PER_DAY_YOCTO, PolicyViolation, type WalletOperation } from '../custody/policy'
import { KeyUnavailableError, parseSealed, type Keyring } from '../custody/vault'
import { randomBytesArray, randomToken } from '../ids'
import { silentLogger, type Logger } from '../log'
import type { SignerChain } from './chain'
import { BadRequestError, decodeOp, decodePlan, int, obj, str, uint } from './codec'
import { bindOwnerKey, openWalletKey, sealWalletKey, type KeyBinding } from './envelope'
import { AlreadySignedError, ChallengeError, DestinationNotApprovedError, SignerPausedError } from './errors'
import { probeKek } from './kms'
import { challengeMessage, readMessage } from './messages'
import { verifySwapRoute, type RouteOracle } from './routes'
import type { Challenge, ChallengeKind, SignerKey, SignerStore, TelegramRequest, TelegramRequestKind } from './store'
import { verifyTelegramLaunch, type TelegramCheck } from './telegram'
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
 * - Wallets with no owner wallet: the Telegram account that created one controls it, and its
 *   key is sealed to that account. A withdrawal address, and the wallet's first owner, are
 *   approved in NearKit's Mini App: the signer checks Telegram's own signature on the launch
 *   (signer/telegram.ts), bound to the exact request it wrote. The app can relay an approval
 *   but never make one. Such a wallet has none of an owner's powers (export, backup key,
 *   removing NearKit's key) until an owner wallet is bound, once and one way.
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
  /** NearKit's bot and Telegram's key, for approvals in the Mini App (wallets with no owner wallet). Null: none can be approved. */
  telegram?: TelegramCheck | null
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
/** How long a Telegram approval request stays open: enough to open the Mini App and read it. */
export const TELEGRAM_REQUEST_TTL_MS = 10 * 60_000
/** Clock difference tolerated between Telegram's launch date and the signer's clock. */
const TELEGRAM_SKEW_MS = 60_000
const CHALLENGES_PER_WINDOW = 20
const CHALLENGE_WINDOW_MS = 10 * 60_000
const REGISTRATION_WINDOW_MS = 24 * 60 * 60_000

/** NEAR a transaction attaches to storage registrations: the contract it calls keeps it. */
const registrationPaid = (actions: readonly TxAction[]): bigint =>
  actions.reduce((sum, a) => (a.type === 'FunctionCall' && a.methodName === 'storage_deposit' ? sum + a.deposit : sum), 0n)
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

export interface TelegramRequestView {
  id: string
  /** The Mini App's start parameter. */
  digest: string
  kind: TelegramRequestKind
  network: string
  accountId: string
  /** The withdrawal address, or the account that becomes the owner. */
  target: string
  expiresAt: number
}

const telegramView = (r: TelegramRequest): TelegramRequestView => ({
  id: r.id,
  digest: r.digest,
  kind: r.kind,
  network: r.network,
  accountId: r.accountId,
  target: r.target,
  expiresAt: r.expiresAt,
})

export type SignerMethod =
  | 'create-key'
  | 'sign'
  | 'erase-key'
  | 'key-info'
  | 'challenge'
  | 'owner-wallets'
  | 'approve-destination'
  | 'revoke-destination'
  | 'destinations'
  | 'export'
  | 'tg-request'
  | 'tg-request-view'
  | 'tg-approve'
  | 'pause'
  | 'health'

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
  'tg-request',
  'tg-request-view',
  'tg-approve',
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
  const queues = new Map<string, Promise<unknown>>()

  /** Runs `run` after every earlier one for the same account has settled. */
  async function oneAtATime<T>(account: string, run: () => Promise<T>): Promise<T> {
    const mine = (queues.get(account) ?? Promise.resolve()).catch(() => undefined).then(run)
    queues.set(account, mine)
    try {
      return await mine
    } finally {
      if (queues.get(account) === mine) queues.delete(account)
    }
  }

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
    if (!key || key.status !== 'active' || !key.sealedKey) throw new KeyUnavailableError('This NEARKITS wallet is closed or unknown; NEARKITS holds no key for it')
    return key
  }

  /** What a key is sealed to: its owner wallet, or (with none) the Telegram account that controls it. */
  const bindingOf = (key: SignerKey): KeyBinding => ({
    network: key.network,
    accountId: key.accountId,
    publicKey: key.publicKey,
    owner: key.ownerAccount,
    controller: key.ownerAccount ? null : key.userId,
  })

  async function withSeed<T>(key: SignerKey, act: (seed: Buffer) => T): Promise<T> {
    const seed = await openWalletKey(keys, key.sealedKey as string, bindingOf(key))
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

  function telegram(): TelegramCheck {
    if (!config.telegram)
      throw new ChallengeError('telegram-off', 'Approvals in Telegram aren’t set up on this NEARKITS server, so nothing can be approved for a wallet without an owner wallet.')
    return config.telegram
  }

  /**
   * An address the controlling Telegram account approved (a wallet with no owner wallet),
   * re-verified in full: Telegram's signature on the stored launch, the Telegram account, and
   * that what Telegram signed is exactly this wallet's request for this address.
   */
  async function telegramApprovalHolds(key: SignerKey, destination: string): Promise<boolean> {
    if (!config.telegram || key.ownerAccount || !key.userId) return false
    const a = await store.liveTelegramApproval(network.id, key.accountId, destination)
    if (!a || a.userId !== key.userId) return false
    const launch = await verifyTelegramLaunch(a.initData, config.telegram)
    if (!launch || launch.userId !== key.userId) return false
    const digest = await telegramApprovalDigest({
      id: a.requestId,
      kind: 'destination',
      network: network.id,
      accountId: key.accountId,
      target: destination,
      expiresAt: a.requestExpiresAt,
    })
    return launch.startParam === digest
  }

  /**
   * A destination that is another NEARKITS wallet under the same authority as this one: both bound to
   * the same owner wallet, or both without one and sealed to the same Telegram account. Moving funds
   * between them changes nothing about who can take them out, so it needs no approval. Never from a
   * wallet with an owner to one without (owner-signed protection would become Telegram-only), never to
   * a wallet with another owner, never to a closed one. The destination's row isn't taken on trust:
   * its sealed key is opened under its own binding (its owner, or its Telegram account) and must be
   * that very account's key, so a forged or edited row opens nothing.
   */
  async function siblingHolds(key: SignerKey, destination: string): Promise<boolean> {
    const dest = await store.key(network.id, destination)
    if (!dest || dest.status !== 'active' || !dest.sealedKey || !key.sealedKey || dest.accountId === key.accountId) return false
    // The same Telegram user's, under the same owner wallet (or both under none): never another user's,
    // whatever owner wallet it names. The owner (or the controlling account) is sealed into each key and
    // proven by opening it below; a key sealed before bindings (v1) proves no owner, so it is never a sibling.
    if (key.userId === null || dest.userId !== key.userId) return false
    const sameOwner = key.ownerAccount !== null && dest.ownerAccount === key.ownerAccount
    const sameController = key.ownerAccount === null && dest.ownerAccount === null
    if (!sameOwner && !sameController) return false
    try {
      if (parseSealed(key.sealedKey).v === 1 || parseSealed(dest.sealedKey).v === 1) return false
      return await withSeed(dest, (seed) => implicitAccountId(publicKeyOf(seed)) === destination)
    } catch {
      return false
    }
  }

  async function authorize(key: SignerKey, op: WalletOperation): Promise<void> {
    switch (op.kind) {
      case 'withdraw-near':
      case 'withdraw-token':
        if (key.ownerAccount) {
          if (op.to === key.ownerAccount) return
          if (await siblingHolds(key, op.to)) return
          if (!(await approvalHolds(key, op.to))) throw new DestinationNotApprovedError(op.to)
          return
        }
        // No owner wallet: another wallet of its Telegram account, or addresses that account approved in the Mini App.
        if (await siblingHolds(key, op.to)) return
        if (!(await telegramApprovalHolds(key, op.to))) throw new DestinationNotApprovedError(op.to)
        return
      case 'add-backup-key':
        if (!key.ownerAccount) throw new PolicyViolation('this wallet has no recorded owner, so no backup key can be added')
        if ((await chain.permission(key.ownerAccount, op.publicKey)) !== 'full') throw new PolicyViolation(`the backup key is not a full-access key of ${key.ownerAccount}`)
        return
      case 'revoke': {
        if (!key.ownerAccount) throw new PolicyViolation('this wallet has no recorded owner, so NEARKITS keeps its key')
        const others = (await chain.fullAccessKeys(key.accountId)).filter((k) => k !== key.publicKey).slice(0, 8)
        for (const k of others) if ((await chain.permission(key.ownerAccount, k)) === 'full') return
        throw new PolicyViolation(`no other key on this wallet is a full-access key of ${key.ownerAccount}; removing NEARKITS’ key would leave it to nobody`)
      }
      case 'swap':
        // Every step, not only the swap itself: the earlier transactions register storage on the
        // route's tokens and attach NEAR to them, so the route (Rhea's signature or the pools, and
        // the signer's own quote) is what makes those contracts the route's, before any is signed.
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
    if (key.ownerAccount !== c.ownerAccount) throw new ChallengeError('wallet', 'This NEARKITS wallet answers to another owner wallet now. Nothing happened.')
    return key
  }

  // ─── methods ──────────────────────────────────────────────────────────────

  const methods: Record<SignerMethod, (body: unknown) => Promise<unknown>> = {
    async 'create-key'(body) {
      // No owner: a wallet with no owner wallet, sealed to the Telegram account that asks for it.
      const b = obj(body, 'the request', ['userId'], ['owner'])
      let ownerAccount: string | null = null
      let ownerKey: string | null = null
      if (b.owner !== undefined && b.owner !== null) {
        const o = obj(b.owner, 'the owner', ['accountId', 'publicKey'])
        ownerAccount = account(o.accountId, 'the owner account')
        ownerKey = str(o.publicKey, 'the owner key', 128)
        if (!parseEd25519PublicKey(ownerKey)) throw new BadRequestError('malformed request: the owner key is not an ed25519 key')
      }
      const userId = int(b.userId, 'userId', Number.MAX_SAFE_INTEGER)
      if (!ownerAccount && userId === 0) throw new BadRequestError('malformed request: a wallet with no owner wallet needs the Telegram account that controls it')
      await open()
      const k = generateKey()
      try {
        const accountId = implicitAccountId(k.publicKey)
        const publicKey = nearPublicKey(k.publicKey)
        const sealedKey = await sealWalletKey(keys, k.seed, { network: network.id, accountId, publicKey, owner: ownerAccount, controller: ownerAccount ? null : userId })
        await store.insertKey({ network: network.id, accountId, publicKey, ownerAccount, ownerKey, userId, walletId: null, sealedKey, keyRef: keys.current.ref })
        await store.event('key-created', {
          network: network.id,
          accountId,
          detail: { owner: ownerAccount, ...(ownerAccount ? {} : { controlledBy: 'telegram' }), keyRef: keys.current.ref, userId },
        })
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
        await authorize(key, op)
      } catch (e) {
        throw e instanceof PolicyViolation ? await denied(e) : e
      }
      const paid = registrationPaid(tx.actions)
      const release = async () => {
        if (paid > 0n) {
          // What this wallet already paid for registrations today, from the transactions the signer signed itself.
          let spent = 0n
          for (const s of await store.signedSince(network.id, accountId, now() - REGISTRATION_WINDOW_MS)) {
            const raw = base64Decode(s)
            if (raw) spent += registrationPaid(deserializeSignedTransaction(raw).transaction.actions)
          }
          if (spent + paid > MAX_REGISTRATIONS_PER_DAY_YOCTO)
            throw await denied(new PolicyViolation('this wallet has reached the 0.5 NEAR a day NEARKITS pays for storage registrations; try again tomorrow'))
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
      }
      // Registrations of one wallet are signed one at a time, so the day's total is what was really signed.
      return paid > 0n ? await oneAtATime(accountId, release) : await release()
    },

    async 'erase-key'(body) {
      const b = obj(body, 'the request', ['accountId', 'reason'], ['tokens'])
      const accountId = str(b.accountId, 'accountId', 64)
      if (b.reason !== 'deleted' && b.reason !== 'revoked') throw new BadRequestError('malformed request: the reason is unknown')
      // Deleted: the token contracts the app found the address may hold, read again here with the network's known tokens.
      const listed: unknown = b.tokens ?? []
      if (!Array.isArray(listed) || listed.length > 100) throw new BadRequestError('malformed request: tokens is not a list of up to 100 contracts')
      const tokens = listed.map((t: unknown, i) => str(t, `tokens[${i}]`, 64))
      await open()
      const key = await store.key(network.id, accountId)
      if (!key || key.status !== 'active') return { erased: false }
      // Checked on chain by a quorum of providers: a key is never erased while it still controls funds.
      if (b.reason === 'deleted') {
        // Only a wallet that was never funded. One that exists on chain keeps its key, even when it holds
        // only dust: the app closes such a wallet without erasing anything, so nothing that arrives later is lost.
        if (await chain.accountExists(accountId)) throw new PolicyViolation('the wallet exists on chain (it was funded), so its key is not erased')
        // Tokens can be credited to an address that doesn't exist yet: none may be held, by the signer's own reading.
        for (const contract of new Set([...tokens, ...network.knownTokens]))
          if ((await chain.tokenBalance(contract, accountId)) > 0n) throw new PolicyViolation(`the wallet holds ${contract} tokens, so its key is not erased`)
      } else {
        if (!(await chain.accountExists(accountId))) throw new PolicyViolation('the wallet does not exist on chain')
        if ((await chain.permission(accountId, key.publicKey)) !== 'missing') throw new PolicyViolation('NEARKITS’ key is still on the wallet, so its copy is not erased')
      }
      const erased = await store.eraseKey(network.id, accountId, b.reason)
      if (erased) await store.event('key-erased', { network: network.id, accountId, detail: { reason: b.reason } })
      return { erased }
    },

    async 'key-info'(body) {
      const b = obj(body, 'the request', ['accountId'])
      const key = await store.key(network.id, str(b.accountId, 'accountId', 64))
      return key
        ? { held: key.status === 'active', publicKey: key.publicKey, ownerAccount: key.ownerAccount, ownerKey: key.ownerKey, keyRef: key.keyRef }
        : { held: false, publicKey: null, ownerAccount: null, ownerKey: null, keyRef: null }
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
        if (!key.ownerAccount) throw new ChallengeError('wallet', 'This NEARKITS wallet has no recorded owner wallet, so nothing can be authorized for it.')
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
      // Revoking only takes permission away: it needs no owner signature (nor Telegram's).
      const accountId = str(b.accountId, 'accountId', 64)
      const destination = str(b.destination, 'destination', 64)
      const byOwner = await store.revokeDestination(network.id, accountId, destination)
      const byTelegram = (await store.revokeTelegramApprovals(network.id, accountId, destination)) > 0
      const revoked = byOwner || byTelegram
      if (revoked) await store.event('destination-revoked', { network: network.id, accountId, detail: { destination } })
      return { revoked }
    },

    async destinations(body) {
      const b = obj(body, 'the request', ['accountId'])
      const key = await store.key(network.id, str(b.accountId, 'accountId', 64))
      if (!key) return { ownerAccount: null, destinations: [] }
      // The approvals that count for this wallet: its owner's, or (with no owner) its Telegram account's.
      if (!key.ownerAccount) {
        const list = await store.telegramApprovals(network.id, key.accountId)
        return { ownerAccount: null, destinations: list.map((a) => ({ destination: a.destination, approvedAt: a.approvedAt, approvedBy: 'telegram' })) }
      }
      const list = await store.destinations(network.id, key.accountId)
      return { ownerAccount: key.ownerAccount, destinations: list.map((d) => ({ destination: d.destination, approvedAt: d.approvedAt, approvedBy: 'owner' })) }
    },

    async export(body) {
      const { challenge: c, publicKey } = await verifyProof(body, 'export')
      const key = await ownedKey(c)
      if (!c.recipientKey) throw new ChallengeError('unknown', 'This export request names no browser key. Start again.')
      const recipientKey = c.recipientKey
      // The owner signed the browser key's fingerprint, not the row: the key sealed to must be that one.
      if (readMessage(c.message)?.fields['Browser key'] !== (await exportKeyFingerprint(recipientKey)))
        throw new ChallengeError('unknown', 'This export request doesn’t name the browser key you signed for. Start again.')
      // The key exists in the clear only between opening it and sealing it to the browser key the owner signed for.
      const secret = await withSeed(key, (seed) => secretKeyText(seed))
      const sealed = await sealExport(recipientKey, secret, { challengeId: c.id, network: network.id, accountId: key.accountId })
      await store.event('key-exported', { network: network.id, accountId: key.accountId, detail: { owner: c.ownerAccount, key: publicKey, challenge: c.id } })
      log.info('key exported to its owner', { account: key.accountId, owner: c.ownerAccount })
      return { accountId: key.accountId, publicKey: key.publicKey, sealed }
    },

    async 'tg-request'(body) {
      const b = obj(body, 'the request', ['kind', 'accountId', 'target'], ['targetKey'])
      const kind = b.kind
      if (kind !== 'destination' && kind !== 'bind-owner') throw new BadRequestError('malformed request: the kind is unknown')
      const accountId = str(b.accountId, 'accountId', 64)
      const target = account(b.target, kind === 'destination' ? 'the destination' : 'the owner')
      let targetKey: string | null = null
      if (kind === 'bind-owner') {
        targetKey = str(b.targetKey, 'the owner key', 128)
        if (!parseEd25519PublicKey(targetKey)) throw new BadRequestError('malformed request: the owner key is not an ed25519 key')
      }
      if (target === accountId) throw new BadRequestError(`malformed request: ${kind === 'destination' ? 'the destination' : 'the owner'} is the wallet itself`)
      await open()
      telegram()
      const key = await liveKey(accountId)
      if (key.ownerAccount) throw new ChallengeError('owned', `This NEARKITS wallet has an owner wallet, ${key.ownerAccount}: approve with it in NEARKITS web instead.`)
      if (!key.userId) throw new ChallengeError('wallet', 'This NEARKITS wallet has no Telegram account on record, so nothing can be approved for it.')
      if ((await store.countTelegramRequestsSince(network.id, accountId, now() - CHALLENGE_WINDOW_MS)) >= CHALLENGES_PER_WINDOW)
        throw new ChallengeError('rate-limited', 'Too many requests for this wallet. Try again in a few minutes.')
      const id = randomToken(18)
      const expiresAt = now() + TELEGRAM_REQUEST_TTL_MS
      const digest = await telegramApprovalDigest({ id, kind, network: network.id, accountId, target, expiresAt })
      const r = await store.createTelegramRequest({ id, digest, kind, network: network.id, accountId, userId: key.userId, target, targetKey, expiresAt })
      await store.event('tg-request-created', { network: network.id, accountId, detail: { kind, request: id, target } })
      return telegramView(r)
    },

    async 'tg-request-view'(body) {
      const b = obj(body, 'the request', ['digest'])
      const r = await store.telegramRequestByDigest(str(b.digest, 'digest', 64))
      if (!r || r.network !== network.id) return { request: null, status: null }
      return { request: telegramView(r), status: r.usedAt !== null ? 'used' : now() > r.expiresAt ? 'expired' : 'open' }
    },

    async 'tg-approve'(body) {
      const b = obj(body, 'the request', ['initData'])
      const initData = str(b.initData, 'initData', 4096)
      await open()
      const launch = await verifyTelegramLaunch(initData, telegram())
      if (!launch) throw new ChallengeError('bad-signature', 'This approval isn’t signed by Telegram for NEARKITS’ bot. Nothing happened.')
      const r = await store.telegramRequestByDigest(launch.startParam)
      if (!r || r.network !== network.id) throw new ChallengeError('unknown', 'This request is unknown. Start again in Telegram.')
      const refused = (reason: string) =>
        store.event('tg-approval-refused', { network: network.id, accountId: r.accountId, detail: { request: r.id, reason, telegramUser: launch.userId } })
      if (r.usedAt !== null) throw new ChallengeError('used', 'This approval was already used. Start again in Telegram.')
      if (now() > r.expiresAt) throw new ChallengeError('expired', 'This request expired. Start again in Telegram.')
      if (r.attempts >= MAX_CHALLENGE_ATTEMPTS) throw new ChallengeError('locked', 'Too many attempts with this request. Start again in Telegram.')
      await store.bumpTelegramAttempt(r.id)
      // What Telegram signed must be this request exactly, as it was written (a row edited since hashes to something else).
      if ((await telegramApprovalDigest({ id: r.id, kind: r.kind, network: r.network, accountId: r.accountId, target: r.target, expiresAt: r.expiresAt })) !== launch.startParam) {
        await refused('the request was altered')
        throw new ChallengeError('unknown', 'This request is unknown. Start again in Telegram.')
      }
      const opened = launch.authDate * 1000
      if (opened < r.createdAt - TELEGRAM_SKEW_MS || opened > now() + TELEGRAM_SKEW_MS) {
        await refused('opened outside the request’s lifetime')
        throw new ChallengeError('stale', 'This approval was opened before the request existed. Start again in Telegram.')
      }
      const key = await liveKey(r.accountId)
      if (key.ownerAccount) throw new ChallengeError('owned', `This NEARKITS wallet has an owner wallet, ${key.ownerAccount}: approve with it in NEARKITS web instead.`)
      if (launch.userId !== r.userId || key.userId !== r.userId) {
        await refused('another Telegram account')
        throw new ChallengeError('not-controller', 'Approve with the Telegram account that controls this NEARKITS wallet. Nothing happened.')
      }
      if (!(await store.useTelegramRequest(r.id))) throw new ChallengeError('used', 'This approval was already used. Start again in Telegram.')
      if (r.kind === 'destination') {
        await store.addTelegramApproval({
          network: network.id,
          accountId: r.accountId,
          destination: r.target,
          userId: r.userId,
          requestId: r.id,
          requestExpiresAt: r.expiresAt,
          initData,
        })
        await store.event('tg-destination-approved', { network: network.id, accountId: r.accountId, detail: { destination: r.target, request: r.id, telegramUser: launch.userId } })
        return { kind: r.kind, accountId: r.accountId, target: r.target }
      }
      // The first owner: the key is resealed to it, once and one way.
      const before = key.sealedKey as string
      const after = await bindOwnerKey(keys, before, bindingOf(key), r.target)
      if (!(await store.bindOwner(network.id, r.accountId, before, after, r.target, r.targetKey)))
        throw new ChallengeError('owned', 'This NEARKITS wallet got an owner wallet meanwhile. Nothing changed.')
      // From now on only the owner's signed approvals count: the ones given in Telegram end here.
      const ended = await store.revokeTelegramApprovals(network.id, r.accountId)
      await store.event('owner-bound', {
        network: network.id,
        accountId: r.accountId,
        detail: { owner: r.target, request: r.id, telegramUser: launch.userId, telegramApprovalsEnded: ended },
      })
      log.info('owner wallet bound', { account: r.accountId, owner: r.target })
      return { kind: r.kind, accountId: r.accountId, target: r.target }
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
      return {
        ok: health.kek === 'ok' && db === 'ok' && !isPaused,
        paused: isPaused,
        network: network.id,
        keyRef: keys.current.ref,
        kek: health.kek,
        db,
        telegram: config.telegram?.botId ?? null,
      }
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
