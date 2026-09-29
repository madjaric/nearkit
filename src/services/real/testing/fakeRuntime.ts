import { base58Decode, base58Encode, base64Encode, hexDecode } from '@/lib/encoding'
import type { RpcOutcomeWithId, RpcReceipt, RpcTxResult } from '@/services/near/rpc'
import { deserializeSignedTransaction, transactionDigest, type NearTransaction, type TxAction } from '@/services/near/transaction'
import type { FakeToken } from './fakeChain'

/**
 * A tiny NEAR runtime for tests: it executes signed transactions the way the
 * chain would for the contracts NearKit touches, and returns the outcome in the
 * RPC's own shape (receipts, logs, statuses), so the code under test reads it
 * exactly as it reads the real chain.
 *
 * - Checks: signature (ed25519 over SHA-256), full-access key, nonce, expiry of
 *   the anchor block, enough NEAR for deposits and gas.
 * - Accounts: Transfer (creating implicit accounts), AddKey, DeleteKey.
 * - NEP-141/145 tokens: storage_deposit, ft_transfer, ft_transfer_call; the wrap
 *   contract also near_deposit / near_withdraw with its legacy text logs.
 * - One exchange (Rhea's classic `ft_on_transfer` swap msg) at a configured rate,
 *   enforcing each step's min_amount_out and delivering NEAR when asked to unwrap.
 * A failed receipt reverts its own changes and returns its deposits.
 */

export interface FakeAccount {
  amount: bigint
  storageUsage?: number
  code?: boolean
  global?: string
  keys?: Record<string, 'full' | 'function-call'>
}

export interface RuntimeState {
  accounts: Map<string, FakeAccount>
  tokens: Map<string, FakeToken>
  nonces: Map<string, bigint>
  txs: Map<string, RpcTxResult>
  height: { value: number }
  validity: number
  wrapContract: string
  exchange: { contract: string; rate: (tokenIn: string, tokenOut: string, amountIn: bigint) => bigint } | null
}

/** Gas NearKit's fake chain burns per transaction: 0.0003 NEAR. */
export const FAKE_GAS_BURN = 3n * 10n ** 20n

export class TxRejection extends Error {
  constructor(readonly kind: string) {
    super(kind)
    this.name = 'TxRejection'
  }
}

const nonceKey = (account: string, key: string) => `${account}\u0000${key}`

export function blockHashOf(height: number): string {
  const bytes = new Uint8Array(32).fill(7)
  new DataView(bytes.buffer).setUint32(0, height, true)
  return base58Encode(bytes)
}

export function heightOfBlock(hash: Uint8Array): number | null {
  if (hash.length !== 32 || hash.slice(4).some((b) => b !== 7)) return null
  return new DataView(Uint8Array.from(hash).buffer).getUint32(0, true)
}

/** The implicit account's own key: its ID is the public key in hex. */
export function implicitKeyOf(accountId: string): string | null {
  const raw = /^[0-9a-f]{64}$/.test(accountId) ? hexDecode(accountId) : null
  return raw ? `ed25519:${base58Encode(raw)}` : null
}

const b64json = (value: unknown) => base64Encode(new TextEncoder().encode(JSON.stringify(value)))
const ftEvent = (from: string, to: string, amount: bigint) =>
  `EVENT_JSON:${JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer', data: [{ old_owner_id: from, new_owner_id: to, amount: amount.toString() }] })}`

function rpcAction(a: TxAction): unknown {
  switch (a.type) {
    case 'Transfer':
      return { Transfer: { deposit: a.deposit.toString() } }
    case 'FunctionCall':
      return { FunctionCall: { method_name: a.methodName, args: base64Encode(a.args), gas: Number(a.gas), deposit: a.deposit.toString() } }
    case 'AddKey':
      return { AddKey: { public_key: a.publicKey, access_key: { nonce: 0, permission: a.permission === 'FullAccess' ? 'FullAccess' : { FunctionCall: a.permission } } } }
    case 'DeleteKey':
      return { DeleteKey: { public_key: a.publicKey } }
  }
}

