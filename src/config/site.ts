/**
 * NearKit's public web address: the one pages, search engines and link previews name as its own
 * (canonical). A build may name another with VITE_PUBLIC_URL (an https origin, no path); env.ts
 * reads it. Shared with vite.config.ts, so this module reads no build environment itself.
 */
export const DEFAULT_PUBLIC_URL = 'https://nearkits.com'

/** The pages sitemap.xml lists: shipped, public, and the same for every visitor (no wallet-specific or COMING SOON pages). Each has its title and description in seo.ts. */
export const SITEMAP_PATHS: readonly string[] = ['/', '/swap', '/multi-trade', '/split', '/consolidate', '/batch-send', '/scanner', '/volume-bot', '/kit', '/telegram', '/docs']

/** The public address as an origin (https, or http on localhost; no path, query, hash or credentials). Blank: NearKit's own. Null: not one. */
export function parsePublicUrl(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PUBLIC_URL
  try {
    const u = new URL(raw.trim())
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null
    if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) return null
    return u.origin
  } catch {
    return null
  }
}

/** The address a page is known by: the public origin and its path, without query, hash or trailing slash (the root keeps its "/"). */
export function canonicalUrl(publicUrl: string, pathname: string): string {
  const path = (pathname.split(/[?#]/)[0] ?? '').replace(/^\/+|\/+$/g, '')
  return `${publicUrl}/${path}`
}

export function sitemapXml(publicUrl: string): string {
  const urls = SITEMAP_PATHS.map((p) => `  <url><loc>${canonicalUrl(publicUrl, p)}</loc></url>`)
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...urls, '</urlset>', ''].join('\n')
}
