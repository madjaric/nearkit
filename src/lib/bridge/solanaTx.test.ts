import { describe, expect, it } from 'vitest'
import { base58Decode, base58Encode } from '@/lib/encoding'
import { compactU16, solTransferMessage, unsignedSolTransfer } from './solanaTx'

/** A SOL transfer, byte by byte: the format a Solana wallet parses before it signs. */

const FROM = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => i + 1))
const TO = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => 200 - i))
const HASH = base58Encode(Uint8Array.from({ length: 32 }, () => 7))

describe('compact-u16', () => {
  it('is one byte up to 127, two up to 16383, three above', () => {
    expect(compactU16(0)).toEqual([0])
    expect(compactU16(127)).toEqual([0x7f])
    expect(compactU16(128)).toEqual([0x80, 0x01])
    expect(compactU16(16383)).toEqual([0xff, 0x7f])
    expect(compactU16(16384)).toEqual([0x80, 0x80, 0x01])
    expect(() => compactU16(70000)).toThrow()
  })
})

describe('a SOL transfer', () => {
  const lamports = 1_234_567_890n
  const msg = solTransferMessage({ from: FROM, to: TO, lamports, recentBlockhash: HASH })

  it('signs as the sender, with System Program as the one read-only account', () => {
    expect([...msg.slice(0, 3)]).toEqual([1, 0, 1])
    expect(msg[3]).toBe(3)
    expect([...msg.slice(4, 36)]).toEqual([...(base58Decode(FROM) as Uint8Array)])
    expect([...msg.slice(36, 68)]).toEqual([...(base58Decode(TO) as Uint8Array)])
    expect([...msg.slice(68, 100)]).toEqual(new Array(32).fill(0))
    expect([...msg.slice(100, 132)]).toEqual(new Array(32).fill(7))
  })

  it('carries one Transfer instruction: program 2, accounts 0 → 1, data = 2 (u32 LE) then the lamports (u64 LE)', () => {
    const ix = [...msg.slice(132)]
    expect(ix.slice(0, 5)).toEqual([1, 2, 2, 0, 1])
    expect(ix[5]).toBe(12)
    expect(ix.slice(6, 10)).toEqual([2, 0, 0, 0])
    const amount = ix.slice(10, 18).reduce((n, b, i) => n | (BigInt(b) << BigInt(8 * i)), 0n)
    expect(amount).toBe(lamports)
    expect(msg.length).toBe(132 + 18)
  })

  it('leaves one empty signature in front of the message for the wallet', () => {
    const tx = unsignedSolTransfer({ from: FROM, to: TO, lamports, recentBlockhash: HASH })
    expect(tx[0]).toBe(1)
    expect([...tx.slice(1, 65)]).toEqual(new Array(64).fill(0))
    expect([...tx.slice(65)]).toEqual([...msg])
  })

  it('refuses what isn’t a transfer: a bad address or blockhash, nothing or too much, to itself', () => {
    const ok = { from: FROM, to: TO, lamports: 1n, recentBlockhash: HASH }
    expect(() => solTransferMessage({ ...ok, to: '0xabc' })).toThrow(/deposit address/)
    expect(() => solTransferMessage({ ...ok, from: 'short' })).toThrow(/sending address/)
    expect(() => solTransferMessage({ ...ok, recentBlockhash: '111' })).toThrow(/blockhash/)
    expect(() => solTransferMessage({ ...ok, lamports: 0n })).toThrow()
    expect(() => solTransferMessage({ ...ok, lamports: 1n << 64n })).toThrow()
    expect(() => solTransferMessage({ ...ok, to: FROM })).toThrow(/own address/)
  })
})
