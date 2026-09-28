import { ENV, PRODUCTION_BUILD, type AppEnv } from './env'

/**
 * Routes the public beta shows as COMING SOON. They keep their pages,
 * code and tests; in the beta the sidebar tags them and their pages are
 * read-only. Remove a route here to ship it.
 */
export const BETA_COMING_SOON: readonly string[] = ['/multi-trade', '/limit-orders', '/dca', '/copy-trade', '/sniper', '/pnl']

/**
 * Held back in every production build of the real services, on either network,
 * so a mainnet build never ships them early. The dev server, tests and the demo
 * keep every feature usable.
 */
export function comingSoonRoutes(build: { services: AppEnv['services']; network: AppEnv['network']; production: boolean }): readonly string[] {
  return build.services === 'near' && build.production ? BETA_COMING_SOON : []
}

const COMING_SOON = comingSoonRoutes({ services: ENV.services, network: ENV.network, production: PRODUCTION_BUILD })

/** True when this route is COMING SOON in this build. */
export function isComingSoon(path: string): boolean {
  return COMING_SOON.includes(path)
}
