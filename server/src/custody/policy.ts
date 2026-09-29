import type { NetworkConfig } from '@/config/networks'
import { accountKind, isForeignToNetwork } from '@/lib/validation'
import { GAS, MAX_TX_GAS } from '@/services/near/gas'
import { parseEd25519PublicKey } from '@/services/near/nep413'
import { MAX_REGISTRATION_YOCTO } from '@/services/near/storage'

/**
 * What NearKit's signer may sign for a trading wallet, and nothing else.
 *
 * The signer is not an "any transaction" service. Every signature starts from a
 * typed operation (a verified swap route, a withdrawal, the backup key, revoking
 * NearKit's key); the planned transactions must match that operation exactly:
 * receivers, methods, arguments, deposits and gas. Anything unexpected (another
 * receiver or method, an extra action or key, a different amount or deposit, the
 * wrong network) is refused before a key is ever opened.
 */

/** One action NearKit may put in a trading-wallet transaction. */
export type WalletAction =
  | { kind: 'transfer'; deposit: string }
  | { kind: 'call'; method: string; args: Record<string, unknown>; gas: string; deposit: string }
  | { kind: 'add-key'; publicKey: string }
  | { kind: 'delete-key'; publicKey: string }

export interface WalletTxPlan {
  receiverId: string
  actions: WalletAction[]
  label: string
}

/** A swap route as NearKit's router verified it. The swap may carry exactly this and nothing else. */
export interface SwapRouteFacts {
  router: 'classic' | 'aggregator'
  /** Contract the input leaves from (wNEAR's for NEAR). */
  routeIn: string
  routeOut: string
  nativeIn: boolean
  nativeOut: boolean
  amountIn: bigint
  /** Contract the swap's `ft_transfer_call` goes to. */
  receiver: string
  msg: string
  routeTokens: string[]
  /** The lowest output the route itself enforces (after an output-side fee, on the aggregator). */
  minOut: bigint
  /** Aggregator only: the minimum Rhea signed into the route (the sum of its final minimums). */
  signedMin?: bigint
}

export type WalletOperation =
  /** `authorizedMinOut`: the minimum the user saw and confirmed; the route may never promise less. */
  | { kind: 'swap'; route: SwapRouteFacts; authorizedMinOut: bigint }
  | { kind: 'withdraw-near'; to: string; amount: bigint }
  | { kind: 'withdraw-token'; token: string; to: string; amount: bigint; registration: bigint | null }
  | { kind: 'add-backup-key'; publicKey: string }
  | { kind: 'revoke'; publicKey: string }
  /** wNEAR back to NEAR (e.g. after a buy was refunded as wNEAR). */
  | { kind: 'unwrap'; amount: bigint }

export interface PolicyWallet {
  accountId: string
  /** NearKit's key on the wallet. */
  publicKey: string
  network: string
}

export class PolicyViolation extends Error {
  constructor(reason: string) {
    super(`NearKit refused to sign: ${reason}`)
    this.name = 'PolicyViolation'
  }
}

const refuse = (reason: string): never => {
  throw new PolicyViolation(reason)
}

const MAX_TXS = 4
const MAX_ACTIONS = 4
const REGISTRATION_GAS = 30n * 10n ** 12n

/** JSON with sorted keys, so key order never decides equality. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

const int = (v: string, what: string): bigint => {
  if (!/^\d+$/.test(v)) refuse(`${what} is not a whole number`)
  return BigInt(v)
}

function expectCall(a: WalletAction | undefined, method: string, args: Record<string, unknown>, deposit: bigint, maxGas: bigint): void {
  if (!a || a.kind !== 'call') return refuse(`expected a call to ${method}`)
  if (a.method !== method) refuse(`unexpected method ${a.method}`)
  if (canonical(a.args) !== canonical(args)) refuse(`${method} carries different arguments than planned`)
  if (int(a.deposit, 'a deposit') !== deposit) refuse(`${method} attaches an unexpected deposit`)
  const gas = int(a.gas, 'gas')
  if (gas <= 0n || gas > maxGas) refuse(`${method} attaches unexpected gas`)
}

/** NEP-145 registration of `allowed` accounts only, at most the NearKit cap. */
function expectRegistration(a: WalletAction | undefined, allowed: ReadonlySet<string>): void {
  if (!a || a.kind !== 'call' || a.method !== 'storage_deposit') return refuse('expected a storage registration')
  const account = a.args.account_id
  if (typeof account !== 'string' || !allowed.has(account)) refuse('a registration is for an unexpected account')
  const deposit = int(a.deposit, 'a deposit')
  if (deposit <= 0n || deposit > MAX_REGISTRATION_YOCTO) refuse('a registration deposit is outside NearKit’s limit')
  expectCall(a, 'storage_deposit', { account_id: account, registration_only: true }, deposit, REGISTRATION_GAS)
}

