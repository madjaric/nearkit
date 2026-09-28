import { mapLimit } from '@/lib/async'
import { accountIdError, accountKind, isForeignToNetwork } from '@/lib/validation'
import { accountState, type AccountState } from '@/services/near/account'
import { NearKitError, toNearKitError } from '@/services/near/errors'
import {
  buildFtTransferTransactions,
  buildNearTransferTransactions,
  groupTransactions,
  registrationWarnings,
  txStorageYocto as storageOf,
  txUpfrontYocto as upfrontOf,
  type TransferLineInput,
} from '@/services/near/plans'
import { HIGH_REGISTRATION_YOCTO, storageBoundsMin, storageStatus } from '@/services/near/storage'
import { formatUnits } from '@/lib/amounts'
import { formatAccount } from '@/lib/format'
import type { TransferRequest, Wallet } from '@/types/domain'
import type { OperationPlan, PlanLine, PlannedTransaction, TokenRef } from '@/types/operations'
import type { TransferService, WalletService } from '../types'
import { amountValue, nearText, nearValue, newPlanId, parseAmount, requireSession, resolveToken, sumRaw, walletOf } from './common'
import type { NearContext } from './context'

/**
 * Batch Send, Split and Consolidate on chain. `prepare` turns the request into
 * an exact plan: raw amounts from the user's decimal strings, every recipient
 * checked on chain, NEP-145 registrations where they are missing, gas bought
 * upfront, and balances read fresh for every signer. Nothing is rounded,
 * substituted or dropped: a line that can't be sent stops the plan with a reason.
 */

interface LineDraft extends TransferLineInput {
  label: string
  notes: string[]
}

interface SignerDraft {
  signerId: string
  label: string
  lines: LineDraft[]
}

const MAX_LINES = 500

function checkRecipient(accountId: string, ctx: NearContext): string {
  const id = accountId.trim()
  const error = accountIdError(id)
  if (error) throw new NearKitError('INVALID_ACCOUNT', `${id || 'Recipient'}: ${error}`)
  if (isForeignToNetwork(id, ctx.network.id))
    throw new NearKitError('NETWORK_MISMATCH', `${id} is a ${ctx.network.id === 'mainnet' ? 'testnet' : 'mainnet'} account; NearKit is on ${ctx.network.label.toLowerCase()}`)
  return id
}

/** Recipients that are not a saved account but print the same shortened way as one. */
function lookalikes(signers: SignerDraft[], list: Wallet[]): string[] {
  const saved = new Set(list.map((w) => w.accountId))
  const out = new Set<string>()
  for (const s of signers)
    for (const l of s.lines) {
      if (saved.has(l.accountId)) continue
      const twin = list.find((w) => formatAccount(w.accountId) === formatAccount(l.accountId))
      if (twin) out.add(`${l.accountId} looks like your saved account ${twin.label} (${twin.accountId}) but is a different account. Compare every character.`)
    }
  return [...out]
}

const listOf = (ids: string[]) => (ids.length <= 3 ? ids.join(', ') : `${ids.slice(0, 3).join(', ')} and ${ids.length - 3} more`)

