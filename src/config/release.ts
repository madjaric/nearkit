import type { StrategyKind } from '@/lib/automation/config'
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

/** The trading automation each COMING SOON route is (the server switches each kind on by itself). */
export const AUTOMATION_ROUTES: Readonly<Record<string, StrategyKind>> = { '/limit-orders': 'limit', '/dca': 'dca', '/copy-trade': 'copy', '/sniper': 'sniper' }

/**
 * The automation kinds NEARKITS' server is known to run: its answer to the user's NEARKITS web session
 * when there is one, otherwise its public /health (the same server-wide switch, read without signing
 * in). Null when neither has answered: nothing is opened on a guess.
 */
export function knownAutomation(session: readonly StrategyKind[] | undefined, server: readonly StrategyKind[] | null | undefined): readonly StrategyKind[] | null {
  return session ?? server ?? null
}

/**
 * Whether a route is COMING SOON for this user: the build's list, except an automation route whose
 * kind NEARKITS' server reports switched on (`enabled`: knownAutomation). No answer from the server,
 * or the kind not on: COMING SOON, exactly as the build says.
 */
export function routeComingSoon(path: string, comingSoon: readonly string[], enabled: readonly StrategyKind[] | null): boolean {
  if (!comingSoon.includes(path)) return false
  const kind = AUTOMATION_ROUTES[path]
  return !(kind !== undefined && enabled !== null && enabled.includes(kind))
}

/** `isComingSoon` for this build, with the kinds the server switched on for this user (null: none known). */
export function isComingSoonFor(path: string, enabled: readonly StrategyKind[] | null): boolean {
  return routeComingSoon(path, COMING_SOON, enabled)
}

/**
 * The Telegram bot is live in a build only when that build names the bot and the
 * NearKit server it talks to (VITE_TELEGRAM_BOT, VITE_NEARKIT_API_URL). Otherwise
 * the Telegram page stays COMING SOON and says why.
 */
export const TELEGRAM_BOT_LIVE: boolean = ENV.services === 'near' && ENV.apiUrl !== null && ENV.telegramBot !== null
