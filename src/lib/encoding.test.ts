import { describe, expect, it } from 'vitest'
import { base58Decode, base58Encode, base64Decode, base64Encode, base64UrlEncode, hexDecode, hexEncode } from './encoding'

describe('base58 (NEAR keys and hashes)', () => {
  it('decodes a NEAR public key to 32 bytes and back', () => {
    // Rhea's route-signing key, as configured in networks.ts.
    const text = 'ErtuMcHm3nX3jRWWNkR8fodpbJvX2mK3rKnjHQN77d9K'
    const bytes = base58Decode(text)
    expect(bytes?.length).toBe(32)
    expect(base58Encode(bytes as Uint8Array)).toBe(text)
  })

  it('keeps leading zero bytes as leading 1s', () => {
    expect(base58Encode(Uint8Array.from([0, 0, 1]))).toBe('112')
    expect(base58Decode('112')).toEqual(Uint8Array.from([0, 0, 1]))
  })

  it('refuses characters outside the alphabet', () => {
    expect(base58Decode('0OIl')).toBeNull()
  })
})

describe('base64 and hex', () => {
  it('round-trips bytes through standard and URL-safe base64', () => {
    const bytes = Uint8Array.from([251, 255, 0, 62, 63, 1])
    expect(base64Decode(base64Encode(bytes))).toEqual(bytes)
    const url = base64UrlEncode(bytes)
    expect(url).not.toMatch(/[+/=]/)
    expect(base64Decode(url)).toEqual(bytes)
  })

  it('returns null for text that is not base64', () => {
    expect(base64Decode('not base64!')).toBeNull()
  })

  it('round-trips hex and refuses odd or non-hex input', () => {
    expect(hexEncode(Uint8Array.from([0, 15, 255]))).toBe('000fff')
    expect(hexDecode('000fff')).toEqual(Uint8Array.from([0, 15, 255]))
    expect(hexDecode('abc')).toBeNull()
    expect(hexDecode('zz')).toBeNull()
  })
})
