import { describe, expect, it } from 'vitest'
import { FAQ } from '@/features/volumeBot/content'
import { BETA_COMING_SOON } from './release'
import { AI_CRAWLERS, headHtml, headTags, isNoindexPath, jsonLdText, llmsTxt, pageGraph, pageSeo, publicPages, PRIVATE_PATHS, robotsTxt, siteGraph } from './seo'
import { SITEMAP_PATHS } from './site'

const URL = 'https://nearkits.com'

describe('each public page’s title and description', () => {
  it('exist for every sitemap page, each its own, short enough to show whole in results', () => {
    const pages = publicPages()
    expect(pages.map((p) => p.path)).toEqual(SITEMAP_PATHS)
    expect(new Set(pages.map((p) => p.title)).size).toBe(pages.length)
    expect(new Set(pages.map((p) => p.description)).size).toBe(pages.length)
    for (const p of pages) {
      expect(p.title.length, p.title).toBeLessThanOrEqual(70)
      expect(p.description.length, p.description).toBeGreaterThanOrEqual(70)
      expect(p.description.length, p.description).toBeLessThanOrEqual(165)
    }
  })

  it('the Volume Bot page is titled as its H1 says', () => {
    expect(pageSeo('/volume-bot')?.title).toBe('NEARKITS Volume Bot — Automated Trading on NEAR')
    expect(pageSeo('/volume-bot/')?.path).toBe('/volume-bot')
  })

  it('$KIT is described as not launched until it is: no price, contract or supply claimed', () => {
    expect(pageSeo('/kit')?.description).toMatch(/has not launched/)
  })
})

describe('what is never indexed', () => {
  it('personal pages, the bot console, the Mini App and every COMING SOON page', () => {
    for (const p of [...PRIVATE_PATHS, ...BETA_COMING_SOON]) expect(isNoindexPath(p), p).toBe(true)
    for (const p of SITEMAP_PATHS) expect(isNoindexPath(p), p).toBe(false)
    expect(isNoindexPath('/volume-bot/console/')).toBe(true)
  })
})

describe('the head of a page', () => {
  it('names its canonical address, its own title and description, and the link preview', () => {
    const html = headHtml(URL, '/swap', 'NearKitBot')
    expect(html).toContain('<title>Swap NEAR tokens through Rhea · NEARKITS</title>')
    expect(html).toContain('<link rel="canonical" href="https://nearkits.com/swap" />')
    expect(html).toContain('<meta property="og:url" content="https://nearkits.com/swap" />')
    expect(html).toContain('<meta property="og:image" content="https://nearkits.com/og.png" />')
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />')
    expect(html).not.toContain('name="robots"')
  })

  it('a page with no entry (a token, the app’s inside) gets no canonical: the app sets it as it renders', () => {
    expect(headTags(URL, '/token/usdt.tether-token.near').canonical).toBeNull()
    expect(headTags(URL, '/wallets')).toMatchObject({ canonical: null, robots: 'noindex' })
  })

  it('escapes what it prints', () => {
    const html = headHtml(URL, '/docs', null)
    expect(html).toContain('what runs for real and what doesn’t yet')
    expect(html).not.toMatch(/content="[^"]*<[^"]*"/)
  })
})

describe('structured data', () => {
  it('the organization and the site on every page; the Telegram bot as the organization’s profile when the build names it', () => {
    const [org, site] = siteGraph(URL, 'NearKitBot')
    expect(org).toMatchObject({
      '@type': 'Organization',
      name: 'NEARKITS',
      url: 'https://nearkits.com/',
      logo: 'https://nearkits.com/icon-512.png',
      sameAs: ['https://t.me/NearKitBot'],
    })
    expect(site).toMatchObject({ '@type': 'WebSite', url: 'https://nearkits.com/', publisher: { '@id': 'https://nearkits.com/#organization' } })
    expect(siteGraph(URL, null)[0]).not.toHaveProperty('sameAs')
  })

  it('the Volume Bot page: the app, its visible breadcrumb and its visible FAQ, question for question; no rating or review anywhere', () => {
    const graph = pageGraph(URL, '/volume-bot')
    expect(graph.map((g) => g['@type'])).toEqual(['WebPage', 'SoftwareApplication', 'BreadcrumbList', 'FAQPage'])
    // Dated as the page shows it, written by NEARKITS: no invented person.
    expect(graph[0]).toMatchObject({ dateModified: '2026-10-06', author: { '@id': 'https://nearkits.com/#organization' } })
    const faq = graph[3] as { mainEntity: { name: string; acceptedAnswer: { text: string } }[] }
    expect(faq.mainEntity.map((q) => [q.name, q.acceptedAnswer.text])).toEqual(FAQ.map((f) => [f.q, f.a]))
    const all = JSON.stringify([...siteGraph(URL, null), ...pageGraph(URL, '/'), ...graph])
    expect(all).not.toMatch(/aggregateRating|"review"|ratingValue/)
  })

  it('is valid JSON that no text in it can break out of', () => {
    const text = jsonLdText([{ '@type': 'Thing', name: '</script><script>alert(1)</script>' }])
    expect(text).not.toContain('</script>')
    expect(JSON.parse(text)['@graph'][0].name).toBe('</script><script>alert(1)</script>')
  })
})

describe('crawler files', () => {
  it('robots.txt lets every crawler in, names the AI crawlers explicitly, and points to the sitemap', () => {
    const txt = robotsTxt(URL)
    expect(txt.startsWith('User-agent: *\nAllow: /\n')).toBe(true)
    for (const a of AI_CRAWLERS) expect(txt).toContain(`User-agent: ${a}\n`)
    expect(txt).not.toMatch(/Disallow/)
    expect(txt.trimEnd().endsWith('Sitemap: https://nearkits.com/sitemap.xml')).toBe(true)
  })

  it('llms.txt names NEARKITS, what it does, and every public page with its description', () => {
    const txt = llmsTxt(URL)
    expect(txt.startsWith('# NEARKITS\n\n> ')).toBe(true)
    for (const p of publicPages().filter((x) => x.path !== '/')) expect(txt).toContain(`(https://nearkits.com${p.path}): ${p.description}`)
  })
})
