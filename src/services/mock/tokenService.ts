import { SCAN_SAMPLES } from '@/mocks/scanner'
import { TOKEN_IDS } from '@/mocks/tokens'
import type { MarketFigure, MarketQuote, ScanReport, TokenMarket } from '@/types/domain'
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

    async getPrice(id) {
      await wait('read')
      tickMarket(state)
      return marketFor(id)
    },

    // The demo simulates a price per token and nothing else: no market behind it, no supply to
    // read, no history (its chart shows the simulated prices it sees).
    async getMarketData(id): Promise<TokenMarket> {
      await wait('read')
      tickMarket(state)
      const m = state.market.get(id)
      const at = Date.now()
      const simulated: MarketFigure = { state: 'not-applicable', reason: 'The demo simulates prices only: it has no market behind them.' }
      return {
        tokenId: id,
        priceUsd: m ? { state: 'known', value: m.priceUsd, source: 'Demo simulator', at } : simulated,
        priceNear: m ? { state: 'known', value: m.priceNear, source: 'Demo simulator', at } : simulated,
        change24hPct: m && m.change24hPct !== null ? { state: 'known', value: m.change24hPct, source: 'Demo simulator', at } : simulated,
        marketCapUsd: simulated,
        fdvUsd: simulated,
        liquidityUsd: simulated,
        volume24hUsd: simulated,
        supply: { circulating: null, total: null, source: null },
        pair: null,
        updatedAt: at,
      }
    },
    getTotalSupply: async () => null,
    getPriceHistory: async () => null,
    // No made-up trades: the demo has no activity source.
    getActivity: async () => null,

    async lookupToken() {
      throw new ServiceError('demo', 'Looking up a token contract needs a real network. The demo lists sample tokens only.')
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
