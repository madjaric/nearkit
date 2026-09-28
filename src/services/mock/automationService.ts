import { accountIdError } from '@/lib/validation'
import type { CopyRule, DcaPlan, SniperConfig } from '@/types/domain'
import type { AutomationService } from '../types'
import { ServiceError, logActivity, nextId, requireSession, tokenOf, wait, walletOf, type MockState } from './state'

function remove<T extends { id: string }>(list: T[], id: string): void {
  const index = list.findIndex((item) => item.id === id)
  if (index < 0) throw new ServiceError('not-found', 'Rule not found')
  list.splice(index, 1)
}

export function createAutomationService(state: MockState): AutomationService {
  return {
    async listDcaPlans() {
      await wait('read')
      return state.dca.map((p) => ({ ...p }))
    },

    async createDcaPlan(input) {
      await wait('write')
      requireSession(state)
      const token = tokenOf(state, input.tokenId)
      walletOf(state, input.walletId)
      if (token.isNative) throw new ServiceError('invalid-pair', 'Choose a token to accumulate')
      if (!(input.amountNear > 0)) throw new ServiceError('invalid-amount', 'Enter a buy amount above 0')
      if (input.endAt !== null && input.endAt <= input.startAt) throw new ServiceError('invalid-dates', 'End date must be after the start date')
      const plan: DcaPlan = { ...input, id: nextId(state, 'dca'), createdAt: Date.now(), status: 'standby' }
      state.dca.unshift(plan)
      logActivity(state, { kind: 'automation', title: 'DCA plan saved (standby)', detail: `${input.amountNear} NEAR of ${token.symbol} every ${input.frequency}` })
      return { ...plan }
    },

    async deleteDcaPlan(id) {
      await wait('write')
      remove(state.dca, id)
    },

    async listCopyRules() {
      await wait('read')
      return state.copy.map((r) => ({ ...r, blacklist: [...r.blacklist] }))
    },

    async createCopyRule(input) {
      await wait('write')
      requireSession(state)
      const error = accountIdError(input.target)
      if (error) throw new ServiceError('invalid-account', `Target wallet: ${error}`)
      if (input.sizing.mode === 'fixed' && !(input.sizing.amountNear > 0)) throw new ServiceError('invalid-amount', 'Enter a fixed size above 0')
      if (input.sizing.mode === 'percent' && !(input.sizing.pct > 0 && input.sizing.pct <= 100)) throw new ServiceError('invalid-amount', 'Percentage must be between 0 and 100')
      if (!(input.maxTradeNear > 0)) throw new ServiceError('invalid-amount', 'Set a maximum trade size')
      if (input.minTradeNear !== null && input.minTradeNear > input.maxTradeNear) throw new ServiceError('invalid-amount', 'Minimum trade is above the maximum')
      const rule: CopyRule = { ...input, id: nextId(state, 'copy'), createdAt: Date.now(), status: 'standby' }
      state.copy.unshift(rule)
      logActivity(state, { kind: 'automation', title: 'Copy rule saved (standby)', detail: `Following ${input.target}` })
      return { ...rule }
    },

    async deleteCopyRule(id) {
      await wait('write')
      remove(state.copy, id)
    },

    async listSniperConfigs() {
      await wait('read')
      return state.sniper.map((s) => ({ ...s }))
    },

    async createSniperConfig(input) {
      await wait('write')
      requireSession(state)
      if (!input.target.trim()) throw new ServiceError('invalid-target', 'Enter a token contract or symbol')
      if (!state.presets.some((p) => p.id === input.presetId)) throw new ServiceError('invalid-preset', 'Choose a wallet preset')
      if (!(input.amountNearPerWallet > 0)) throw new ServiceError('invalid-amount', 'Enter a buy amount above 0')
      if (input.trigger === 'at-time' && (input.triggerAt === null || input.triggerAt <= Date.now())) {
        throw new ServiceError('invalid-time', 'Pick a launch time in the future')
      }
      const config: SniperConfig = { ...input, id: nextId(state, 'snp'), createdAt: Date.now(), status: 'standby' }
      state.sniper.unshift(config)
      logActivity(state, { kind: 'automation', title: 'Sniper config saved (not armed)', detail: input.target })
      return { ...config }
    },

    async deleteSniperConfig(id) {
      await wait('write')
      remove(state.sniper, id)
    },
  }
}
