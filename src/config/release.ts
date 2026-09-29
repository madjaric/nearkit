import { ENV, PRODUCTION_BUILD, type AppEnv } from './env'

/**
 * Routes the public beta shows as COMING SOON. They keep their pages,
 * code and tests; in the beta the sidebar tags them and their pages are
 * read-only. Remove a route here to ship it.
 */
export const BETA_COMING_SOON: readonly string[] = ['/limit-orders', '/dca', '/copy-trade', '/sniper']

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

/**
 * The Telegram bot is live in a build only when that build names the bot and the
 * NearKit server it talks to (VITE_TELEGRAM_BOT, VITE_NEARKIT_API_URL). Otherwise
 * the Telegram page stays COMING SOON and says why.
 */
export const TELEGRAM_BOT_LIVE: boolean = ENV.services === 'near' && ENV.apiUrl !== null && ENV.telegramBot !== null