function checkEnvelope(plan: readonly WalletTxPlan[], wallet: PolicyWallet, network: NetworkConfig): void {
  if (wallet.network !== network.id) refuse(`the wallet is on ${wallet.network}, NearKit is running on ${network.id}`)
  if (plan.length === 0 || plan.length > MAX_TXS) refuse('unexpected number of transactions')
  for (const tx of plan) {
    if (tx.actions.length === 0 || tx.actions.length > MAX_ACTIONS) refuse('unexpected number of actions')
    if (!accountKind(tx.receiverId)) refuse('a receiver is not a valid account')
    let gas = 0n
    for (const a of tx.actions) {
      if (a.kind === 'call') gas += int(a.gas, 'gas')
      if (a.kind === 'call' || a.kind === 'transfer') int(a.deposit, 'a deposit')
    }
    if (gas > MAX_TX_GAS) refuse('a transaction attaches too much gas')
  }
}

/** The classic exchange's swap message, re-read: it must be exactly the verified route. */
function checkClassicMsg(r: SwapRouteFacts): void {
  let msg: unknown
  try {
    msg = JSON.parse(r.msg)
  } catch {
    return refuse('the route message is unreadable')
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return refuse('the route message is malformed')
  const m = msg as Record<string, unknown>
  for (const k of Object.keys(m)) if (k !== 'actions' && k !== 'skip_unwrap_near') refuse(`the route message has an unexpected field ${k}`)
  if ('skip_unwrap_near' in m && (m.skip_unwrap_near !== false || !r.nativeOut)) refuse('the route message changes where NEAR is delivered')
  if (r.nativeOut && m.skip_unwrap_near !== false) refuse('the route would deliver wNEAR instead of NEAR')
  if (!Array.isArray(m.actions) || m.actions.length === 0) return refuse('the route has no swap steps')
  let covered = 0n
  let minOut = 0n
  let current: string | null = null
  let lastMin = 0n
  const close = () => {
    if (current !== null) {
      if (current !== r.routeOut) refuse('a route path ends in a different token')
      minOut += lastMin
    }
  }
  for (const raw of m.actions) {
    if (!raw || typeof raw !== 'object') return refuse('a swap step is malformed')
    const a = raw as Record<string, unknown>
    for (const k of Object.keys(a)) if (!['pool_id', 'token_in', 'token_out', 'amount_in', 'min_amount_out'].includes(k)) refuse(`a swap step has an unexpected field ${k}`)
    if (typeof a.pool_id !== 'number' || !Number.isSafeInteger(a.pool_id) || a.pool_id < 0) refuse('a pool id is malformed')
    if (typeof a.token_in !== 'string' || typeof a.token_out !== 'string' || typeof a.min_amount_out !== 'string') return refuse('a swap step is malformed')
    const min = int(a.min_amount_out, 'a minimum')
    if (a.amount_in !== undefined) {
      // A new path starts here, from the input token.
      close()
      if (typeof a.amount_in !== 'string') return refuse('a swap step is malformed')
      covered += int(a.amount_in, 'an input amount')
      if (a.token_in !== r.routeIn) refuse('a route path starts from a different token')
    } else if (a.token_in !== current) {
      refuse('the route’s steps do not connect')
    }
    current = a.token_out
    lastMin = min
  }
  close()
  if (covered !== r.amountIn) refuse('the route covers a different amount than planned')
  if (minOut === 0n) refuse('the route has no minimum output')
  if (minOut !== r.minOut) refuse('the route’s minimum differs from the verified one')
}

/** Aggregator-internal registration (`tokens_storage_deposit`) of `users` only, on route tokens only, at Rhea's price per token. */
function expectAggregatorRegistration(a: WalletAction | undefined, users: ReadonlySet<string>, tokens: ReadonlySet<string>, perToken: bigint, seen: Set<string>): void {
  if (!a || a.kind !== 'call' || a.method !== 'tokens_storage_deposit') return refuse('expected a registration with Rhea’s aggregator')
  const user = a.args.user
  const list = a.args.tokens
  if (typeof user !== 'string' || !users.has(user)) return refuse('a Rhea registration is for an unexpected account')
  if (seen.has(user)) refuse('an account is registered with Rhea twice')
  seen.add(user)
  if (!Array.isArray(list) || list.length === 0 || list.length > 8 || new Set(list).size !== list.length || list.some((t) => typeof t !== 'string' || !tokens.has(t)))
    return refuse('a Rhea registration names tokens outside the route')
  expectCall(a, 'tokens_storage_deposit', { user, tokens: list }, perToken * BigInt(list.length), GAS.AGGREGATOR_STORAGE)
}

/**
 * A swap through Rhea's aggregator (mainnet): registrations of the wallet and the
 * aggregator on route tokens, the wallet and NearKit's fee account inside the aggregator,
 * then one `ft_transfer_call` of exactly the route's input to the aggregator with the
 * signed route. The route itself is checked by the signer (signer/routes.ts).
 */
function checkAggregatorSwap(
  op: Extract<WalletOperation, { kind: 'swap' }>,
  plan: readonly WalletTxPlan[],
  wallet: PolicyWallet,
  network: NetworkConfig,
  feeRecipient: string | null,
): void {
  const r = op.route
  const agg = network.rhea.aggregator
  if (!agg) return refuse('there is no aggregator on this network')
  if (r.router !== 'aggregator') refuse('on this network swaps go through Rhea’s aggregator, with NearKit’s fee')
  if (!feeRecipient) refuse('no NearKit fee account is configured')
  if (r.receiver !== agg.contract) refuse('the swap goes to a contract that is not Rhea’s aggregator')
  if (r.nativeIn && r.routeIn !== network.wrapContract) refuse('NEAR must be swapped from the wrap contract')
  if (r.amountIn <= 0n) refuse('the swap amount is not positive')
  if (r.minOut <= 0n) refuse('the route has no minimum output')
  if (r.minOut < op.authorizedMinOut) refuse('the route’s minimum is below the minimum you confirmed')

  const swapTx = plan[plan.length - 1] as WalletTxPlan
  if (swapTx.receiverId !== r.routeIn) refuse('the swap transaction goes to a different token contract')
  const registrants = new Set([wallet.accountId, agg.contract])
  const routeContracts = new Set([...r.routeTokens, network.wrapContract])
  const users = new Set([wallet.accountId, feeRecipient as string])
  const tokens = new Set(r.routeTokens)
  let withRhea = 0
  for (const tx of plan.slice(0, -1)) {
    if (tx.receiverId === agg.contract) {
      if (++withRhea > 1) refuse('the plan registers with Rhea’s aggregator twice')
      const seen = new Set<string>()
      for (const a of tx.actions) expectAggregatorRegistration(a, users, tokens, BigInt(agg.tokenStorageDeposit), seen)
      continue
    }
    if (!routeContracts.has(tx.receiverId)) refuse('a registration is on a contract outside the route')
    for (const a of tx.actions) expectRegistration(a, registrants)
  }
  const actions = [...swapTx.actions]
  expectCall(actions.pop(), 'ft_transfer_call', { receiver_id: agg.contract, amount: r.amountIn.toString(), msg: r.msg }, 1n, GAS.SWAP_CALL)
  if (r.nativeIn) expectCall(actions.pop(), 'near_deposit', {}, r.amountIn, GAS.NEAR_DEPOSIT)
  if (actions.length > 2) refuse('the swap transaction has unexpected actions')
  for (const a of actions) expectRegistration(a, registrants)
}

function checkSwap(op: Extract<WalletOperation, { kind: 'swap' }>, plan: readonly WalletTxPlan[], wallet: PolicyWallet, network: NetworkConfig, feeRecipient: string | null): void {
  // Mainnet: the aggregator, with NearKit's fee. Testnet (no aggregator): the classic exchange.
  if (network.rhea.aggregator) return checkAggregatorSwap(op, plan, wallet, network, feeRecipient)
  const r = op.route
  if (r.router !== 'classic') refuse('only Rhea’s classic router is allowed for trading wallets on this network')
  if (r.receiver !== network.rhea.classic.exchange) refuse('the swap goes to a contract that is not Rhea’s exchange')
  if (r.nativeIn && r.routeIn !== network.wrapContract) refuse('NEAR must be swapped from the wrap contract')
  if (r.amountIn <= 0n) refuse('the swap amount is not positive')
  if (r.minOut < op.authorizedMinOut) refuse('the route’s minimum is below the minimum you confirmed')
  checkClassicMsg(r)

  const swapTx = plan[plan.length - 1] as WalletTxPlan
  if (swapTx.receiverId !== r.routeIn) refuse('the swap transaction goes to a different token contract')
  // Registrations first: the wallet itself, on tokens of this route only.
  const self = new Set([wallet.accountId])
  const routeContracts = new Set([...r.routeTokens, network.wrapContract])
  for (const tx of plan.slice(0, -1)) {
    if (!routeContracts.has(tx.receiverId)) refuse('a registration is on a contract outside the route')
    for (const a of tx.actions) expectRegistration(a, self)
  }
  const actions = [...swapTx.actions]
  expectCall(actions.pop(), 'ft_transfer_call', { receiver_id: r.receiver, amount: r.amountIn.toString(), msg: r.msg }, 1n, GAS.SWAP_CALL)
  if (r.nativeIn) expectCall(actions.pop(), 'near_deposit', {}, r.amountIn, GAS.NEAR_DEPOSIT)
  if (actions.length > 1) refuse('the swap transaction has unexpected actions')
  for (const a of actions) expectRegistration(a, self)
}

function checkDestination(to: string, wallet: PolicyWallet, network: NetworkConfig): void {
  if (!accountKind(to)) refuse('the destination is not a valid NEAR account')
  if (isForeignToNetwork(to, network.id)) refuse(`the destination belongs to the other network, not ${network.id}`)
  if (to === wallet.accountId) refuse('the destination is the wallet itself')
}

/**
 * `feeRecipient`: the one account NearKit's fee may go to on this network (the signer's
 * own configuration), or null where no fee is charged.
 */
export function checkPlan(op: WalletOperation, plan: readonly WalletTxPlan[], wallet: PolicyWallet, network: NetworkConfig, feeRecipient: string | null = null): void {
  checkEnvelope(plan, wallet, network)
  switch (op.kind) {
    case 'swap':
      return checkSwap(op, plan, wallet, network, feeRecipient)
    case 'withdraw-near': {
      checkDestination(op.to, wallet, network)
      if (op.amount <= 0n) refuse('the amount is not positive')
      const [tx] = plan
      if (plan.length !== 1 || !tx || tx.receiverId !== op.to) return refuse('a NEAR withdrawal is one transfer to the destination')
      const [a] = tx.actions
      if (tx.actions.length !== 1 || a?.kind !== 'transfer' || int(a.deposit, 'the amount') !== op.amount) refuse('the transfer differs from the confirmed amount')
      return
    }
    case 'withdraw-token': {
      checkDestination(op.to, wallet, network)
      if (op.to === op.token) refuse('tokens sent to their own contract are lost')
      if (op.amount <= 0n) refuse('the amount is not positive')
      const [tx] = plan
      if (plan.length !== 1 || !tx || tx.receiverId !== op.token) return refuse('a token withdrawal is one transaction to the token contract')
      const actions = [...tx.actions]
      expectCall(actions.pop(), 'ft_transfer', { receiver_id: op.to, amount: op.amount.toString() }, 1n, GAS.FT_TRANSFER)
      if (op.registration === null) {
        if (actions.length) refuse('the withdrawal has unexpected actions')
      } else {
        if (actions.length !== 1) refuse('the withdrawal must register the destination exactly once')
        expectRegistration(actions[0], new Set([op.to]))
        const a = actions[0] as Extract<WalletAction, { kind: 'call' }>
        if (BigInt(a.deposit) !== op.registration) refuse('the registration deposit differs from the one shown')
      }
      return
    }
    case 'add-backup-key': {
      if (!parseEd25519PublicKey(op.publicKey)) refuse('the backup key is not an ed25519 public key')
      if (op.publicKey === wallet.publicKey) refuse('the backup key is NearKit’s own key')
      const [tx] = plan
      if (plan.length !== 1 || !tx || tx.receiverId !== wallet.accountId) return refuse('the backup key is added by the wallet to itself')
      const [a] = tx.actions
      if (tx.actions.length !== 1 || a?.kind !== 'add-key' || a.publicKey !== op.publicKey) refuse('the key added differs from your linked wallet’s key')
      return
    }
    case 'unwrap': {
      if (op.amount <= 0n) refuse('the amount is not positive')
      const [tx] = plan
      if (plan.length !== 1 || !tx || tx.receiverId !== network.wrapContract || tx.actions.length !== 1) return refuse('unwrapping is one call to the wrap contract')
      expectCall(tx.actions[0], 'near_withdraw', { amount: op.amount.toString() }, 1n, GAS.NEAR_WITHDRAW)
      return
    }
    case 'revoke': {
      if (op.publicKey !== wallet.publicKey) refuse('only NearKit’s own key can be revoked')
      const [tx] = plan
      if (plan.length !== 1 || !tx || tx.receiverId !== wallet.accountId) return refuse('revoking is done by the wallet on itself')
      const [a] = tx.actions
      if (tx.actions.length !== 1 || a?.kind !== 'delete-key' || a.publicKey !== wallet.publicKey) refuse('only NearKit’s own key can be deleted')
      return
    }
  }
}
