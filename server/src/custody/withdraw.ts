import { NATIVE_TOKEN_ID, NEAR_DECIMALS, type NetworkConfig } from '@/config/networks'
import { formatUnits } from '@/lib/amounts'
import { accountIdError, accountKind, isForeignToNetwork } from '@/lib/validation'
import { accountState } from '@/services/near/account'
import { NearKitError, toNearKitError } from '@/services/near/errors'
import { GAS, gasPurchaseYocto } from '@/services/near/gas'
import { storageBoundsMin, storageStatus } from '@/services/near/storage'
import type { ServerNear } from '../near'
import type { IntentHandler, PlanOutcome } from './engine'
import type { WalletAction, WalletTxPlan } from './policy'
import type { TradingWallet } from './store'

/**
 * Withdrawals from a trading wallet to any valid NEAR address on this network:
 * NEAR, or any NEP-141 token it holds. The destination is checked (syntax, network,
 * existence, not the wallet itself, not the token's own contract) when the review
 * is shown AND again right before signing; if anything the review showed changed
 * (a registration now needed, a new fee), the user sees a new review instead.
 */

export interface WithdrawInput {
  /** 'near' or the token contract. */
  asset: string
  symbol: string
  decimals: number
  /** Raw units. */
  amount: string
  to: string
  /** The destination is the user's verified linked wallet. */
  linked: boolean
}

/** What the review shows beyond the input: re-derived from chain before signing. */
export interface WithdrawReview {
  /** Yocto to register the destination with the token contract, or null. */
  registration: string | null
  /** The destination has never been used on this network (an implicit address that doesn't exist yet). */
  fresh: boolean
  /** Rough gas cost, for display. */
  feeNear: string
}

export const WITHDRAW_TTL_MS = 5 * 60_000
const NEAR_FEE = 10n ** 20n // ~0.0001 NEAR burnt by a transfer
const TOKEN_FEE = 5n * 10n ** 20n // ~0.0005 NEAR for ft_transfer (+ registration)

const invalid = (message: string) => new NearKitError('INVALID_ACCOUNT', message)

/**
 * NEAR a NEAR withdrawal needs available besides its amount: the gas the chain holds when it
 * accepts the transfer (NEP-642), counted on that transfer by the project's gas model. A transfer
 * to a 64-character address also pays for creating that account (nearcore charges it by the
 * address's type): about 0.0084 NEAR, against under 0.001 to a named account. With no destination
 * yet (Telegram asks for the amount first) it is priced as the dearer case.
 */
export function nearWithdrawUpfront(to?: string): bigint {
  return gasPurchaseYocto({ receiverId: to, actions: [{ kind: 'transfer', deposit: '1' }] })
}

/** A token withdrawal's actions, exactly as its transaction sends them: the destination's registration when it needs one, then the transfer. */
export function tokenWithdrawActions(to: string, amount: bigint, registration: bigint | null): WalletAction[] {
  return [
    ...(registration !== null
      ? [
          {
            kind: 'call' as const,
            method: 'storage_deposit',
            args: { account_id: to, registration_only: true },
            gas: GAS.STORAGE_DEPOSIT.toString(),
            deposit: registration.toString(),
          },
        ]
      : []),
    { kind: 'call' as const, method: 'ft_transfer', args: { receiver_id: to, amount: amount.toString() }, gas: GAS.FT_TRANSFER.toString(), deposit: '1' },
  ]
}

/** NEAR a token withdrawal needs available besides the registration deposit: the gas its transaction holds upfront, and the 1 yocto. */
export function tokenWithdrawUpfront(token: string, to: string, amount: bigint, registration: bigint | null): bigint {
  return gasPurchaseYocto({ receiverId: token, actions: tokenWithdrawActions(to, amount, registration) }) + 1n
}

/** The most NEAR a withdrawal can send: what is spendable less the gas its transfer holds upfront (the dearer case when `to` isn't known yet). */
export function maxNearWithdraw(available: bigint, to?: string): bigint {
  const upfront = nearWithdrawUpfront(to)
  return available > upfront ? available - upfront : 0n
}

/** Destination rules, in plain words. Returns the cleaned account ID. */
export function checkDestinationSyntax(raw: string, network: NetworkConfig, wallet: TradingWallet, asset: string): string {
  const to = raw.trim()
  const why = accountIdError(to)
  if (why) throw invalid(`${why}. Send a NEAR account like alice.${network.id} or a 64-character address.`)
  if (isForeignToNetwork(to, network.id)) throw invalid(`${to} is a NEAR ${network.id === 'testnet' ? 'mainnet' : 'testnet'} account. NEARKITS is on ${network.id}.`)
  if (to === wallet.accountId) throw invalid('That is this NEARKITS wallet itself.')
  if (asset !== NATIVE_TOKEN_ID && to === asset) throw invalid('That is the token’s own contract: tokens sent there are lost.')
  return to
}

