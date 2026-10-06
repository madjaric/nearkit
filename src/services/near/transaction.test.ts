import { describe, expect, it } from 'vitest'
import { base58Decode, hexEncode } from '@/lib/encoding'
import {
  deserializeSignedTransaction,
  deserializeTransaction,
  jsonArgs,
  serializeSignedTransaction,
  serializeTransaction,
  TransactionFormatError,
  transactionDigest,
  transactionHash,
  type NearTransaction,
} from './transaction'

const hash32 = base58Decode('244ZQ9cgj3CQ6bWBdytfrJMuMQ1jdXLFGnr4HhvtCTnM') as Uint8Array
const KEY = 'ed25519:Anu7LYDfpLtkP7E16LT9imXF694BdQaa9ufVkQiwTQxC'

describe('NEAR transaction wire format', () => {
  it('matches the reference serialization of a transfer (near-api-js test vector)', () => {
    const tx: NearTransaction = { signerId: 'test.near', publicKey: KEY, nonce: 1n, receiverId: 'whatever.near', blockHash: hash32, actions: [{ type: 'Transfer', deposit: 1n }] }
    expect(hexEncode(serializeTransaction(tx))).toBe(
      '09000000746573742e6e65617200917b3d268d4b58f7fec1b150bd68d69be3ee5d4cc39855e341538465bb77860d01000000000000000d00000077686174657665722e6e6561720fa473fd26901df296be6adc4cc4df34d040efa2435224b6986910e630c2fef6010000000301000000000000000000000000000000',
    )
  })

  it('lays out a function call field by field: method, JSON args, u64 gas, u128 deposit', () => {
    const tx: NearTransaction = {
      signerId: 'a.testnet',
      publicKey: KEY,
      nonce: 258n,
      receiverId: 'wrap.testnet',
      blockHash: hash32,
      actions: [{ type: 'FunctionCall', methodName: 'near_deposit', args: jsonArgs({}), gas: 10n ** 13n, deposit: 10n ** 23n }],
    }
    const bytes = serializeTransaction(tx)
    const tail = hexEncode(bytes.subarray(bytes.length - (4 + 1 + 4 + 12 + 4 + 2 + 8 + 16)))
    expect(tail).toBe(
      [
        '01000000', // one action
        '02', // FunctionCall
        '0c000000' + hexEncode(new TextEncoder().encode('near_deposit')),
        '02000000' + '7b7d', // "{}"
        '00a0724e18090000', // 10 TGas, u64 little-endian
        '000080f64ae1c7022d15000000000000', // 0.1 NEAR = 0x152d02c7e14af6800000, u128 little-endian
      ].join(''),
    )
    expect(hexEncode(bytes.subarray(0, 13))).toBe('09000000' + hexEncode(new TextEncoder().encode('a.testnet')))
  })

  it('reads back exactly what it wrote, for every action NEARKITS builds', () => {
    const tx: NearTransaction = {
      signerId: 'f'.repeat(64),
      publicKey: KEY,
      nonce: 2n ** 60n + 7n,
      receiverId: 'usdt.itachicara.testnet',
      blockHash: hash32,
      actions: [
        { type: 'FunctionCall', methodName: 'ft_transfer', args: jsonArgs({ receiver_id: 'bob.testnet', amount: '5' }), gas: 10n ** 13n, deposit: 1n },
        { type: 'Transfer', deposit: 2n ** 127n },
        { type: 'AddKey', publicKey: KEY, permission: 'FullAccess' },
        { type: 'AddKey', publicKey: KEY, permission: { receiverId: 'app.testnet', methodNames: ['a', 'b'], allowance: 5n } },
        { type: 'AddKey', publicKey: KEY, permission: { receiverId: 'app.testnet', methodNames: [], allowance: null } },
        { type: 'DeleteKey', publicKey: KEY },
      ],
    }
    expect(deserializeTransaction(serializeTransaction(tx))).toEqual(tx)
  })

  it('refuses what NEARKITS never builds: other key types, other actions, trailing bytes, out-of-range numbers', () => {
    const base: NearTransaction = { signerId: 'a.testnet', publicKey: KEY, nonce: 1n, receiverId: 'b.testnet', blockHash: hash32, actions: [{ type: 'Transfer', deposit: 1n }] }
    expect(() => serializeTransaction({ ...base, publicKey: 'secp256k1:abc' })).toThrow(TransactionFormatError)
    expect(() => serializeTransaction({ ...base, actions: [] })).toThrow(/at least one action/)
    expect(() => serializeTransaction({ ...base, nonce: 2n ** 64n })).toThrow(/out of range/)
    expect(() => serializeTransaction({ ...base, actions: [{ type: 'Transfer', deposit: -1n }] })).toThrow(/out of range/)
    expect(() => serializeTransaction({ ...base, blockHash: new Uint8Array(31) })).toThrow(/32 bytes/)
    const bytes = serializeTransaction(base)
    // Action tag 7 (DeleteAccount) in place of Transfer.
    const deleteAccount = Uint8Array.from(bytes)
    deleteAccount[bytes.length - 17] = 7
    expect(() => deserializeTransaction(deleteAccount)).toThrow(/not one NEARKITS builds/)
    expect(() => deserializeTransaction(Uint8Array.from([...bytes, 0]))).toThrow(/after the transaction/)
    expect(() => deserializeTransaction(bytes.subarray(0, 20))).toThrow(/end too early/)
  })
})

describe('signed transactions', () => {
  async function keyPair() {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
    const { base58Encode } = await import('@/lib/encoding')
    return { pair, publicKey: `ed25519:${base58Encode(raw)}` }
  }

  it('appends the signature over SHA-256 of the transaction; the hash is that digest in base58', async () => {
    const { pair, publicKey } = await keyPair()
    const tx: NearTransaction = { signerId: 'a.testnet', publicKey, nonce: 9n, receiverId: 'b.testnet', blockHash: hash32, actions: [{ type: 'Transfer', deposit: 10n }] }
    const digest = await transactionDigest(serializeTransaction(tx))
    const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, digest))
    const signed = serializeSignedTransaction(tx, signature)
    const read = deserializeSignedTransaction(signed)
    expect(read.transaction).toEqual(tx)
    expect(read.signature).toEqual(signature)
    expect(read.transactionBytes).toEqual(serializeTransaction(tx))
    expect(await crypto.subtle.verify({ name: 'Ed25519' }, pair.publicKey, read.signature, await transactionDigest(read.transactionBytes))).toBe(true)
    const { base58Encode } = await import('@/lib/encoding')
    expect(await transactionHash(tx)).toBe(base58Encode(digest))
    expect(() => serializeSignedTransaction(tx, new Uint8Array(63))).toThrow(/64 bytes/)
  })
})
