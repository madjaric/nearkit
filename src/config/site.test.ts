import { describe, expect, it } from 'vitest'
import { BETA_COMING_SOON } from './release'
import { DEFAULT_PUBLIC_URL, SITEMAP_PATHS, canonicalUrl, parsePublicUrl, sitemapXml } from './site'

describe('the public address', () => {
  it('is nearkits.com unless a build names another origin', () => {
    expect(DEFAULT_PUBLIC_URL).toBe('https://nearkits.com')
    expect(parsePublicUrl(undefined)).toBe('https://nearkits.com')
    expect(parsePublicUrl('  ')).toBe('https://nearkits.com')
    expect(parsePublicUrl('https://staging.example/')).toBe('https://staging.example')
    expect(parsePublicUrl('http://localhost:5196')).toBe('http://localhost:5196')
  })

  it('is an https origin only (http on localhost): no path, query, hash or credentials', () => {
    for (const bad of [
      'http://nearkits.com',
      'https://nearkits.com/app',
      'https://nearkits.com/?x=1',
      'https://nearkits.com/#a',
      'nearkits.com',
      'ftp://nearkits.com',
      'https://user:pw@nearkits.com',
    ])
      expect(parsePublicUrl(bad), bad).toBeNull()
  })
})

describe('canonicalUrl', () => {
  it('names the public origin and the path only: no query, hash or trailing slash', () => {
    expect(canonicalUrl('https://nearkits.com', '/')).toBe('https://nearkits.com/')
    expect(canonicalUrl('https://nearkits.com', '')).toBe('https://nearkits.com/')
    expect(canonicalUrl('https://nearkits.com', '/token/usdt.tether-token.near')).toBe('https://nearkits.com/token/usdt.tether-token.near')
    expect(canonicalUrl('https://nearkits.com', '/swap/')).toBe('https://nearkits.com/swap')
    expect(canonicalUrl('https://nearkits.com', '/swap?from=near&to=usdt#x')).toBe('https://nearkits.com/swap')
  })
})

describe('crawler files', () => {
  it('sitemap.xml lists the shipped public pages on the public origin, never a COMING SOON page or a personal one', () => {
    const xml = sitemapXml('https://nearkits.com')
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n')).toBe(true)
    expect(xml.match(/<loc>[^<]+<\/loc>/g)).toEqual(SITEMAP_PATHS.map((p) => `<loc>${canonicalUrl('https://nearkits.com', p)}</loc>`))
    expect(xml).toContain('<loc>https://nearkits.com/</loc>')
    for (const p of [...BETA_COMING_SOON, '/tg', '/recover', '/settings', '/wallets', '/positions', '/pnl']) expect(SITEMAP_PATHS).not.toContain(p)
    expect(xml).not.toContain('vercel.app')
  })
})
