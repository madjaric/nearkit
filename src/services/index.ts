import { ENV, ENV_ISSUES, NETWORK } from '@/config/env'
import { createMockServices } from './mock'
import { createNearServices } from './real'
import type { NearKitServices } from './types'

/**
 * The one place that decides which implementation NearKit runs on:
 * `VITE_NEARKIT_SERVICES=demo` runs the simulated demo, anything else runs on
 * NEAR (`VITE_NEAR_NETWORK`, testnet by default). No component imports an
 * implementation directly.
 */
export function createServices(): NearKitServices {
  if (ENV.services === 'demo') return createMockServices()
  return createNearServices({ env: ENV, network: NETWORK, issues: ENV_ISSUES })
}

export type { NearKitServices } from './types'
