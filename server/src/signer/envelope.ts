import { nearPublicKey, publicKeyOf } from '../custody/keys'
import { KeyUnavailableError, openSecret, parseSealed, rewrapSecret, sealSecret, type Keyring } from '../custody/vault'

/**
 * Wallet keys as the signer seals them (envelope encryption, custody/vault.ts).
 *
 * v2 (every key the signer makes): both layers' additional data name the network, the
 * account AND its owner, the linked wallet the NearKit wallet answers to. A sealed key
 * opens only for the owner it was made for, so rewriting a wallet's owner anywhere (a
 * database row, a request) leaves its key unopenable instead of exportable to someone else.
 *
 * v1 (testnet wallets made before the signer): network and account only. Still opens;
 * `resealWalletKey` moves it to v2 and to the current KEK.
 */

export const aadV1 = (network: string, accountId: string) => `${network}:${accountId}`
export const aadV2 = (network: string, accountId: string, owner: string) => `nearkit:wallet:v2|${network}|${accountId}|owner:${owner}`

/** What a sealed key belongs to. Every field is public data. */
export interface KeyBinding {
  network: string
  accountId: string
  /** The key's public half, as NEAR shows it: the opened key must be exactly this. */
  publicKey: string
  /** The owner wallet (null only for v1 keys made before owners were recorded). */
  owner: string | null
}

export async function sealWalletKey(keys: Keyring, seed: Buffer, b: KeyBinding): Promise<string> {
  if (!b.owner) throw new KeyUnavailableError('A new wallet key is always bound to its owner')
  return JSON.stringify(await sealSecret(keys.current, seed, aadV2(b.network, b.accountId, b.owner), 2))
}

/** Opens a stored key for exactly this binding and checks it is this wallet's key. The caller wipes the seed. */
export async function openWalletKey(keys: Keyring, sealedText: string, b: KeyBinding): Promise<Buffer> {
  const sealed = parseSealed(sealedText)
  if (sealed.v === 2 && !b.owner) throw new KeyUnavailableError('This wallet key is bound to an owner, and none was given')
  const seed = await openSecret(keys, sealed, sealed.v === 2 ? aadV2(b.network, b.accountId, b.owner as string) : aadV1(b.network, b.accountId))
  if (nearPublicKey(publicKeyOf(seed)) !== b.publicKey) {
    seed.fill(0)
    throw new KeyUnavailableError('The stored key does not match this wallet')
  }
  return seed
}

/**
 * Moves a key to the current KEK and, when its owner is known, to the owner-bound v2
 * format. A v2 key only has its data key rewrapped (the wallet key itself is never
 * decrypted); a v1 key is opened once and sealed again as v2.
 */
export async function resealWalletKey(keys: Keyring, sealedText: string, b: KeyBinding): Promise<{ sealed: string; changed: boolean }> {
  const sealed = parseSealed(sealedText)
  const current = keys.current
  const from = () => {
    const w = keys.byRef(sealed.ref)
    if (!w) throw new KeyUnavailableError(`This wallet key was sealed with a key-encryption key this signer doesn't have (${sealed.ref})`)
    return w
  }
  if (sealed.v === 2) {
    if (sealed.ref === current.ref) return { sealed: sealedText, changed: false }
    if (!b.owner) throw new KeyUnavailableError('This wallet key is bound to an owner, and none was given')
    return { sealed: JSON.stringify(await rewrapSecret(from(), current, sealed, aadV2(b.network, b.accountId, b.owner))), changed: true }
  }
  if (!b.owner) {
    // No owner on record: it stays v1, on the current KEK.
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
