import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { API_LIMITS } from './limits'

/** Every route of the public API has its own per-IP limit: none falls back to the general one alone. */

const MODULES = ['./linkRoutes.ts', './recoveryRoutes.ts', './telegramRoutes.ts', './handoffRoutes.ts', '../web/routes.ts', '../volumebot/routes.ts', '../kits/routes.ts']
const routes = MODULES.flatMap((m) => [...readFileSync(new URL(m, import.meta.url), 'utf8').matchAll(/^\s+'(\/api\/[a-z/-]+)': async/gm)].map((x) => x[1] as string))

describe('API rate limits', () => {
  it('names every route, each with its own limit per IP and minute', () => {
    expect(routes.length).toBeGreaterThan(30)
    for (const r of routes) expect(API_LIMITS[r], r).toBeGreaterThan(0)
  })
})
