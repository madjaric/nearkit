import { HttpError, type Route } from '../api/http'
import type { KitsBurnTracker } from './burns'
import type { KitsRewardsTracker } from './rewards'

/**
 * $KITS' Buyback & Burn and holder rewards for the web app's $KITS page: public, read-only and cached
 * (burns.ts, rewards.ts). They take no input, so nothing but kits.nearlytrade.near on NEAR mainnet can
 * ever be read through them.
 */
export function kitsRoutes(deps: { burns: KitsBurnTracker; rewards?: KitsRewardsTracker | null }): Record<string, Route> {
  const rewards = deps.rewards
  return {
    '/api/kits/burns': async () => {
      try {
        return await deps.burns.view()
      } catch {
        throw new HttpError(503, 'chain', 'NEARKITS can’t read $KITS’ burns from NEAR right now. Try again in a moment.')
      }
    },
    ...(rewards
      ? {
          '/api/kits/rewards': async () => {
            try {
              return await rewards.view()
            } catch {
              throw new HttpError(503, 'chain', 'NEARKITS can’t read $KITS’ holder rewards from NEAR right now. Try again in a moment.')
            }
          },
        }
      : {}),
  }
}
