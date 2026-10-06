import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BETA_COMING_SOON } from './release'
import { PRIVATE_PATHS, publicPages } from './seo'

/**
 * vercel.json against the app: every route the router knows is served (a public page from its
 * prerendered file, any other from the app's shell), anything else is a real 404 (no catch-all
 * rewrite turns a typo into a 200 page), and every private or COMING SOON page is sent noindex.
 */

interface Rule {
  source: string
  destination?: string
  headers?: { key: string; value: string }[]
}
const vercel = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8')) as { rewrites: Rule[]; headers: Rule[]; trailingSlash?: boolean }
const routerText = readFileSync(new URL('../router.tsx', import.meta.url), 'utf8')

/** Vercel's source patterns as used here: literal segments, `:param` and `(a|b)` groups. */
function matches(source: string, path: string): boolean {
  const pattern = source.replace(/[.]/g, '\\.').replace(/:[a-z]+/gi, '[^/]+')
  return new RegExp(`^${pattern}$`).test(path)
}
const rewriteOf = (path: string) => vercel.rewrites.find((r) => matches(r.source, path))?.destination ?? null
const noindexed = (path: string) => vercel.headers.some((h) => matches(h.source, path) && h.headers?.some((x) => x.key === 'X-Robots-Tag' && x.value === 'noindex'))

/** The router's paths, as written in router.tsx ("token/:id" becomes "/token/abc.near"). */
const routerPaths = [...routerText.matchAll(/path: '([^']+)'/g)].map((m) => `/${m[1]}`.replace(':id', 'abc.near')).filter((p) => p !== '/*')

describe('hosting (vercel.json)', () => {
  it('serves each public page from its own prerendered file', () => {
    for (const p of publicPages().filter((x) => x.path !== '/')) expect(rewriteOf(p.path), p.path).toBe(`${p.path}.html`)
  })

  it('serves every other route the router knows from the app’s shell', () => {
    const own = new Set(publicPages().map((p) => p.path))
    const rest = routerPaths.filter((p) => !own.has(p))
    expect(rest.length).toBeGreaterThan(10)
    for (const p of rest) expect(rewriteOf(p), p).toBe('/app.html')
  })

  it('has no catch-all: an unknown address is a 404, not the app answering 200', () => {
    for (const p of ['/nope', '/swap/extra', '/token', '/volume-bot/other', '/wallets/x']) expect(rewriteOf(p), p).toBeNull()
    expect(vercel.rewrites.some((r) => r.source.includes('(.*)'))).toBe(false)
    expect(vercel.trailingSlash).toBe(false)
  })

  it('sends noindex for every private and COMING SOON page, the shell and the 404 page, and never for a public one', () => {
    for (const p of [...PRIVATE_PATHS, ...BETA_COMING_SOON, '/app.html', '/404.html']) expect(noindexed(p), p).toBe(true)
    for (const p of publicPages()) expect(noindexed(p.path), p.path).toBe(false)
    expect(noindexed('/token/abc.near')).toBe(false)
  })
})
