import { describe, expect, it } from 'vitest'
import { FAQ } from '@/features/volumeBot/content'
import { BETA_COMING_SOON } from './release'
import { AI_CRAWLERS, headHtml, headTags, isNoindexPath, jsonLdText, kitDescription, llmsTxt, pageGraph, pageSeo, publicPages, PRIVATE_PATHS, robotsTxt, siteGraph } from './seo'
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

  it('$KITS is described as what it is: Near Kits, the NEARKITS token at kits.nearlytrade.near, its tax and where it goes; no price or supply claimed', () => {
    const page = pageSeo('/kit')
    expect(page).toMatchObject({ title: '$KITS (Near Kits), the NEARKITS token · NEARKITS', name: '$KITS' })
    expect(page?.description).toBe(
      '$KITS (Near Kits) is the NEARKITS token on NEAR, at kits.nearlytrade.near: a 2% buy and sell tax, split 50/50 between Buyback & Burn and holder rewards.',
    )
    expect(page?.description.length).toBeLessThanOrEqual(160)
    expect(page?.description).not.toMatch(/\$KIT\b|not launched/)
  })

  it('$KITS’ page states what it is and its launch configuration: the tax and its split, apart from them the pool fee and NEARKITS’ share, tracking as it stands, nothing promised', () => {
    const facts = pageSeo('/kit')?.facts ?? []
    expect(facts).toEqual([
      '$KITS (Near Kits) is the NEARKITS token; its contract on NEAR is kits.nearlytrade.near.',
      '$KITS has a 2% buy tax and a 2% sell tax.',
      'The tax is split 50% to Buyback & Burn and 50% to holder rewards; 0% goes to the creator.',
      'Separately from the tax, the pool fee is 1%, and 70% of the pool fee is allocated to NEARKITS.',
      'The Buyback & Burn tracker shows only real on-chain activity. Holder reward tracking is coming soon.',
      'No return, reward rate, burn amount or buyback frequency is promised.',
    ])
    for (const p of publicPages().filter((x) => x.path !== '/kit')) expect(p.facts, p.path).toBeUndefined()
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

  it('llms.txt says who signs, where withdrawals go, the risks, what $KITS is and what is coming soon, and links the bot', () => {
    const txt = llmsTxt(URL, 'NearKitBot')
    expect(txt).toContain('[@NearKitBot](https://t.me/NearKitBot)')
    expect(txt).toMatch(/NEARKITS wallets are custodial/)
    expect(txt).toMatch(/owner wallet/)
    expect(txt).toMatch(/can lose money/)
    expect(txt).toContain(kitDescription())
    expect(txt).toContain(
      '- $KITS tokenomics, from its launch configuration on Nearly: $KITS (Near Kits) is the NEARKITS token; its contract on NEAR is kits.nearlytrade.near. $KITS has a 2% buy tax and a 2% sell tax. The tax is split 50% to Buyback & Burn',
    )
    expect(txt).not.toMatch(/\$KIT\b/)
    expect(txt).toContain('Separately from the tax, the pool fee is 1%, and 70% of the pool fee is allocated to NEARKITS.')
    expect(txt).not.toMatch(/APR|APY|guaranteed/i)
    expect(txt).toMatch(/Coming soon[^\n]*limit orders[^\n]*DCA[^\n]*copy trading[^\n]*sniper/i)
    expect(llmsTxt(URL)).not.toContain('t.me/')
  })
})

describe('structured data as one graph', () => {
  it('every @id a page’s nodes refer to is a node of that page: no orphans, no dangling links', () => {
    const URL2 = 'https://nearkits.com'
    for (const p of publicPages()) {
      const graph = [...siteGraph(URL2, 'NearKitBot'), ...pageGraph(URL2, p.path)] as Record<string, unknown>[]
      const ids = new Set(graph.map((n) => n['@id']).filter(Boolean))
      const refs: string[] = []
      const walk = (v: unknown, top: boolean) => {
        if (Array.isArray(v)) return v.forEach((x) => walk(x, false))
        if (!v || typeof v !== 'object') return
        const o = v as Record<string, unknown>
        if (!top && typeof o['@id'] === 'string' && Object.keys(o).length === 1) refs.push(o['@id'])
        for (const [k, x] of Object.entries(o)) if (k !== '@id') walk(x, false)
      }
      graph.forEach((n) => walk(n, true))
      for (const r of refs) expect(ids.has(r), `${p.path}: ${r}`).toBe(true)
    }
    const bot = pageGraph(URL2, '/volume-bot') as Record<string, unknown>[]
    expect(bot.map((n) => n['@id'])).toEqual([
      'https://nearkits.com/volume-bot#webpage',
      'https://nearkits.com/volume-bot#app',
      'https://nearkits.com/volume-bot#breadcrumb',
      'https://nearkits.com/volume-bot#faq',
    ])
  })
})