class Panic extends Error {}

export function createRuntime(state: RuntimeState) {
  const { accounts, tokens, nonces } = state
  let receiptSeq = 0

  function snapshot() {
    const acc = new Map([...accounts].map(([k, v]) => [k, { ...v, keys: v.keys ? { ...v.keys } : undefined }]))
    const tok = new Map([...tokens].map(([k, t]) => [k, { balances: new Map(t.balances), registered: new Set(t.registered) }]))
    const non = new Map(nonces)
    return () => {
      accounts.clear()
      for (const [k, v] of acc) accounts.set(k, v)
      for (const [k, t] of tok) {
        const live = tokens.get(k)
        if (live) {
          live.balances = t.balances
          live.registered = t.registered
        }
      }
      nonces.clear()
      for (const [k, v] of non) nonces.set(k, v)
    }
  }

  const account = (id: string) => {
    const a = accounts.get(id)
    if (!a) throw new Panic(`account ${id} does not exist`)
    return a
  }

  function credit(id: string, amount: bigint) {
    const existing = accounts.get(id)
    if (existing) {
      existing.amount += amount
      return
    }
    const key = implicitKeyOf(id)
    if (!key) throw new Panic(`AccountDoesNotExist: ${id}`)
    accounts.set(id, { amount, keys: { [key]: 'full' } })
    nonces.set(nonceKey(id, key), BigInt(state.height.value) * 1_000_000n)
  }

  function tokenOf(id: string): FakeToken {
    const t = tokens.get(id)
    if (!t) throw new Panic(`CodeDoesNotExist: ${id}`)
    return t
  }

  const registered = (t: FakeToken, id: string) => t.boundsMin === null || t.registered.has(id) || (state.exchange !== null && id === state.exchange.contract)

  function moveToken(contract: string, from: string, to: string, amount: bigint) {
    const t = tokenOf(contract)
    const have = t.balances.get(from) ?? 0n
    if (amount <= 0n) throw new Panic('The amount should be a positive number')
    if (have < amount) throw new Panic('The account doesn’t have enough balance')
    if (!registered(t, to)) throw new Panic(`The account ${to} is not registered`)
    t.balances.set(from, have - amount)
    t.balances.set(to, (t.balances.get(to) ?? 0n) + amount)
  }

  const transferLog = (contract: string, from: string, to: string, amount: bigint) =>
    contract === state.wrapContract ? `Transfer ${amount} from ${from} to ${to}` : ftEvent(from, to, amount)

  interface Exec {
    predecessor: string
    receiver: string
    actions: unknown[]
    logs: string[]
    ok: boolean
    value: unknown
    failure?: unknown
    after: Exec[]
  }

  /** Rhea's classic exchange: `ft_on_transfer` with a swap message. Returns the unused amount. */
  function swap(sender: string, msgText: string, trail: Exec[]): bigint {
    const ex = state.exchange as NonNullable<RuntimeState['exchange']>
    const msg = JSON.parse(msgText) as { actions: { token_in: string; token_out: string; amount_in?: string; min_amount_out: string }[]; skip_unwrap_near?: boolean }
    let out = 0n
    let outToken = ''
    let carry = 0n
    msg.actions.forEach((a, i) => {
      const input = a.amount_in !== undefined ? BigInt(a.amount_in) : carry
      const got = ex.rate(a.token_in, a.token_out, input)
      if (got < BigInt(a.min_amount_out)) throw new Panic('ERR68: slippage error')
      carry = got
      outToken = a.token_out
      // A path ends where the next step starts a new one (it carries amount_in) or at the last step.
      if (msg.actions[i + 1]?.amount_in !== undefined || i === msg.actions.length - 1) out += got
    })
    const book = tokenOf(outToken)
    book.balances.set(ex.contract, (book.balances.get(ex.contract) ?? 0n) - out)
    if (outToken === state.wrapContract && msg.skip_unwrap_near === false) {
      // Unwrap and pay NEAR: near_withdraw on the wrap contract, then a Transfer to the sender.
      trail.push({
        predecessor: ex.contract,
        receiver: state.wrapContract,
        actions: [{ FunctionCall: { method_name: 'near_withdraw', args: b64json({ amount: out.toString() }), gas: 1, deposit: '1' } }],
        logs: [`Withdraw ${out} NEAR from ${ex.contract}`],
        ok: true,
        value: '',
        after: [],
      })
      credit(sender, out)
      trail.push({ predecessor: ex.contract, receiver: sender, actions: [{ Transfer: { deposit: out.toString() } }], logs: [], ok: true, value: '', after: [] })
    } else {
      const t = book
      if (!registered(t, sender)) throw new Panic(`The account ${sender} is not registered`)
      t.balances.set(sender, (t.balances.get(sender) ?? 0n) + out)
      trail.push({
        predecessor: ex.contract,
        receiver: outToken,
        actions: [{ FunctionCall: { method_name: 'ft_transfer', args: b64json({ receiver_id: sender, amount: out.toString() }), gas: 1, deposit: '1' } }],
        logs: [transferLog(outToken, ex.contract, sender, out)],
        ok: true,
        value: '',
        after: [],
      })
    }
    return 0n
  }

  /** Runs one function call on a token contract; `trail` collects the receipts it spawns. */
  function call(receiver: string, predecessor: string, method: string, args: Record<string, unknown>, deposit: bigint, logs: string[], trail: Exec[]): unknown {
    const t = tokenOf(receiver)
    switch (method) {
      case 'storage_deposit': {
        if (t.boundsMin === null) throw new Panic('MethodNotFound')
        const id = typeof args.account_id === 'string' ? args.account_id : predecessor
        if (!t.registered.has(id)) {
          if (deposit < t.boundsMin) throw new Panic('The attached deposit is less than the minimum storage balance')
          t.registered.add(id)
        }
        return { total: t.boundsMin.toString(), available: '0' }
      }
      case 'ft_transfer': {
        if (deposit !== 1n) throw new Panic('Requires attached deposit of exactly 1 yoctoNEAR')
        const to = String(args.receiver_id)
        const amount = BigInt(String(args.amount))
        moveToken(receiver, predecessor, to, amount)
        logs.push(transferLog(receiver, predecessor, to, amount))
        return ''
      }
      case 'ft_transfer_call': {
        if (deposit !== 1n) throw new Panic('Requires attached deposit of exactly 1 yoctoNEAR')
        const to = String(args.receiver_id)
        const amount = BigInt(String(args.amount))
        if (!state.exchange || to !== state.exchange.contract) throw new Panic(`${to} has no ft_on_transfer`)
        moveToken(receiver, predecessor, to, amount)
        logs.push(transferLog(receiver, predecessor, to, amount))
        // ft_on_transfer runs in its own receipt: if it fails, the transfer is refunded in full.
        const inner: Exec[] = []
        const restore = snapshot()
        const onTransfer: Exec = {
          predecessor: receiver,
          receiver: to,
          actions: [{ FunctionCall: { method_name: 'ft_on_transfer', args: b64json({ sender_id: predecessor, amount: amount.toString(), msg: args.msg }), gas: 1, deposit: '0' } }],
          logs: [],
          ok: true,
          value: '0',
          after: [],
        }
        let unused = amount
        try {
          unused = swap(predecessor, String(args.msg ?? ''), inner)
          onTransfer.logs.push(`Swapped ${amount} ${receiver}`)
        } catch (e) {
          restore()
          onTransfer.ok = false
          onTransfer.failure = { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${(e as Error).message}` } } } }
          inner.length = 0
          unused = amount
        }
        onTransfer.after = inner
        trail.push(onTransfer)
        const used = amount - unused
        const resolve: Exec = {
          predecessor: receiver,
          receiver,
          actions: [{ FunctionCall: { method_name: 'ft_resolve_transfer', args: b64json({}), gas: 1, deposit: '0' } }],
          logs: [],
          ok: true,
          value: used.toString(),
          after: [],
        }
        if (unused > 0n) {
          t.balances.set(to, (t.balances.get(to) ?? 0n) - unused)
          t.balances.set(predecessor, (t.balances.get(predecessor) ?? 0n) + unused)
          resolve.logs.push(receiver === state.wrapContract ? `Refund ${unused} from ${to} to ${predecessor}` : ftEvent(to, predecessor, unused))
        }
        trail.push(resolve)
        return { resolved: used.toString() }
      }
      case 'near_deposit': {
        if (receiver !== state.wrapContract) throw new Panic('MethodNotFound')
        if (!registered(t, predecessor)) throw new Panic(`The account ${predecessor} is not registered`)
        t.balances.set(predecessor, (t.balances.get(predecessor) ?? 0n) + deposit)
        logs.push(`Deposit ${deposit} NEAR to ${predecessor}`)
        return ''
      }
      case 'near_withdraw': {
        if (receiver !== state.wrapContract || deposit !== 1n) throw new Panic('Requires attached deposit of exactly 1 yoctoNEAR')
        const amount = BigInt(String(args.amount))
        const have = t.balances.get(predecessor) ?? 0n
        if (have < amount) throw new Panic('The account doesn’t have enough balance')
        t.balances.set(predecessor, have - amount)
        logs.push(`Withdraw ${amount} NEAR from ${predecessor}`)
        credit(predecessor, amount)
        trail.push({ predecessor: receiver, receiver: predecessor, actions: [{ Transfer: { deposit: amount.toString() } }], logs: [], ok: true, value: '', after: [] })
        return ''
      }
      default:
        throw new Panic(`MethodNotFound: ${method}`)
    }
  }

  function flatten(execs: Exec[], out: { receipts: RpcReceipt[]; outcomes: RpcOutcomeWithId[] }): string[] {
    const ids: string[] = []
    for (const e of execs) {
      const id = `R${++receiptSeq}`
      ids.push(id)
      out.receipts.push({ receipt_id: id, predecessor_id: e.predecessor, receiver_id: e.receiver, receipt: { Action: { actions: e.actions } } })
      const index = out.outcomes.length
      out.outcomes.push({
        id,
        outcome: {
          logs: e.logs,
          receipt_ids: [],
          gas_burnt: 1,
          tokens_burnt: '0',
          executor_id: e.receiver,
          status: e.ok ? { SuccessValue: e.value === '' ? '' : b64json(e.value) } : { Failure: e.failure ?? { ActionError: { index: 0, kind: 'Panic' } } },
        },
      })
      const children = flatten(e.after, out)
      ;(out.outcomes[index] as RpcOutcomeWithId).outcome.receipt_ids = children
    }
    return ids
  }

  return {
    /** Executes a signed transaction; throws TxRejection when the chain would refuse it outright. */
    async execute(signedBase64: string): Promise<{ hash: string; result: RpcTxResult; tx: NearTransaction }> {
      let decoded
      try {
        decoded = deserializeSignedTransaction(Uint8Array.from(atob(signedBase64), (c) => c.charCodeAt(0)))
      } catch {
        throw new TxRejection('InvalidTransaction: malformed')
      }
      const { transaction: tx, signature, transactionBytes } = decoded
      const digest = await transactionDigest(transactionBytes)
      const hash = base58Encode(digest)
      const known = state.txs.get(hash)
      if (known) return { hash, result: known, tx }

      const signer = accounts.get(tx.signerId)
      if (!signer) throw new TxRejection('SignerDoesNotExist')
      if (signer.keys?.[tx.publicKey] !== 'full') throw new TxRejection('InvalidAccessKeyError: AccessKeyNotFound')
      const pub = base58Decode(tx.publicKey.slice('ed25519:'.length)) as Uint8Array<ArrayBuffer>
      const key = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify'])
      if (!(await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, digest))) throw new TxRejection('InvalidSignature')
      const current = nonces.get(nonceKey(tx.signerId, tx.publicKey)) ?? 0n
      if (tx.nonce <= current) throw new TxRejection('InvalidNonce')
      const anchor = heightOfBlock(tx.blockHash)
      if (anchor === null || anchor > state.height.value) throw new TxRejection('InvalidChain')
      if (state.height.value - anchor > state.validity) throw new TxRejection('Expired')
      const deposits = tx.actions.reduce((s, a) => s + (a.type === 'Transfer' || a.type === 'FunctionCall' ? a.deposit : 0n), 0n)
      if (signer.amount < deposits + FAKE_GAS_BURN) throw new TxRejection('NotEnoughBalance')

      // Accepted: the nonce is used and the gas is paid whatever the actions do.
      nonces.set(nonceKey(tx.signerId, tx.publicKey), tx.nonce)
      signer.amount -= deposits + FAKE_GAS_BURN
      state.height.value += 1

      const restore = snapshot()
      const logs: string[] = []
      const trail: Exec[] = []
      let value: unknown = ''
      let failure: unknown = null
      try {
        for (const a of tx.actions) {
          if (a.type === 'Transfer') credit(tx.receiverId, a.deposit)
          else if (a.type === 'AddKey' || a.type === 'DeleteKey') {
            if (tx.receiverId !== tx.signerId) throw new Panic('ActorNoPermission')
            const acct = account(tx.signerId)
            acct.keys ??= {}
            if (a.type === 'AddKey') {
              if (acct.keys[a.publicKey]) throw new Panic('AddKeyAlreadyExists')
              acct.keys[a.publicKey] = a.permission === 'FullAccess' ? 'full' : 'function-call'
              nonces.set(nonceKey(tx.signerId, a.publicKey), BigInt(state.height.value) * 1_000_000n)
            } else {
              if (!acct.keys[a.publicKey]) throw new Panic('DeleteKeyDoesNotExist')
              delete acct.keys[a.publicKey]
            }
          } else {
            if (a.deposit > 0n) credit(tx.receiverId, a.deposit)
            const args = a.args.length ? (JSON.parse(new TextDecoder().decode(a.args)) as Record<string, unknown>) : {}
            value = call(tx.receiverId, tx.signerId, a.methodName, args, a.deposit, logs, trail)
          }
        }
      } catch (e) {
        if (!(e instanceof Panic)) throw e
        restore()
        // A failed receipt returns its deposits to the signer.
        const signerNow = accounts.get(tx.signerId)
        if (signerNow) signerNow.amount += deposits
        failure = { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${e.message}` } } } }
        trail.length = 0
        logs.length = 0
      }

      const first: Exec = {
        predecessor: tx.signerId,
        receiver: tx.receiverId,
        actions: tx.actions.map(rpcAction),
        logs,
        ok: failure === null,
        value: '',
        failure: failure ?? undefined,
        after: trail,
      }
      const out = { receipts: [] as RpcReceipt[], outcomes: [] as RpcOutcomeWithId[] }
      const [firstId] = flatten([first], out)
      const resolved = value && typeof value === 'object' && 'resolved' in (value as Record<string, unknown>) ? (value as { resolved: string }).resolved : null
      const result: RpcTxResult = {
        final_execution_status: 'FINAL',
        status: failure !== null ? { Failure: failure } : { SuccessValue: resolved !== null ? b64json(resolved) : '' },
        transaction: { hash, signer_id: tx.signerId, receiver_id: tx.receiverId, actions: tx.actions.map(rpcAction) },
        transaction_outcome: {
          id: hash,
          outcome: {
            logs: [],
            receipt_ids: [firstId as string],
            gas_burnt: 1,
            tokens_burnt: FAKE_GAS_BURN.toString(),
            executor_id: tx.signerId,
            status: { SuccessReceiptId: firstId },
          },
        },
        receipts_outcome: out.outcomes,
        receipts: out.receipts,
      }
      state.txs.set(hash, result)
      return { hash, result, tx }
    },
  }
}
