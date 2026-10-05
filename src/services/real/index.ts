import { createNearKitWeb } from '../nearkitWeb'
import type { NearKitServices } from '../types'
import { createAutomationService } from './automationService'
import { createNearContext, type NearContextOptions } from './context'
import { createExecutionService } from './executionService'
import { createMarket } from './market'
import { createPnlTracker } from './pnlTracker'
import { createPortfolioService } from './portfolioService'
import { createTokenService } from './tokenService'
import { createTradingService } from './tradingService'
import { createTransferService } from './transferService'
import { createWalletService } from './walletService'

/**
 * NearKit on NEAR: wallet through NEAR Connect, balances and metadata from RPC,
 * token discovery from indexers (verified on chain), swaps through Rhea, and one
 * executor that signs through the wallet and confirms on chain.
 */
export function createNearServices(options: NearContextOptions): NearKitServices {
  const ctx = createNearContext(options)
  const market = createMarket(ctx)
  const nearkit =
    options.nearkit ??
    createNearKitWeb({
      apiUrl: options.env.apiUrl,
      network: options.network.id,
      ...(options.fetch ? { fetchImpl: options.fetch } : {}),
      ...(options.kv ? { store: options.kv } : {}),
    })
  const wallets = createWalletService(ctx, market, nearkit)
  /** Plans being executed right now; reconciliation leaves them alone. */
  const active = new Set<string>()
  return {
    mode: 'near',
    capabilities: ctx.capabilities,
    tokens: createTokenService(ctx, market, wallets),
    wallets,
    transfers: createTransferService(ctx, wallets),
    trading: createTradingService(ctx, market, wallets),
    execution: createExecutionService(ctx, active),
    automation: createAutomationService(ctx, wallets),
    portfolio: createPortfolioService(ctx, market, wallets, active, createPnlTracker(ctx), nearkit),
    nearkit,
  }
}
