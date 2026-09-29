import { accountIdError, accountKind } from '@/lib/validation'
import { MAIN_ACCOUNT } from '@/mocks/wallets'
import { TOKEN_IDS } from '@/mocks/tokens'
import type { PresetInput, Wallet, WalletPreset } from '@/types/domain'
import type { WalletService } from '../types'
import { ServiceError, balanceOf, nextId, priceOf, tickMarket, wait, type MockState } from './state'

function validatePreset(state: MockState, input: PresetInput, ignoreId?: string): PresetInput {
  const name = input.name.trim().toUpperCase()
  if (!name) throw new ServiceError('invalid-name', 'Give the preset a name')
  if (name.length > 24) throw new ServiceError('invalid-name', 'Keep names to 24 characters')
  if (state.presets.some((p) => p.id !== ignoreId && p.name.toUpperCase() === name)) {
    throw new ServiceError('duplicate-name', `A preset named ${name} already exists`)
  }
  const walletIds = [...new Set(input.walletIds)].filter((id) => state.wallets.some((w) => w.id === id))
  if (walletIds.length === 0) throw new ServiceError('no-wallets', 'Select at least one wallet')
  return { name, walletIds, note: (input.note ?? '').trim() }
}

/** Demo wallets: the seeded demo account and its 11 managed wallets. Nothing connects to a real wallet. */
export function createWalletService(state: MockState): WalletService {
  return {
    async getSession() {
      await wait('read')
      return state.session ? { ...state.session } : null
    },

    async listWalletOptions() {
      return []
    },

    async connect() {
      await wait('write')
      state.session = { accountId: MAIN_ACCOUNT, walletId: 'w01', connectedAt: Date.now(), mode: 'demo' }
      return { ...state.session }
    },

    async disconnect() {
      await wait('read')
      state.session = null
    },

    async signMessage() {
      throw new ServiceError('demo', 'Signing a message needs a real wallet. The demo signs nothing.')
    },

    async listWallets() {
      await wait('read')
      if (!state.session) return []
      return state.wallets.map((w) => ({ ...w, access: w.access ?? 'signer' }))
    },

    async listSnapshots() {
      await wait('read')
      if (!state.session) return []
      tickMarket(state)
      return state.wallets.map((w) => {
        const holdings = state.holdings.filter((h) => h.walletId === w.id).map((h) => ({ ...h }))
        return {
          ...w,
          access: w.access ?? 'signer',
          nearBalance: balanceOf(state, w.id, TOKEN_IDS.near),
          holdings,
          valueUsd: holdings.reduce((s, h) => s + h.amount * priceOf(state, h.tokenId), 0),
        }
      })
    },

    async listHoldings() {
      await wait('read')
      if (!state.session) return []
      return state.holdings.map((h) => ({ ...h }))
    },

    async addAccount(input) {
      await wait('write')
      const accountId = input.accountId.trim()
      const error = accountIdError(accountId)
      if (error) throw new ServiceError('invalid-account', error)
      if (state.wallets.some((w) => w.accountId === accountId)) throw new ServiceError('duplicate-account', `${accountId} is already in your wallets`)
      const wallet: Wallet = {
        id: nextId(state, 'watch'),
        label: input.label?.trim() || `Watch ${state.wallets.filter((w) => w.access === 'watch').length + 1}`,
        accountId,
        kind: accountKind(accountId) === 'named' ? 'named' : 'implicit',
        isMain: false,
        access: 'watch',
      }
      state.wallets.push(wallet)
      return { ...wallet }
    },

    async removeAccount(id) {
      await wait('write')
      const wallet = state.wallets.find((w) => w.id === id)
      if (!wallet) throw new ServiceError('not-found', 'Wallet not found')
      if (wallet.isMain) throw new ServiceError('main-wallet', 'The main wallet cannot be removed')
      state.wallets = state.wallets.filter((w) => w.id !== id)
      state.holdings = state.holdings.filter((h) => h.walletId !== id)
      for (const p of state.presets) p.walletIds = p.walletIds.filter((w) => w !== id)
    },

    async listPresets() {
      await wait('read')
      return state.presets.map((p) => ({ ...p, walletIds: [...p.walletIds] }))
    },

    async createPreset(input) {
      await wait('write')
      const clean = validatePreset(state, input)
      const now = Date.now()
      const preset: WalletPreset = { id: nextId(state, 'preset'), name: clean.name, walletIds: clean.walletIds, note: clean.note ?? '', createdAt: now, updatedAt: now }
      state.presets.push(preset)
      return { ...preset }
    },

    async updatePreset(id, input) {
      await wait('write')
      const preset = state.presets.find((p) => p.id === id)
      if (!preset) throw new ServiceError('not-found', 'Preset not found')
      const clean = validatePreset(state, input, id)
      Object.assign(preset, { name: clean.name, walletIds: clean.walletIds, note: clean.note ?? '', updatedAt: Date.now() })
      return { ...preset }
    },

    async duplicatePreset(id) {
      await wait('write')
      const source = state.presets.find((p) => p.id === id)
      if (!source) throw new ServiceError('not-found', 'Preset not found')
      let name = `${source.name} COPY`
      for (let n = 2; state.presets.some((p) => p.name === name); n++) name = `${source.name} COPY ${n}`
      const now = Date.now()
      const copy: WalletPreset = { ...source, id: nextId(state, 'preset'), name: name.slice(0, 24), walletIds: [...source.walletIds], createdAt: now, updatedAt: now }
      state.presets.splice(state.presets.indexOf(source) + 1, 0, copy)
      return { ...copy }
    },

    async deletePreset(id) {
      await wait('write')
      const index = state.presets.findIndex((p) => p.id === id)
      if (index < 0) throw new ServiceError('not-found', 'Preset not found')
      state.presets.splice(index, 1)
    },
  }
}
