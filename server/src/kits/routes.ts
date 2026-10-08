import { HttpError, type Route } from '../api/http'
import type { KitsBurnTracker } from './burns'

/**
 * $KITS' Buyback & Burn for the web app's $KITS page: public, read-only and cached (burns.ts). It
 * takes no input, so nothing but kits.nearlytrade.near on NEAR mainnet can ever be read through it.
 */
export function kitsRoutes(deps: { burns: KitsBurnTracker }): Record<string, Route> {
  return {
    '/api/kits/burns': async () => {
      try {
        return await deps.burns.view()
      } catch {
        throw new HttpError(503, 'chain', 'NEARKITS can’t read $KITS’ burns from NEAR right now. Try again in a moment.')
      }
    },
  }
}
