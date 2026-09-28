import { NATIVE_TOKEN_ID } from '@/config/networks'
import { accountIdError } from '@/lib/validation'
import { NearKitError } from '@/services/near/errors'
import type { CopyRule, DcaPlan, SniperConfig } from '@/types/domain'
import type { AutomationService, WalletService } from '../types'
import type { NearContext } from './context'

/**
 * DCA, Copy Trade and Sniper in real mode are drafts: saved in this browser for
 * this network, validated, and never executed. Nothing here signs, schedules or
 * watches the chain; the pages say so.
 */

const draftId = (prefix: string, now: number) => `${prefix}-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`

export function createAutomationService(ctx: NearContext, wallets: Pick<WalletService, 'getSession' | 'listWallets' | 'listPresets'>): AutomationService {
  const { dca, copy, sniper } = ctx.stores.drafts

  const needSession = async () => {
    if (!(await wallets.getSession())) throw new NearKitError('WALLET_UNAVAILABLE', 'Connect a wallet first')
  }
  const remove = <T extends { id: string }>(store: { read(): T[]; write(items: T[]): void }, id: string) => {
    const list = store.read()
    if (!list.some((item) => item.id === id)) throw new NearKitError('UNKNOWN', 'Draft not found')
    store.write(list.filter((item) => item.id !== id))
  }

  return {
    async listDcaPlans() {
      return dca.read()
    },

    async createDcaPlan(input) {
      await needSession()
      if (input.tokenId === NATIVE_TOKEN_ID) throw new NearKitError('INVALID_TOKEN', 'Choose a token to accumulate')
      if (!(await wallets.listWallets()).some((w) => w.id === input.walletId)) throw new NearKitError('INVALID_ACCOUNT', 'Choose one of your wallets')
      if (!(input.amountNear > 0)) throw new NearKitError('INVALID_AMOUNT', 'Enter a buy amount above 0')
      if (input.endAt !== null && input.endAt <= input.startAt) throw new NearKitError('INVALID_AMOUNT', 'End date must be after the start date')
      const plan: DcaPlan = { ...input, id: draftId('dca', ctx.now()), createdAt: ctx.now(), status: 'draft' }
      dca.write([plan, ...dca.read()])
      return plan
    },

    async deleteDcaPlan(id) {
      remove(dca, id)
    },

    async listCopyRules() {
      return copy.read()
    },

    async createCopyRule(input) {
      await needSession()
      const error = accountIdError(input.target)
      if (error) throw new NearKitError('INVALID_ACCOUNT', `Target wallet: ${error}`)
      if (input.sizing.mode === 'fixed' && !(input.sizing.amountNear > 0)) throw new NearKitError('INVALID_AMOUNT', 'Enter a fixed size above 0')
      if (input.sizing.mode === 'percent' && !(input.sizing.pct > 0 && input.sizing.pct <= 100)) throw new NearKitError('INVALID_AMOUNT', 'Percentage must be between 0 and 100')
      if (!(input.maxTradeNear > 0)) throw new NearKitError('INVALID_AMOUNT', 'Set a maximum trade size')
      if (input.minTradeNear !== null && input.minTradeNear > input.maxTradeNear) throw new NearKitError('INVALID_AMOUNT', 'Minimum trade is above the maximum')
      const rule: CopyRule = { ...input, blacklist: [...input.blacklist], id: draftId('copy', ctx.now()), createdAt: ctx.now(), status: 'draft' }
      copy.write([rule, ...copy.read()])
      return rule
    },

    async deleteCopyRule(id) {
      remove(copy, id)
    },

    async listSniperConfigs() {
      return sniper.read()
    },

    async createSniperConfig(input) {
      await needSession()
      if (!input.target.trim()) throw new NearKitError('INVALID_TOKEN', 'Enter a token contract or symbol')
      if (!(await wallets.listPresets()).some((p) => p.id === input.presetId)) throw new NearKitError('INVALID_ACCOUNT', 'Choose a wallet preset')
      if (!(input.amountNearPerWallet > 0)) throw new NearKitError('INVALID_AMOUNT', 'Enter a buy amount above 0')
      if (input.trigger === 'at-time' && (input.triggerAt === null || input.triggerAt <= ctx.now())) throw new NearKitError('INVALID_AMOUNT', 'Pick a launch time in the future')
      const config: SniperConfig = { ...input, id: draftId('snp', ctx.now()), createdAt: ctx.now(), status: 'draft' }
      sniper.write([config, ...sniper.read()])
      return config
    },

    async deleteSniperConfig(id) {
      remove(sniper, id)
    },
  }
}
