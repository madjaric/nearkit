import { NATIVE_TOKEN_ID } from '@/config/networks'
import { accountIdError, isForeignToNetwork } from '@/lib/validation'
import { accountState } from '@/services/near/account'
import { NearKitError, toNearKitError } from '@/services/near/errors'
import type { TokenListing } from '@/types/domain'
import type { TokenService } from '../types'
import type { NearContext } from './context'
import type { Market } from './market'
import { createScanner } from './scanner'
import { createTokenActivity } from './tokenActivity'
import { createTokenMarket } from './tokenMarket'

/**
 * Tokens in real mode: native NEAR, the network's configured tokens, $KIT when
 * configured, tokens the user imported, and tokens the connected accounts hold.
 * Every NEP-141 entry is backed by validated on-chain metadata.
 */
export function createTokenService(ctx: NearContext, market: Market): TokenService {
  const held = async (): Promise<string[]> => {
    const accounts = ctx.session.current?.accounts ?? []
    const balances = await Promise.all(accounts.map((id) => ctx.balances.get(id).catch(() => null)))
    return balances.flatMap((b) => b?.fts.map((f) => f.contract) ?? [])
  }

  const list = async (): Promise<TokenListing[]> => market.listTokens(await held())
  const scanner = createScanner(ctx, market)
  const activity = createTokenActivity(ctx)
  const tokenMarket = createTokenMarket(ctx, market)

  /** The checks a token read by exact contract must pass. Nothing is saved here. */
  async function verify(input: string): Promise<{ contract: string; listing: TokenListing }> {
    const contract = input.trim()
    const error = accountIdError(contract)
    if (error) throw new NearKitError('INVALID_TOKEN', `Contract: ${error}`)
    if (isForeignToNetwork(contract, ctx.network.id))
      throw new NearKitError(
        'NETWORK_MISMATCH',
        `${contract} is a ${ctx.network.id === 'mainnet' ? 'testnet' : 'mainnet'} contract; NearKit is on ${ctx.network.label.toLowerCase()}`,
      )
    let state
    try {
      state = await accountState(ctx.rpc, contract, 'final')
    } catch (e) {
      throw toNearKitError(e, 'RPC_ERROR')
    }
    if (!state.exists) throw new NearKitError('INVALID_TOKEN', `${contract} does not exist on ${ctx.network.label.toLowerCase()}`)
    if (!state.hasContract) throw new NearKitError('INVALID_TOKEN', `${contract} is an account without a contract, not a token`)
    // Metadata (NEP-148) and total supply (NEP-141) must both answer before the token is shown.
    await ctx.reader.metadata(contract)
    await ctx.reader.totalSupply(contract)
    const listing = (await market.listTokens([contract])).find((t) => t.id === contract)
    if (!listing) throw new NearKitError('INVALID_TOKEN', `${contract} did not return valid token metadata`)
    return { contract, listing }
  }

  return {
    listTokens: list,

    async getToken(id) {
      const found = (await list()).find((t) => t.id === id)
      if (found || id === NATIVE_TOKEN_ID || accountIdError(id) !== null) return found ?? null
      return (await market.listTokens([id])).find((t) => t.id === id) ?? null
    },

    async lookupToken(input) {
      return (await verify(input)).listing
    },

    async importToken(input) {
      const { contract } = await verify(input)
      ctx.stores.tokens.add(contract)
      const listing = (await market.listTokens([contract])).find((t) => t.id === contract)
      if (!listing) throw new NearKitError('INVALID_TOKEN', `${contract} did not return valid token metadata`)
      return listing
    },

    async getMarket(ids) {
      const tokens = await list()
      return tokens.flatMap((t) => (t.market && (!ids || ids.includes(t.id)) ? [t.market] : []))
    },

    getNearPrice: () => market.nearQuote(),

    getPrice: (id) => market.quoteFor(id),

    async getTotalSupply(id) {
      if (id === NATIVE_TOKEN_ID) return null
      return ctx.reader.totalSupply(id).then(
        (s) => s.toString(),
        () => null,
      )
    },

    async getActivity(id) {
      const txUrl = ctx.network.discovery.fastnearTxUrl
      // NEAR is what tokens are bought and sold with: it has no buys or sells of its own here.
      if (id === NATIVE_TOKEN_ID || !txUrl) return null
      return activity.recent(id, txUrl)
    },

    getMarketData: (id) => tokenMarket.get(id),

    getPriceHistory: (id, range) => tokenMarket.history(id, range),
    scan: (query) => scanner.scan(query),
    scanSuggestions: () => scanner.suggestions(),
  }
}
