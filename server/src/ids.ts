import { createHash, randomBytes } from 'node:crypto'
import { base64UrlEncode } from '@/lib/encoding'

/** Unguessable random token, URL-safe (`bytes` of entropy; 16 = 128 bits). */
export function randomToken(bytes = 16): string {
  return base64UrlEncode(randomBytes(bytes))
}

export function randomBytesArray(n: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(randomBytes(n))
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
