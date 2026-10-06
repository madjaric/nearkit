import { beforeEach, describe, expect, it } from 'vitest'
import { NETWORKS } from '@/config/networks'
import type { WalletOperation, WalletTxPlan } from '../custody/policy'
import type { TradingSigner } from '../custody/signer'
import { SqliteDatabase } from '../db/sqlite'
import type { SignerChain } from './chain'
import { ownerKeypair, testSigner } from './testing'

/**
 * Storage registrations attach NEAR to the contract they call, and that contract keeps it. Each one
 * is capped (0.1 NEAR), and the signer also caps what one wallet pays for them in a day: whatever
 * contract a request names, a wallet's NEAR can't be drained 0.1 NEAR at a time.
 */

const MAIN = NETWORKS.mainnet
const OWNER = 'alice.near'
const TOKEN = 'some-token.near'
const TENTH = 10n ** 23n
const DAY = 24 * 60 * 60_000

let signer: TradingSigner
let wallet: { accountId: string; publicKey: string; network: string }
let now: number

beforeEach(async () => {
  now = 10_000_000
  const owner = await ownerKeypair()
  const chain: SignerChain = {
    permission: async (a, k) => (a === OWNER && k === owner.publicKey ? 'full' : 'missing'),
    accountExists: async () => true,
    fullAccessKeys: async () => [],
    tokenBalance: async () => 0n,
  }
  const s = await testSigner(await SqliteDatabase.open(null), {
    network: MAIN,
    chain,
    now: () => now,
    oracle: { expectedOut: async () => 1n },
    config: { feeRecipient: 'nearkitfee.near', recipient: 'nearkits.com' },
  })
  signer = s.signer
  const k = await signer.createKey({ userId: 101, owner: { accountId: OWNER, publicKey: owner.publicKey } })
  wallet = { accountId: k.accountId, publicKey: k.publicKey, network: 'mainnet' }
})

/** A token withdrawal to the owner wallet that registers it first, paying `deposit`. */
const withdrawal = (deposit: bigint): { op: WalletOperation; plan: WalletTxPlan[] } => ({
  op: { kind: 'withdraw-token', token: TOKEN, to: OWNER, amount: 1n, registration: deposit },
  plan: [
    {
      receiverId: TOKEN,
      actions: [
        { kind: 'call', method: 'storage_deposit', args: { account_id: OWNER, registration_only: true }, gas: (30n * 10n ** 12n).toString(), deposit: deposit.toString() },
        { kind: 'call', method: 'ft_transfer', args: { receiver_id: OWNER, amount: '1' }, gas: (10n * 10n ** 12n).toString(), deposit: '1' },
      ],
      label: 'withdraw',
    },
  ],
})
const send = (i: number, deposit = TENTH) => {
  const { op, plan } = withdrawal(deposit)
  return signer.sign({ wallet, intentId: `w${i}`, step: 0, op, plan, nonce: BigInt(100 + i), blockHash: new Uint8Array(32).fill(3) })
}

describe('registration deposits a wallet pays in a day', () => {
  it('stop at 0.5 NEAR in any 24 hours, then resume as the day rolls on', async () => {
    for (let i = 0; i < 5; i++) await send(i)
    await expect(send(5)).rejects.toThrow(/registrations/)
    // The same request again is the same answer (one signature per step), not a new payment.
    await expect(send(4)).resolves.toBeTruthy()
    now += DAY + 1
    await expect(send(6)).resolves.toBeTruthy()
  })

  it('ordinary registrations (0.00125 NEAR) fit a hundred times and more', { timeout: 60_000 }, async () => {
    for (let i = 0; i < 120; i++) await send(i, 1_250_000_000_000_000_000_000n)
  })

  it('a withdrawal that registers nothing is never limited by it', async () => {
    for (let i = 0; i < 5; i++) await send(i)
    const plan: WalletTxPlan[] = [{ receiverId: OWNER, actions: [{ kind: 'transfer', deposit: '5' }], label: 'w' }]
    await expect(
      signer.sign({ wallet, intentId: 'n1', step: 0, op: { kind: 'withdraw-near', to: OWNER, amount: 5n }, plan, nonce: 900n, blockHash: new Uint8Array(32).fill(3) }),
    ).resolves.toBeTruthy()
  })
})