export function createTransferService(ctx: NearContext, wallets: Pick<WalletService, 'getSession' | 'listWallets'>): TransferService {
  async function drafts(request: TransferRequest, list: Wallet[], token: TokenRef): Promise<{ signers: SignerDraft[]; title: string }> {
    if (request.kind === 'consolidate') {
      const destination = checkRecipient(request.destinationAccountId, ctx)
      const sources = request.sources.filter((s) => s.amount.trim() !== '')
      if (sources.length === 0) throw new NearKitError('INVALID_AMOUNT', 'Select at least one wallet with a balance')
      const signers = sources.map((s, i): SignerDraft => {
        const wallet = walletOf(list, s.walletId)
        if (wallet.accountId === destination) throw new NearKitError('INVALID_ACCOUNT', 'The destination cannot also be a source')
        const raw = parseAmount(s.amount, token, wallet.label)
        return {
          signerId: wallet.accountId,
          label: wallet.label,
          lines: [{ id: `l${i}`, accountId: destination, raw, storageDeposit: null, label: wallet.label, notes: [`From ${wallet.label}`] }],
        }
      })
      if (new Set(signers.map((s) => s.signerId)).size !== signers.length) throw new NearKitError('INVALID_ACCOUNT', 'A wallet is listed twice as a source')
      const n = signers.length
      return { signers, title: `Consolidate ${token.symbol} from ${n} ${n === 1 ? 'wallet' : 'wallets'} into ${request.destinationLabel ?? destination}` }
    }

    const source = walletOf(list, request.sourceWalletId)
    if (request.lines.length === 0) throw new NearKitError('INVALID_ACCOUNT', 'Add at least one recipient')
    if (request.lines.length > MAX_LINES) throw new NearKitError('INVALID_ACCOUNT', `At most ${MAX_LINES} recipients per run`)
    const lines = request.lines.map((line, i): LineDraft => {
      const accountId = checkRecipient(line.accountId, ctx)
      if (accountId === source.accountId) throw new NearKitError('INVALID_ACCOUNT', 'The source wallet cannot also be a recipient')
      const label = line.label ?? accountId
      return { id: `l${i}`, accountId, raw: parseAmount(line.amount, token, label), storageDeposit: null, label, notes: [] }
    })
    const verb = request.kind === 'split' ? 'Split' : 'Send'
    return {
      signers: [{ signerId: source.accountId, label: source.label, lines }],
      title: `${verb} ${token.symbol} from ${source.label} to ${lines.length} ${lines.length === 1 ? 'recipient' : 'recipients'}`,
    }
  }

  /** Every recipient must exist, except implicit accounts, which a transfer can create or credit. */
  async function checkRecipients(signers: SignerDraft[], token: TokenRef, warnings: string[]): Promise<void> {
    const ids = [...new Set(signers.flatMap((s) => s.lines.map((l) => l.accountId)))]
    let states: AccountState[]
    try {
      states = await mapLimit(ids, 4, (id) => accountState(ctx.rpc, id, 'final'))
    } catch (e) {
      throw toNearKitError(e, 'RPC_ERROR')
    }
    const missing = states.filter((s) => !s.exists).map((s) => s.accountId)
    const blocked = missing.filter((id) => {
      const kind = accountKind(id)
      return kind !== 'implicit' && kind !== 'eth-implicit'
    })
    if (blocked.length)
      throw new NearKitError('INVALID_ACCOUNT', `${listOf(blocked)} ${blocked.length === 1 ? 'does' : 'do'} not exist on ${ctx.network.label.toLowerCase()}. Nothing was sent.`)
    const created = new Set(missing)
    if (created.size === 0) return
    for (const s of signers)
      for (const l of s.lines)
        if (created.has(l.accountId))
          l.notes.push(token.contract ? 'Account not created yet: the tokens are credited to it and usable once it exists' : 'New account: this transfer creates it')
    if (token.contract)
      warnings.push(
        `${listOf([...created])} ${created.size === 1 ? 'is an implicit account that does' : 'are implicit accounts that do'} not exist yet. The tokens are credited and usable once the account is funded.`,
      )
  }

  /** NEP-145: register each unregistered recipient once, in the first transaction that pays it. */
  async function registerRecipients(signers: SignerDraft[], contract: string, warnings: string[]): Promise<void> {
    const ids = [...new Set(signers.flatMap((s) => s.lines.map((l) => l.accountId)))]
    const status = await storageStatus(ctx.rpc, contract, ids)
    if ([...status.values()].every((v) => v === null)) {
      warnings.push(
        'This token does not report NEP-145 storage, so recipients are not registered first. If it requires registration, the affected transfers fail and the tokens stay with you.',
      )
      return
    }
    const unregistered = new Set(ids.filter((id) => status.get(id) === false))
    if (unregistered.size === 0) return
    const min = await storageBoundsMin(ctx.rpc, contract)
    if (min === null) throw new NearKitError('STORAGE_REQUIRED', `${contract} requires registration but does not report its cost. Nothing was sent.`)
    for (const s of signers)
      for (const l of s.lines)
        if (unregistered.has(l.accountId)) {
          l.storageDeposit = min
          unregistered.delete(l.accountId)
        }
  }

  async function checkFunds(signers: SignerDraft[], txs: PlannedTransaction[], token: TokenRef): Promise<void> {
    await mapLimit(signers, 3, async (s) => {
      const own = txs.filter((t) => t.signerId === s.signerId)
      const amount = sumRaw(s.lines.map((l) => l.raw))
      const storage = sumRaw(own.map(storageOf))
      const upfront = sumRaw(own.map(upfrontOf))
      let state: AccountState
      let tokenBalance: bigint | null = null
      try {
        ;[state, tokenBalance] = await Promise.all([accountState(ctx.rpc, s.signerId), token.contract ? ctx.reader.balanceOf(token.contract, s.signerId) : Promise.resolve(null)])
      } catch (e) {
        throw toNearKitError(e, 'RPC_ERROR')
      }
      if (!state.exists) throw new NearKitError('INVALID_ACCOUNT', `${s.label} (${s.signerId}) does not exist on ${ctx.network.label.toLowerCase()}`)
      const available = state.availableYocto
      const nearNeeded = (token.contract ? 0n : amount) + storage + upfront
      if (!token.contract && available < amount) {
        throw new NearKitError('INSUFFICIENT_BALANCE', `${s.label} has ${nearText(available)} NEAR available and this sends ${formatUnits(amount, token.decimals)} NEAR`)
      }
      if (token.contract && tokenBalance !== null && tokenBalance < amount) {
        throw new NearKitError(
          'INSUFFICIENT_BALANCE',
          `${s.label} holds ${formatUnits(tokenBalance, token.decimals)} ${token.symbol} and this sends ${formatUnits(amount, token.decimals)} ${token.symbol}`,
        )
      }
      if (available < nearNeeded) {
        const parts = [
          token.contract ? null : `${formatUnits(amount, token.decimals)} to send`,
          storage > 0n ? `${nearText(storage)} for storage registration` : null,
          `${nearText(upfront)} of gas bought upfront, mostly refunded`,
        ].filter(Boolean)
        throw new NearKitError('INSUFFICIENT_GAS', `${s.label} needs ${nearText(nearNeeded)} NEAR available to sign (${parts.join(' + ')}). It has ${nearText(available)} NEAR.`)
      }
    })
  }

  return {
    async prepare(request) {
      const session = requireSession(await wallets.getSession(), ctx.network.label)
      const [list, token, walletSession] = await Promise.all([
        wallets.listWallets(),
        resolveToken(ctx, request.tokenId, { fresh: true }),
        ctx.wallet().then((w) => w.session().catch(() => null)),
      ])
      const { signers, title } = await drafts(request, list, token)
      const warnings: string[] = [...lookalikes(signers, list)]
      if (request.kind !== 'consolidate' && request.skippedLines) {
        const n = request.skippedLines
        warnings.push(`${n} duplicate ${n === 1 ? 'line was' : 'lines were'} skipped and will not be sent.`)
      }

      await checkRecipients(signers, token, warnings)
      if (token.contract) await registerRecipients(signers, token.contract, warnings)

      const transactions: PlannedTransaction[] = []
      const lines: PlanLine[] = []
      for (const s of signers) {
        const built = token.contract ? buildFtTransferTransactions(s.signerId, token, s.lines) : buildNearTransferTransactions(s.signerId, s.lines)
        for (const tx of built) {
          const index = transactions.length
          transactions.push({ ...tx, index, label: signers.length > 1 ? `${s.label} · ${tx.label}` : tx.label })
          for (const id of tx.lineIds) {
            const line = s.lines.find((l) => l.id === id)
            if (!line) continue
            lines.push({
              id,
              label: line.label,
              accountId: line.accountId,
              amount: amountValue(line.raw, token.decimals),
              storageDeposit: line.storageDeposit !== null ? nearValue(line.storageDeposit) : null,
              notes: line.notes,
              txIndex: index,
            })
          }
        }
      }

      await checkFunds(signers, transactions, token)
      warnings.push(...registrationWarnings(transactions, HIGH_REGISTRATION_YOCTO))

      const signing = new Set(walletSession?.accounts ?? session.accounts ?? [session.accountId])
      const elsewhere = signers.map((s) => s.signerId).filter((id) => !signing.has(id))
      if (elsewhere.length) {
        warnings.push(
          signers.length > 1
            ? `This needs approvals from ${signers.length} accounts. When NearKit reaches ${listOf(elsewhere)}, it asks you to connect that account in your wallet.`
            : `${elsewhere[0]} is not connected right now. NearKit asks you to connect it in your wallet before signing.`,
        )
      }

      const now = ctx.now()
      return {
        id: newPlanId(now),
        kind: request.kind,
        mode: 'near',
        network: ctx.network.id,
        title,
        token,
        signers: signers.map((s) => s.signerId),
        lines,
        transactions,
        groups: groupTransactions(transactions, walletSession?.batch ?? false),
        totals: {
          amount: amountValue(sumRaw(lines.map((l) => BigInt(l.amount.raw))), token.decimals),
          storage: nearValue(sumRaw(transactions.map(storageOf))),
          upfrontNear: nearValue(sumRaw(transactions.map(upfrontOf))),
        },
        fee: null,
        swap: null,
        warnings,
        expiresAt: null,
        createdAt: now,
      } satisfies OperationPlan
    },
  }
}
