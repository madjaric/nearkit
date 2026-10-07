import { ENV_ISSUES } from '@/config/env'
import { KITS_CONTRACT } from '@/config/kit'
import { createNearKitWeb } from '../nearkitWeb'
import type { Capabilities, NearKitServices } from '../types'
import { createAutomationService } from './automationService'
import { createExecutionService } from './executionService'
import { createPortfolioService } from './portfolioService'
import { createState, type MockState } from './state'
import { createTokenService } from './tokenService'
import { createTradingService } from './tradingService'
import { createTransferService } from './transferService'
import { createWalletService } from './walletService'

const DEMO_CAPABILITIES: Capabilities = {
  mode: 'demo',
  network: null,
  networkLabel: 'Demo',
  explorerUrl: null,
  rpcUrls: [],
  prices: true,
  pnl: true,
  automation: 'demo',
  execution: { enabled: true, simulated: true, reason: null, trading: { enabled: true, reason: null, router: 'demo', feeCharged: false, feeRecipient: null } },
  // The demo previews $KITS at its one contract (src/config/kit.ts).
  kitContract: KITS_CONTRACT,
  configIssues: ENV_ISSUES,
}

/**
 * In-memory implementation of every NearKit service. State lives for the page
 * session; `resetDemo` restores the seed. Nothing here signs or sends anything.
 */
export function createMockServices(): NearKitServices {
  const holder: { state: MockState } = { state: createState() }
  // Services read state through a proxy so a reset swaps everything at once.
  const state = new Proxy({} as MockState, {
    get: (_, key) => holder.state[key as keyof MockState],
    set: (_, key, value) => {
      ;(holder.state as unknown as Record<string | symbol, unknown>)[key] = value
      return true
    },
  })
  return {
    mode: 'demo',
    capabilities: DEMO_CAPABILITIES,
    tokens: createTokenService(state),
    wallets: createWalletService(state),
    transfers: createTransferService(state),
    trading: createTradingService(state),
    execution: createExecutionService(state),
    automation: createAutomationService(state),
    portfolio: createPortfolioService(state),
    // The demo runs without NearKit's server: no NearKit wallets here.
    nearkit: createNearKitWeb({ apiUrl: null, network: 'demo' }),
    resetDemo: () => {
      holder.state = createState()
    },
  }
}

export { setMockLatencyScale, ServiceError } from './state'
export { setSimulationLatency } from './executionService'
