import { base58Decode } from '@/lib/encoding'

/**
 * A SOL transfer as a Solana wallet signs it: one System Program transfer from the user's address
 * to the quote's deposit address, in Solana's legacy transaction format. The wallet signs and sends
 * it (Wallet Standard `solana:signAndSendTransaction`); NEARKITS only builds the bytes and never
 * holds a key. Serialized here so no Solana library ships to every visitor.
 *
 * Format (docs.solana.com, "Transactions"): compact-u16 signature count, the signatures (64 bytes
 * each, zero until signed), then the message: header [required signatures, read-only signed,
 * read-only unsigned], compact-u16 account count and the 32-byte keys (signer first), the recent
 * blockhash, compact-u16 instruction count, and each instruction: program index, compact-u16
 * account indexes, compact-u16 data length and the data. System Program's Transfer is instruction 2
 * (u32 little-endian) followed by the lamports (u64 little-endian).
 */

/** System Program (32 zero bytes, base58 "11111111111111111111111111111111"). */
const SYSTEM_PROGRAM = new Uint8Array(32)
const TRANSFER = 2
const U64_MAX = (1n << 64n) - 1n

export function compactU16(n: number): number[] {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new Error('compact-u16 out of range')
  const out: number[] = []
  let v = n
  for (;;) {
    const b = v & 0x7f
    v >>= 7
    if (v === 0) {
      out.push(b)
      return out
    }
    out.push(b | 0x80)
  }
}

const key = (address: string, what: string): Uint8Array => {
  const k = base58Decode(address)
  if (!k || k.length !== 32) throw new Error(`${what} isn’t a Solana address`)
  return k
}

const u32le = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
const u64le = (n: bigint) => Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn))

export interface SolTransfer {
  from: string
  to: string
  lamports: bigint
  /** A recent blockhash (base58): the transaction is valid for about a minute after it. */
  recentBlockhash: string
}

/** The message a SOL transfer signs. */
export function solTransferMessage(t: SolTransfer): Uint8Array {
  const from = key(t.from, 'The sending address')
  const to = key(t.to, 'The deposit address')
  const hash = base58Decode(t.recentBlockhash)
  if (!hash || hash.length !== 32) throw new Error('The recent blockhash isn’t 32 bytes')
  if (t.from === t.to) throw new Error('A transfer to its own address')
  if (t.lamports <= 0n || t.lamports > U64_MAX) throw new Error('The amount isn’t a SOL amount')
  const data = [...u32le(TRANSFER), ...u64le(t.lamports)]
  return Uint8Array.from([
    // Header: the sender signs; System Program is the one read-only unsigned account.
    1,
    0,
    1,
    ...compactU16(3),
    ...from,
    ...to,
    ...SYSTEM_PROGRAM,
    ...hash,
    ...compactU16(1),
    2,
    ...compactU16(2),
    0,
    1,
    ...compactU16(data.length),
    ...data,
  ])
}

/** The whole transaction, its one signature left empty for the wallet to fill. */
export function unsignedSolTransfer(t: SolTransfer): Uint8Array {
  return Uint8Array.from([...compactU16(1), ...new Uint8Array(64), ...solTransferMessage(t)])
}
