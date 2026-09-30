import { describe, expect, it } from 'vitest'
import { base58Decode, base58Encode, base64Encode, hexEncode } from '@/lib/encoding'
import { FEES, GAS_BUY_PRICE, MIN_GAS_PRICE, TGAS } from '@/services/near/gas'
import { jsonArgs, serializeSignedTransaction, serializeTransaction, transactionDigest, type TxAction } from '@/services/near/transaction'
import { createFakeChain } from './fakeChain'
import { blockHashOf, FAKE_GAS_BURN } from './fakeRuntime'

const ONE = 10n ** 24n
const USDT = 'usdt.testnet'

async function signerOn(chain: ReturnType<typeof createFakeChain>, amount: bigint) {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const accountId = hexEncode(raw)
  chain.fund(accountId, amount)
  let nonce = BigInt(chain.height()) * 1_000_000n
  return {
    accountId,
    async send(receiverId: string, actions: TxAction[]) {
      nonce += 1n
      const tx = { signerId: accountId, publicKey: `ed25519:${base58Encode(raw)}`, nonce, receiverId, blockHash: base58Decode(blockHashOf(chain.height())) as Uint8Array, actions }
      const digest = await transactionDigest(serializeTransaction(tx))
      const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, digest))
      const body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'send_tx',
        params: { signed_tx_base64: base64Encode(serializeSignedTransaction(tx, signature)), wait_until: 'EXECUTED_OPTIMISTIC' },
      }
      return (await (await chain.fetch('https://rpc.test', { method: 'POST', body: JSON.stringify(body) })).json()) as {
        result?: unknown
        error?: { cause: { name: string }; data: string }
      }
    },
    balance: async () => {
      const body = { jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: accountId } }
      return BigInt(((await (await chain.fetch('https://rpc.test', { method: 'POST', body: JSON.stringify(body) })).json()) as { result: { amount: string } }).result.amount)
    },
  }
}

const register = (accountId: string): TxAction => ({
  type: 'FunctionCall',
  methodName: 'storage_deposit',
  args: jsonArgs({ account_id: accountId, registration_only: true }),
  gas: 300n * TGAS,
  deposit: 10n ** 21n,
})

/** nearcore tx_cost for this one call to another account: send fees at the gas price, the rest at the purchase floor. */
function held(action: Extract<TxAction, { type: 'FunctionCall' }>): bigint {
  const bytes = BigInt(action.methodName.length + action.args.length)
  const burnt = FEES.receipt.send + FEES.functionCall.send + bytes * FEES.functionCallByte.sendNotSir
  const bought = action.gas + FEES.receipt.exec + FEES.functionCall.exec + bytes * FEES.functionCallByte.exec
  return burnt * MIN_GAS_PRICE + bought * GAS_BUY_PRICE
}

describe('the fake chain holds gas like mainnet (NEP-642)', () => {
  const token = { [USDT]: { symbol: 'USDT', decimals: 6, boundsMin: 10n ** 21n } }
  const accounts = { [USDT]: { amount: ONE, code: true } }

  it('refuses a transaction the signer can’t buy its gas for, even though its real cost is tiny', async () => {
    const chain = createFakeChain({ accounts, tokens: token })
    const probe = await signerOn(chain, ONE)
    const action = register(probe.accountId) as Extract<TxAction, { type: 'FunctionCall' }>
    const need = action.deposit + held(action)
    const s = await signerOn(chain, need - 1n)
    const r = await s.send(USDT, [register(s.accountId)])
    expect(r.error?.cause.name).toBe('INVALID_TRANSACTION')
    expect(r.error?.data).toContain('NotEnoughBalance')
    expect(chain.sent).toHaveLength(0)
  })

  it('accepts it with exactly the deposit and the gas held, and refunds all but the burn right after', async () => {
    const chain = createFakeChain({ accounts, tokens: token })
    const probe = await signerOn(chain, ONE)
    const action = register(probe.accountId) as Extract<TxAction, { type: 'FunctionCall' }>
    const need = action.deposit + held(action)
    const s = await signerOn(chain, need)
    expect((await s.send(USDT, [register(s.accountId)])).result).toBeDefined()
    expect(await s.balance()).toBe(need - action.deposit - FAKE_GAS_BURN)
  })

  it('can land the refund late: it arrives after the signer’s balance was read a set number of times', async () => {
    const chain = createFakeChain({ accounts, tokens: token })
    const s = await signerOn(chain, ONE)
    chain.lateRefunds(2)
    const action = register(s.accountId) as Extract<TxAction, { type: 'FunctionCall' }>
    await s.send(USDT, [action])
    const after = ONE - action.deposit - FAKE_GAS_BURN
    expect(await s.balance()).toBe(after - (held(action) - FAKE_GAS_BURN))
    expect(await s.balance()).toBe(after - (held(action) - FAKE_GAS_BURN))
    expect(await s.balance()).toBe(after)
  })
})
