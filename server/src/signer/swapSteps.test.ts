import { beforeEach, describe, expect, it } from 'vitest'
import { NETWORKS } from '@/config/networks'
import { mulBps } from '@/lib/amounts'
import { base64Decode } from '@/lib/encoding'
import { NEARKIT_FEE_BPS } from '@/lib/fees'
import { dclSwapMsg } from '@/services/dcl/swap'
import { deserializeSignedTransaction } from '@/services/near/transaction'
import type { WalletAction, WalletOperation, WalletTxPlan } from '../custody/policy'
import type { TradingSigner } from '../custody/signer'
import { SqliteDatabase } from '../db/sqlite'
import type { SignerChain } from './chain'
import { ownerKeypair, testSigner } from './testing'

/**
 * A swap's earlier transactions only register storage, but each one moves NEAR to the contract it
 * calls. The signer signs none of them before it has checked the swap's route itself (Rhea's
 * signature, or the pools on chain, and its own quote): otherwise a compromised app could name any
 * contract as a "route token" and collect registration deposits from every wallet.
 */

const MAIN = NETWORKS.mainnet
const OWNER = 'alice.near'
const ATTACKER = 'attacker-token.near'
const TGAS = 10n ** 12n
const TENTH = 10n ** 23n
const BLOCK = new Uint8Array(32).fill(7)

let signer: TradingSigner
let wallet: { accountId: string; publicKey: string; network: string }
let oracleCalls: number
let oracleAnswer: () => Promise<bigint>

beforeEach(async () => {
  oracleCalls = 0
  oracleAnswer = async () => 1_000_000n
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
    oracle: {
      expectedOut: async () => {
        oracleCalls++
        return oracleAnswer()
      },
    },
    config: { feeRecipient: 'nearkitfee.near', recipient: 'nearkits.com' },
  })
  signer = s.signer
  const k = await signer.createKey({ userId: 101, owner: { accountId: OWNER, publicKey: owner.publicKey } })
  wallet = { accountId: k.accountId, publicKey: k.publicKey, network: 'mainnet' }
})

const registration = (account: string): WalletAction => ({
  kind: 'call',
  method: 'storage_deposit',
  args: { account_id: account, registration_only: true },
  gas: (30n * TGAS).toString(),
  deposit: TENTH.toString(),
})
const sign = (intentId: string, step: number, op: WalletOperation, plan: WalletTxPlan[]) =>
  signer.sign({ wallet, intentId, step, op, plan, nonce: BigInt(1000 + step), blockHash: BLOCK })
const deposits = (signed: string) =>
  deserializeSignedTransaction(base64Decode(signed) as Uint8Array).transaction.actions.reduce((sum, a) => sum + ('deposit' in a ? BigInt(a.deposit) : 0n), 0n)

describe('a swap’s registration steps', () => {
  it('aggregator: a route Rhea never signed gets no step signed, not even a registration', async () => {
    const route = {
      router: 'aggregator' as const,
      routeIn: MAIN.wrapContract,
      routeOut: ATTACKER,
      nativeIn: false,
      nativeOut: false,
      amountIn: 1n,
      receiver: 'aggregatedex.near',
      msg: 'NOT-A-SIGNED-ROUTE',
      routeTokens: [MAIN.wrapContract, ATTACKER],
      minOut: 1n,
    }
    const op: WalletOperation = { kind: 'swap', authorizedMinOut: 1n, route }
    const plan: WalletTxPlan[] = [
      { receiverId: ATTACKER, actions: [registration(wallet.accountId)], label: 'register' },
      {
        receiverId: MAIN.wrapContract,
        actions: [
          { kind: 'call', method: 'ft_transfer_call', args: { receiver_id: 'aggregatedex.near', amount: '1', msg: route.msg }, gas: (300n * TGAS).toString(), deposit: '1' },
        ],
        label: 'swap',
      },
    ]
    await expect(sign('evil-agg', 0, op, plan)).rejects.toThrow(/route message/)
    await expect(sign('evil-agg', 1, op, plan)).rejects.toThrow(/route message/)
  })

  it('DCL: the signer asks for its own quote before it signs a registration, and a route it can’t price signs nothing', async () => {
    const pools = [`${ATTACKER}|${MAIN.wrapContract}|2000`]
    const amountIn = 1_000_000n
    const fee = mulBps(amountIn, NEARKIT_FEE_BPS)
    const msg = dclSwapMsg({ pools, outputToken: ATTACKER, minOut: 1n, skipUnwrapNear: false })
    const route = {
      router: 'dcl' as const,
      routeIn: MAIN.wrapContract,
      routeOut: ATTACKER,
      nativeIn: true,
      nativeOut: false,
      amountIn,
      receiver: MAIN.dex.dcl.contract,
      msg,
      routeTokens: [MAIN.wrapContract, ATTACKER],
      minOut: 1n,
      signedMin: 1n,
      pools,
      direct: { swapAmount: amountIn - fee, fee, feeRecipient: 'nearkitfee.near' },
    }
    const op: WalletOperation = { kind: 'swap', authorizedMinOut: 1n, route }
    const plan: WalletTxPlan[] = [
      { receiverId: ATTACKER, actions: [registration(wallet.accountId)], label: 'register' },
      {
        receiverId: MAIN.wrapContract,
        actions: [
          { kind: 'call', method: 'near_deposit', args: {}, gas: (10n * TGAS).toString(), deposit: amountIn.toString() },
          { kind: 'call', method: 'ft_transfer', args: { receiver_id: 'nearkitfee.near', amount: fee.toString() }, gas: (10n * TGAS).toString(), deposit: '1' },
          {
            kind: 'call',
            method: 'ft_transfer_call',
            args: { receiver_id: MAIN.dex.dcl.contract, amount: (amountIn - fee).toString(), msg },
            gas: (300n * TGAS).toString(),
            deposit: '1',
          },
        ],
        label: 'swap',
      },
    ]
    // The pools don't exist: the DCL contract quotes nothing, so the registration isn't signed.
    oracleAnswer = async () => {
      throw new Error('pool not found')
    }
    await expect(sign('evil-dcl', 0, op, plan)).rejects.toThrow(/could not check the price/)
    expect(oracleCalls).toBe(1)
    // Pools that do quote (at the route's minimum): the registration on a route token is signed, after the signer's own check.
    oracleAnswer = async () => 1n
    const signed = await sign('real-dcl', 0, op, plan)
    expect(oracleCalls).toBe(2)
    expect(deposits(signed.base64)).toBe(TENTH)
  })
})
