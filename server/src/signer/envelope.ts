import { nearPublicKey, publicKeyOf } from '../custody/keys'
import { KeyUnavailableError, openSecret, parseSealed, rewrapSecret, sealSecret, type Keyring } from '../custody/vault'

/**
 * Wallet keys as the signer seals them (envelope encryption, custody/vault.ts).
 *
 * v2 (a wallet with an owner wallet): both layers' additional data name the network, the
 * account AND its owner, the NEAR wallet the NearKit wallet answers to. A sealed key opens
 * only for the owner it was made for, so rewriting a wallet's owner anywhere (a database
 * row, a request) leaves its key unopenable instead of exportable to someone else.
 *
 * v3 (a wallet with no owner wallet): the same, naming instead the Telegram account that
 * controls it. Rewriting that account anywhere leaves the key unopenable too. Binding the
 * wallet's first owner later moves the key to v2, once and one way (`bindOwnerKey`).
 *
 * v1 (testnet wallets made before the signer): network and account only. Still opens;
 * `resealWalletKey` moves it to v2 (or to v3 when only its Telegram account is known) and
 * to the current KEK.
 */

export const aadV1 = (network: string, accountId: string) => `${network}:${accountId}`
export const aadV2 = (network: string, accountId: string, owner: string) => `nearkit:wallet:v2|${network}|${accountId}|owner:${owner}`
export const aadV3 = (network: string, accountId: string, controller: number) => `nearkit:wallet:v3|${network}|${accountId}|controller:telegram:${controller}`

/** What a sealed key belongs to. Every field is public data. */
export interface KeyBinding {
  network: string
  accountId: string
  /** The key's public half, as NEAR shows it: the opened key must be exactly this. */
  publicKey: string
  /** The owner wallet, or null when the wallet has none. */
  owner: string | null
  /** A wallet with no owner wallet: the Telegram user who controls it (null only for v1 keys made before owners were recorded). */
  controller?: number | null
}

const controllerOf = (b: KeyBinding): number | null => (typeof b.controller === 'number' && Number.isSafeInteger(b.controller) && b.controller > 0 ? b.controller : null)

export async function sealWalletKey(keys: Keyring, seed: Buffer, b: KeyBinding): Promise<string> {
  if (b.owner) return JSON.stringify(await sealSecret(keys.current, seed, aadV2(b.network, b.accountId, b.owner), 2))
  const controller = controllerOf(b)
  if (controller === null) throw new KeyUnavailableError('A new wallet key is always bound to its owner wallet or to the Telegram account that controls it')
  return JSON.stringify(await sealSecret(keys.current, seed, aadV3(b.network, b.accountId, controller), 3))
}

/** The additional data a stored key was sealed with, for this binding (which must match its version). */
function aadFor(v: 1 | 2 | 3, b: KeyBinding): string {
  if (v === 2) {
    if (!b.owner) throw new KeyUnavailableError('This wallet key is bound to an owner, and none was given')
    return aadV2(b.network, b.accountId, b.owner)
  }
  if (v === 3) {
    const controller = controllerOf(b)
    if (b.owner || controller === null) throw new KeyUnavailableError('This wallet key is bound to the Telegram account that controls it, and it was not given')
    return aadV3(b.network, b.accountId, controller)
  }
  return aadV1(b.network, b.accountId)
}

/** Opens a stored key for exactly this binding and checks it is this wallet's key. The caller wipes the seed. */
export async function openWalletKey(keys: Keyring, sealedText: string, b: KeyBinding): Promise<Buffer> {
  const sealed = parseSealed(sealedText)
  const seed = await openSecret(keys, sealed, aadFor(sealed.v, b))
  if (nearPublicKey(publicKeyOf(seed)) !== b.publicKey) {
    seed.fill(0)
    throw new KeyUnavailableError('The stored key does not match this wallet')
  }
  return seed
}

/**
 * A wallet with no owner wallet gets its first owner: the key is opened for the Telegram
 * account that controls it and sealed again, bound to `owner`. One way: a key already bound
 * to an owner is never bound again.
 */
export async function bindOwnerKey(keys: Keyring, sealedText: string, b: KeyBinding, owner: string): Promise<string> {
  if (parseSealed(sealedText).v !== 3 || b.owner) throw new KeyUnavailableError('Only a wallet with no owner wallet can be bound to one')
  const seed = await openWalletKey(keys, sealedText, b)
  try {
    return await sealWalletKey(keys, seed, { ...b, owner, controller: null })
  } finally {
    seed.fill(0)
  }
}

/**
 * Moves a key to the current KEK and, when its owner (or, with none, its Telegram account)
 * is known, to the bound v2 (v3) format. A v2 or v3 key only has its data key rewrapped (the
 * wallet key itself is never decrypted); a v1 key is opened once and sealed again.
 */
export async function resealWalletKey(keys: Keyring, sealedText: string, b: KeyBinding): Promise<{ sealed: string; changed: boolean }> {
  const sealed = parseSealed(sealedText)
  const current = keys.current
  const from = () => {
    const w = keys.byRef(sealed.ref)
    if (!w) throw new KeyUnavailableError(`This wallet key was sealed with a key-encryption key this signer doesn't have (${sealed.ref})`)
    return w
  }
  if (sealed.v === 2 || sealed.v === 3) {
    if (sealed.ref === current.ref) return { sealed: sealedText, changed: false }
    return { sealed: JSON.stringify(await rewrapSecret(from(), current, sealed, aadFor(sealed.v, b))), changed: true }
  }
  if (!b.owner && controllerOf(b) === null) {
    // Nothing on record to bind it to: it stays v1, on the current KEK.
    if (sealed.ref === current.ref) return { sealed: sealedText, changed: false }
    return { sealed: JSON.stringify(await rewrapSecret(from(), current, sealed, aadV1(b.network, b.accountId))), changed: true }
  }
  const seed = await openWalletKey(keys, sealedText, b)
  try {
    return { sealed: await sealWalletKey(keys, seed, b), changed: true }
  } finally {
    seed.fill(0)
  }
}
