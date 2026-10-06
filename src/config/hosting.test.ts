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

  it('every address but the Mini App can’t be framed, and keeps its security headers; only /tg is framed, by Telegram Web only', () => {
    // Header sources are path-to-regexp with regex groups: matched as regexes here.
    const headersFor = (path: string) => vercel.headers.filter((h) => new RegExp(`^${h.source.replace(/:[a-z]+/gi, '[^/]+')}$`).test(path)).flatMap((h) => h.headers ?? [])
    const value = (path: string, key: string) =>
      headersFor(path)
        .filter((x) => x.key.toLowerCase() === key.toLowerCase())
        .map((x) => x.value)
    for (const p of ['/', '/swap', '/wallets', '/token/abc.near', '/app.html', '/404.html', '/assets/a.js', '/tg/x', '/tg/a/b', '/tgx', '/nope']) {
      expect(value(p, 'Content-Security-Policy').join(' '), p).toContain("frame-ancestors 'none'")
      expect(value(p, 'X-Frame-Options'), p).toEqual(['DENY'])
      expect(value(p, 'Cross-Origin-Opener-Policy'), p).toEqual(['same-origin-allow-popups'])
      expect(value(p, 'X-Content-Type-Options'), p).toEqual(['nosniff'])
    }
    expect(value('/tg', 'Content-Security-Policy').join(' ')).toContain('frame-ancestors https://web.telegram.org')
    expect(value('/tg', 'Content-Security-Policy').join(' ')).not.toContain("frame-ancestors 'none'")
    expect(value('/tg', 'X-Frame-Options')).toEqual([])
    // No plugins and no <base> hijack anywhere; no camera, microphone or location for anything on the page.
    for (const p of ['/', '/tg', '/tg/x', '/wallets']) {
      expect(value(p, 'Content-Security-Policy').join(' '), p).toMatch(/object-src 'none'; base-uri 'none'/)
      expect(value(p, 'Permissions-Policy').join(' '), p).toMatch(/camera=\(\), microphone=\(\), geolocation=\(\)/)
    }
  })

  it('a public page’s file name is never a second address: /swap.html, /index.html redirect to the page itself', () => {
    const redirects = (vercel as unknown as { redirects?: { source: string; destination: string; permanent: boolean }[] }).redirects ?? []
    const redirectOf = (path: string) => {
      for (const r of redirects) {
        const m = new RegExp(`^${r.source.replace(/[.]/g, '\\.')}$`).exec(path)
        if (m) return { to: r.destination.replace(/\$(\d)/g, (_, i: string) => m[Number(i)] ?? ''), permanent: r.permanent }
      }
      return null
    }
    expect(redirectOf('/index.html')).toEqual({ to: '/', permanent: true })
    for (const p of publicPages().filter((x) => x.path !== '/')) expect(redirectOf(`${p.path}.html`), p.path).toEqual({ to: p.path, permanent: true })
    // The app's own files stay where they are (served by rewrites, never redirected).
    for (const p of ['/app.html', '/404.html', '/swap', '/token/abc.near']) expect(redirectOf(p), p).toBeNull()
    expect(rewriteOf('/favicon.ico')).toBe('/favicon-48.png')
  })

  it('sends noindex for every private and COMING SOON page, the shell and the 404 page, and never for a public one', () => {
    for (const p of [...PRIVATE_PATHS, ...BETA_COMING_SOON, '/app.html', '/404.html']) expect(noindexed(p), p).toBe(true)
    for (const p of publicPages()) expect(noindexed(p.path), p.path).toBe(false)
    expect(noindexed('/token/abc.near')).toBe(false)
  })
})
