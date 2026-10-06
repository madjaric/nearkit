import { useEffect, useState, useSyncExternalStore } from 'react'
import { ENV } from '@/config/env'
import { headTags, HOME_TITLE, jsonLdText, pageGraph, pageSeo, siteGraph } from '@/config/seo'
import { canonicalUrl } from '@/config/site'

/** Value that settles `delay` ms after the last change (typing → quote requests). */
export function useDebouncedValue<T>(value: T, delay = 250): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setSettled(value), delay)
    return () => window.clearTimeout(t)
  }, [value, delay])
  return settled
}

/** Current time, re-rendering every `interval` ms. */
export function useNow(interval = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), interval)
    return () => window.clearInterval(t)
  }, [interval])
  return now
}

/** The tab's title: a public page's own (src/config/seo.ts), else "<title> · NEARKITS". */
export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = pageSeo(window.location.pathname)?.title ?? (title ? `${title} · NEARKITS` : HOME_TITLE)
  }, [title])
}

/** Sets (or, with null, removes) one tag of the head: `<meta name|property=key>` or `<link rel=key>`. */
function headTag(kind: 'name' | 'property' | 'link', key: string, value: string | null) {
  const selector = kind === 'link' ? `link[rel="${key}"]` : `meta[${kind}="${key}"]`
  let el = document.head.querySelector<HTMLMetaElement | HTMLLinkElement>(selector)
  if (value === null) return void el?.remove()
  if (!el) {
    el = document.createElement(kind === 'link' ? 'link' : 'meta')
    if (el instanceof HTMLLinkElement) el.rel = key
    else el.setAttribute(kind, key)
    document.head.append(el)
  }
  if (el instanceof HTMLLinkElement) el.href = value
  else el.content = value
}

/**
 * The head of the page at `pathname`, kept as the build wrote it for a fresh load
 * (src/prerender.tsx), as the app moves between pages: description, canonical address on the
 * public domain (whichever host served it), robots, link preview and structured data. A route
 * that doesn't exist (`notFound`) and a private page are never indexed.
 */
export function useRouteMeta(pathname: string, notFound = false): void {
  useEffect(() => {
    const h = headTags(ENV.publicUrl, pathname)
    const robots = notFound ? 'noindex' : h.robots
    // A page without its own entry (a token's) is still known by its own address, unless it is never indexed.
    const canonical = robots ? null : (h.canonical ?? canonicalUrl(ENV.publicUrl, pathname))
    headTag('name', 'description', h.description)
    headTag('name', 'robots', robots)
    headTag('link', 'canonical', canonical)
    headTag('property', 'og:url', canonical)
    headTag('property', 'og:title', h.ogTitle)
    headTag('property', 'og:description', h.description)
    headTag('name', 'twitter:title', h.ogTitle)
    headTag('name', 'twitter:description', h.description)
    const page = pageSeo(pathname)
    let ld = document.head.querySelector<HTMLScriptElement>('script[type="application/ld+json"]')
    if (!ld) {
      ld = document.createElement('script')
      ld.type = 'application/ld+json'
      document.head.append(ld)
    }
    ld.textContent = jsonLdText([...siteGraph(ENV.publicUrl, ENV.telegramBot), ...(page ? pageGraph(ENV.publicUrl, page.path) : [])])
  }, [pathname, notFound])
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const mq = window.matchMedia(query)
      mq.addEventListener('change', notify)
      return () => mq.removeEventListener('change', notify)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}

/** Remembers the previous value of something across renders (for tick direction). */
export function usePrevious<T>(value: T): T | undefined {
  const [state, setState] = useState<{ current: T; previous: T | undefined }>({ current: value, previous: undefined })
  if (!Object.is(state.current, value)) setState({ current: value, previous: state.current })
  return state.previous
}
