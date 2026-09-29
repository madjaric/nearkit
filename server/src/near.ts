import { NearKitError } from '@/services/near/errors'
import { createNearContext } from '@/services/real/context'
import { createMarket } from '@/services/real/market'
import { memoryStorage } from '@/services/real/stores'
import { createTokenService } from '@/services/real/tokenService'
import { createTradingService } from '@/services/real/tradingService'
import type { ServerConfig } from './config'

/**
 * NearKit's own services, as the web app runs them: token metadata and lookup
 * from chain, Rhea quotes with every route check, prices. The server has no
 * wallet: anything that would sign refuses, and trades are signed in the user's
 * wallet in the NearKit web app.
 */
export function createServerNear(config: Pick<ServerConfig, 'env' | 'network'>, fetchImpl: typeof fetch, now: () => number = Date.now) {
  const ctx = createNearContext({
    env: config.env,
    network: config.network,
    fetch: fetchImpl,
    kv: memoryStorage(),
    now,
    wallet: () => Promise.reject(new NearKitError('WALLET_UNAVAILABLE', 'The NearKit server holds no keys and never signs. Transactions are signed in your wallet.')),
  })
  // No wallet session on the server: services never try to restore one.
  ctx.session.restored = true
  const market = createMarket(ctx)
  const tokens = createTokenService(ctx, market)
  const trading = createTradingService(ctx, market, { getSession: async () => null, listWallets: async () => [] })
  return { ctx, market, tokens, trading }
}

export type ServerNear = ReturnType<typeof createServerNear>
