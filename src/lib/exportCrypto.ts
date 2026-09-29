/**
 * A NearKit wallet key on its way to its owner, end to end: the signer encrypts it to a
 * key the owner's browser made for this one export, so nothing in between (the API, a
 * proxy, a log) ever holds it in the clear. The browser key's fingerprint is part of the
 * message the owner wallet signs, so nobody can swap in a key of their own.
 *
 * ECDH P-256 (the browser's key × a one-time key of the signer) → HKDF-SHA-256 (salt: the
 * request ID; info: network and account) → AES-256-GCM (additional data: the same info).
 * WebCrypto only: the same code runs in the browser and in Node.
 */

export interface SealedExport {
  v: 1
  /** The signer's one-time public key (raw P-256, base64url). */
  epk: string
  iv: string
  /** Ciphertext and GCM tag (base64url). */
  ct: string
}

export interface ExportBinding {
  challengeId: string
  network: string
  accountId: string
}

const subtle = () => globalThis.crypto.subtle
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const

const b64u = (bytes: Uint8Array) => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64u(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('Not base64url')
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4))
  return Uint8Array.from(s, (c) => c.charCodeAt(0))
}

const info = (b: ExportBinding) => new TextEncoder().encode(`nearkit-export-v1|${b.network}|${b.accountId}`)

async function aesKey(privateKey: CryptoKey, publicKey: CryptoKey, b: ExportBinding): Promise<CryptoKey> {
  const shared = await subtle().deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256)
  const hkdf = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(b.challengeId), info: info(b) }, hkdf, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
}

async function importPublic(raw: string): Promise<CryptoKey> {
  const bytes = fromB64u(raw)
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error('Not a P-256 public key')
  return subtle().importKey('raw', bytes, ECDH, false, [])
}

/** The browser's key for one export: the private half never leaves the page (not extractable). */
export async function createExportKeyPair(): Promise<{ privateKey: CryptoKey; publicKey: string }> {
  const pair = (await subtle().generateKey(ECDH, false, ['deriveBits'])) as CryptoKeyPair
  return { privateKey: pair.privateKey, publicKey: b64u(new Uint8Array(await subtle().exportKey('raw', pair.publicKey))) }
}

/** What the owner sees in the message they sign: the first 64 bits of SHA-256 of the browser key, in groups. */
export async function exportKeyFingerprint(publicKey: string): Promise<string> {
  const bytes = fromB64u(publicKey)
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error('Not a P-256 public key')
  const hex = [...new Uint8Array(await subtle().digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
  return hex.slice(0, 16).replace(/(.{4})(?!$)/g, '$1 ')
}

/** Signer side: the secret, sealed to the browser key named in the signed request. */
export async function sealExport(recipientPublicKey: string, secret: string, binding: ExportBinding): Promise<SealedExport> {
  const recipient = await importPublic(recipientPublicKey)
  const eph = (await subtle().generateKey(ECDH, true, ['deriveBits'])) as CryptoKeyPair
  const key = await aesKey(eph.privateKey, recipient, binding)
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const plain = new TextEncoder().encode(secret)
  try {
    const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: info(binding) }, key, plain))
    return { v: 1, epk: b64u(new Uint8Array(await subtle().exportKey('raw', eph.publicKey))), iv: b64u(iv), ct: b64u(ct) }
  } finally {
    plain.fill(0)
  }
}

/** Browser side: opens what the signer sealed to this page's key. Throws on any tampering. */
export async function openExport(privateKey: CryptoKey, sealed: SealedExport, binding: ExportBinding): Promise<string> {
  if (sealed?.v !== 1) throw new Error('Unknown export format')
  const key = await aesKey(privateKey, await importPublic(sealed.epk), binding)
  const plain = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64u(sealed.iv), additionalData: info(binding) }, key, fromB64u(sealed.ct))
  return new TextDecoder().decode(plain)
}
