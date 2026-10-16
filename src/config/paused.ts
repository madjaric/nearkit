/**
 * Tools paused by a product decision: COMING SOON in every build and mode, whatever NEARKITS' server
 * runs. Opening the route, or any page under it, shows a Coming Soon screen; every listing wears a
 * Coming soon badge; no link leads into the tool; search engines, the sitemap and llms.txt leave it out.
 * The tool's code, its data on NEARKITS' server and its API stay as they are: this hides it, nothing more.
 *
 * Top Wallets, paused 2026-10-16: its rankings wait until the swap index covers enough history.
 * To bring it back: set TOP_WALLETS_PAUSED to false, and in vercel.json serve /top-wallets from
 * /top-wallets.html again (with /launch-radar) and drop it from the noindex list.
 *
 * No build environment is read here (site.ts and vite.config.ts use this module too).
 */
export const TOP_WALLETS_PAUSED = true

export const PAUSED_ROUTES: readonly string[] = TOP_WALLETS_PAUSED ? ['/top-wallets'] : []

/** The route, or a page under it (`/top-wallets/abc.near`), belongs to a paused tool. */
export function isPaused(path: string): boolean {
  const p = path.replace(/\/+$/, '') || '/'
  return PAUSED_ROUTES.some((r) => p === r || p.startsWith(`${r}/`))
}

/** The badge a tool that isn't live wears where it is listed: a paused tool's says so in full. */
export function soonLabel(path: string): string {
  return isPaused(path) ? 'Coming soon' : 'Soon'
}
