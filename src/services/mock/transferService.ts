import { formatAmount } from '@/lib/format'
import { accountIdError } from '@/lib/validation'
import type { TransferService } from '../types'
import { coversRaw, demoTransferPlan, rawAmount } from './plans'
import { ServiceError, balanceOf, executableWalletOf, requireSession, tokenOf, wait, type MockState } from './state'

/** Demo transfers: validated like real ones, planned with the real builders, simulated on execution. */
export function createTransferService(state: MockState): TransferService {
  return {
    async prepare(request) {
      await wait('write')
      requireSession(state)
      const token = tokenOf(state, request.tokenId)

      if (request.kind === 'consolidate') {
        const sources = request.sources.filter((s) => s.amount.trim() !== '')
        if (sources.length === 0) throw new ServiceError('no-sources', 'Select at least one wallet with a balance')
        const destination = request.destinationAccountId
        const signerLines = sources.map((s, i) => {
          const wallet = executableWalletOf(state, s.walletId)
          if (wallet.accountId === destination) throw new ServiceError('invalid-source', 'The destination cannot also be a source')
          const raw = rawAmount(s.amount, token, wallet.label)
          if (!coversRaw(balanceOf(state, wallet.id, token.id), raw, token.decimals))
            throw new ServiceError('insufficient', `${wallet.label} does not hold ${s.amount} ${token.symbol}`)
          return { signerId: wallet.accountId, lines: [{ id: `l${i}`, accountId: destination, raw, storageDeposit: null, label: wallet.label, notes: [`From ${wallet.label}`] }] }
        })
        return demoTransferPlan(state, {
          kind: 'consolidate',
          title: `Consolidate ${token.symbol} from ${sources.length} ${sources.length === 1 ? 'wallet' : 'wallets'} into ${request.destinationLabel ?? destination}`,
          token,
          signerLines,
        })
      }

      const source = executableWalletOf(state, request.sourceWalletId)
      if (request.lines.length === 0) throw new ServiceError('no-recipients', 'Add at least one recipient')
      const lines = request.lines.map((line, i) => {
        const error = accountIdError(line.accountId)
        if (error) throw new ServiceError('invalid-account', `${line.accountId || 'Recipient'}: ${error}`)
        if (line.accountId === source.accountId) throw new ServiceError('invalid-account', 'The source wallet cannot also be a recipient')
        return {
          id: `l${i}`,
          accountId: line.accountId,
          raw: rawAmount(line.amount, token, line.label ?? line.accountId),
          storageDeposit: null,
          label: line.label ?? line.accountId,
        }
      })
      const total = lines.reduce((s, l) => s + l.raw, 0n)
      const balance = balanceOf(state, source.id, token.id)
      if (!coversRaw(balance, total, token.decimals)) throw new ServiceError('insufficient', `${source.label} holds ${formatAmount(balance)} ${token.symbol}`)
      const verb = request.kind === 'split' ? 'Split' : 'Send'
      return demoTransferPlan(state, {
        kind: request.kind,
        title: `${verb} ${token.symbol} from ${source.label} to ${lines.length} ${lines.length === 1 ? 'recipient' : 'recipients'}`,
        token,
        signerLines: [{ signerId: source.accountId, lines }],
      })
    },
  }
}