/** Everything the review shows, read from chain now. Throws a NearKitError people can read. */
export async function reviewWithdraw(near: ServerNear, network: NetworkConfig, wallet: TradingWallet, input: WithdrawInput): Promise<WithdrawReview> {
  checkDestinationSyntax(input.to, network, wallet, input.asset)
  const amount = BigInt(input.amount)
  if (amount <= 0n) throw new NearKitError('INVALID_AMOUNT', 'Enter an amount above 0')
  const rpc = near.ctx.rpc
  try {
    const [dest, mine] = await Promise.all([accountState(rpc, input.to, 'final'), accountState(rpc, wallet.accountId, 'final')])
    const kind = accountKind(input.to)
    if (!dest.exists && kind === 'named') throw invalid(`There is no account ${input.to} on NEAR ${network.id}. Check the address.`)
    if (!mine.exists) throw new NearKitError('INSUFFICIENT_BALANCE', 'Your NEARKITS wallet has no NEAR yet. Deposit first.')
    const fresh = !dest.exists

    if (input.asset === NATIVE_TOKEN_ID) {
      if (mine.availableYocto < amount + nearWithdrawUpfront(input.to)) {
        throw new NearKitError(
          'INSUFFICIENT_BALANCE',
          `Your NEARKITS wallet has ${formatUnits(mine.availableYocto, NEAR_DECIMALS, { maxFraction: 4 })} NEAR available; withdrawing ${formatUnits(amount, NEAR_DECIMALS, { maxFraction: 6 })} also needs a little NEAR for the network fee.`,
        )
      }
      return { registration: null, fresh, feeNear: NEAR_FEE.toString() }
    }

    const held = await near.ctx.reader.balanceOf(input.asset, wallet.accountId)
    if (held < amount) throw new NearKitError('INSUFFICIENT_BALANCE', `Your NEARKITS wallet holds ${formatUnits(held, input.decimals, { maxFraction: 6 })} ${input.symbol}.`)
    const status = (await storageStatus(rpc, input.asset, [input.to])).get(input.to)
    const registration = status === false ? await storageBoundsMin(rpc, input.asset) : null
    const need = tokenWithdrawUpfront(input.asset, input.to, amount, registration) + (registration ?? 0n)
    if (mine.availableYocto < need) {
      throw new NearKitError(
        'INSUFFICIENT_GAS',
        `Sending ${input.symbol} needs ${formatUnits(need, NEAR_DECIMALS, { maxFraction: 4 })} NEAR available for fees. Deposit a little NEAR first.`,
      )
    }
    return { registration: registration?.toString() ?? null, fresh, feeNear: TOKEN_FEE.toString() }
  } catch (e) {
    throw toNearKitError(e, 'RPC_ERROR')
  }
}

export function withdrawHandler(deps: { near: ServerNear; network: NetworkConfig }): IntentHandler {
  return {
    async plan(intent, wallet): Promise<PlanOutcome> {
      const input = intent.params as unknown as WithdrawInput
      const shown = intent.quote as unknown as WithdrawReview
      const now = await reviewWithdraw(deps.near, deps.network, wallet, input)
      // Anything the user didn't see gets a new review first.
      if (now.registration !== shown.registration || now.fresh !== shown.fresh) return { kind: 'requote', quote: { ...now }, ttlMs: WITHDRAW_TTL_MS }
      const amount = BigInt(input.amount)
      if (input.asset === NATIVE_TOKEN_ID) {
        const plan: WalletTxPlan[] = [{ receiverId: input.to, actions: [{ kind: 'transfer', deposit: amount.toString() }], label: 'Withdraw NEAR' }]
        return { kind: 'plan', op: { kind: 'withdraw-near', to: input.to, amount }, plan }
      }
      const registration = now.registration === null ? null : BigInt(now.registration)
      const plan: WalletTxPlan[] = [{ receiverId: input.asset, actions: tokenWithdrawActions(input.to, amount, registration), label: `Withdraw ${input.symbol}` }]
      return { kind: 'plan', op: { kind: 'withdraw-token', token: input.asset, to: input.to, amount, registration }, plan }
    },

    async summarize(intent, _wallet, confirmed) {
      const input = intent.params as unknown as WithdrawInput
      const last = confirmed.at(-1)
      const status = last?.result.status as Record<string, unknown> | undefined
      const ok = Boolean(status && 'SuccessValue' in status)
      return {
        ok,
        message: ok ? 'Withdrawal confirmed.' : 'The withdrawal failed on chain. Your funds stayed in the wallet (only the network fee was used).',
        hashes: confirmed.map((c) => c.hash),
        facts: { asset: input.asset, symbol: input.symbol, decimals: input.decimals, amount: input.amount, to: input.to },
      }
    },
  }
}
