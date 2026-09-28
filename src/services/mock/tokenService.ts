import { SCAN_SAMPLES } from '@/mocks/scanner'
import { TOKEN_IDS } from '@/mocks/tokens'
import type { MarketQuote, ScanReport } from '@/types/domain'
import type { TokenService } from '../types'
import { ServiceError, tickMarket, wait, type MockState } from './state'

function normalize(query: string): string {
  return query.trim().toLowerCase().replace(/^\$/, '')
}

export function createTokenService(state: MockState): TokenService {
  const marketFor = (id: string): MarketQuote | null => {
    const m = state.market.get(id)
    return m ? { ...m } : null
  }

  return {
    async listTokens() {
      await wait('read')
      tickMarket(state)
      return state.tokens.map((t) => ({ ...t, market: marketFor(t.id) }))
    },

    async getToken(id) {
      await wait('read')
      tickMarket(state)
      const token = state.tokens.find((t) => t.id === id)
      return token ? { ...token, market: marketFor(id) } : null
    },

    async getMarket(ids) {
      await wait('read')
      tickMarket(state)
      const all = [...state.market.values()].map((m) => ({ ...m }))
      return ids ? all.filter((m) => ids.includes(m.tokenId)) : all
    },

    async getNearPrice() {
      await wait('read')
      tickMarket(state)
      const quote = state.market.get(TOKEN_IDS.near)
      return quote ? { ...quote } : null
    },

    async importToken() {
      throw new ServiceError('demo', 'Importing a token contract needs a real network. The demo lists sample tokens only.')
    },

    async scan(query): Promise<ScanReport | null> {
      await wait('scan')
      const q = normalize(query)
      if (!q) return null
      const sample = SCAN_SAMPLES.find((s) => s.symbol.toLowerCase() === q || s.contract === q || s.name.toLowerCase() === q)
      return sample ? { ...structuredClone(sample), query, scannedAt: Date.now() } : null
    },

    async scanSuggestions() {
      return SCAN_SAMPLES.map((s) => ({ query: s.contract, label: s.symbol }))
    },
  }
}
