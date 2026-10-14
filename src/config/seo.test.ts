import { describe, expect, it } from 'vitest'
import { FAQ } from '@/features/volumeBot/content'
import { BETA_COMING_SOON } from './release'
import { AI_CRAWLERS, headHtml, headTags, isNoindexPath, jsonLdText, kitDescription, llmsTxt, pageGraph, pageSeo, publicPages, PRIVATE_PATHS, robotsTxt, siteGraph } from './seo'
import { SITEMAP_PATHS } from './site'

const URL = 'https://nearkits.com'
const MAINNET = { services: 'near', network: 'mainnet', server: true } as const

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
      'The tax is split 50% Buyback & Burn and 50% Holder rewards; 0% goes to the creator.',
      'Separately from the tax, the pool fee is 1%, and 70% of the pool fee is allocated to NEARKITS.',
      'Buyback & Burn is tracked live on NEAR mainnet: the KITS burned, each burn transaction and the supply after burns, read from the chain. Holder rewards are tracked live too: what Nearly’s launchpad has paid to $KITS holders in NEAR and what it holds for them, each payout round verified on chain.',
      'No return, reward rate, burn amount or buyback frequency is promised.',
    ])
    for (const p of publicPages().filter((x) => !['/kit', '/bridge', '/bridge-near', '/tools'].includes(x.path))) expect(p.facts, p.path).toBeUndefined()
  })

  it('All Tools lists every tool by group for a reader without JavaScript, as the page does', () => {
    const facts = pageSeo('/tools')?.facts ?? []
    expect(facts.map((f) => f.split(':')[0])).toEqual(['Main', 'Trade', 'Tools', 'Automation', 'Portfolio', 'Intelligence', 'Other'])
    expect(facts[0]).toBe('Main: Bridge, Bridge & Buy.')
    expect(facts[1]).toBe('Trade: Swap, Quick Trade, Multi Trade, Limit Orders.')
    expect(facts.join(' ')).toMatch(/Automation: Volume Bot, DCA, Copy Trade, Sniper\./)
    expect(facts[6]).toBe('Other: Settings, Documentation, Telegram.')
  })

  it('Bridge & Buy says what it does: SOL, ETH or BNB through NEAR Intents to $KITS, two steps, non-custodial, its fees apart', () => {
    const page = pageSeo('/bridge')
    expect(page?.title).toBe('Bridge & Buy $KITS from SOL, ETH or BNB · NEARKITS')
    const facts = (page?.facts ?? []).join(' ')
    for (const term of [
      'SOL (Solana)',
      'ETH (Ethereum)',
      'BNB (BNB Chain)',
      'NEAR Intents',
      'kits.nearlytrade.near',
      'two steps',
      'never holds them',
      '0.25%',
      '0.50% trading fee',
    ])
      expect(facts).toContain(term)
    expect(facts).not.toMatch(/guarantee|APR|APY|instant/i)
  })

  it('the Bridge is its own page: SOL, ETH or BNB into NEAR, nothing bought, what arrives and who unwraps it, its fee and no trading fee', () => {
    const page = pageSeo('/bridge-near')
    expect(page?.title).toBe('Bridge SOL, ETH or BNB to NEAR · NEARKITS')
    expect(page?.description).toMatch(/into NEAR/)
    expect(page?.title).not.toBe(pageSeo('/bridge')?.title)
    expect(page?.description).not.toBe(pageSeo('/bridge')?.description)
    const facts = (page?.facts ?? []).join(' ')
    for (const term of [
      'SOL (Solana)',
      'ETH (Ethereum)',
      'BNB (BNB Chain)',
      'NEAR Intents',
      'Nothing is bought',
      'wNEAR',
      'native NEAR',
      'never holds them',
      '0.25%',
      'no trading fee',
    ])
      expect(facts).toContain(term)
    expect(facts).not.toMatch(/kits\.nearlytrade\.near|guarantee|APR|APY|instant/i)
    expect(SITEMAP_PATHS).toContain('/bridge-near')
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
  it('the organization and the site on every page; its official profiles (the Telegram community, X, and the bot when the build names it)', () => {
    const [org, site] = siteGraph(URL, 'NearKitBot')
    expect(org).toMatchObject({
      '@type': 'Organization',
      name: 'NEARKITS',
      url: 'https://nearkits.com/',
      logo: 'https://nearkits.com/icon-512.png',
      sameAs: ['https://t.me/NearKitBot', 'https://t.me/NearKitsCommunity', 'https://x.com/Near_Kits'],
    })
    expect(site).toMatchObject({ '@type': 'WebSite', url: 'https://nearkits.com/', publisher: { '@id': 'https://nearkits.com/#organization' } })
    // The community and X are NEARKITS' own on every build; the bot only where the build names it.
    expect(siteGraph(URL, null)[0]).toMatchObject({ sameAs: ['https://t.me/NearKitsCommunity', 'https://x.com/Near_Kits'] })
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

  it('llms.txt says who signs, where withdrawals go, the risks, what $KITS is and where the automations run, and links the bot', () => {
    const txt = llmsTxt(URL, 'NearKitBot', MAINNET)
    expect(txt).toContain('[@NearKitBot](https://t.me/NearKitBot)')
    expect(txt).toMatch(/NEARKITS wallets are custodial/)
    expect(txt).toMatch(/owner wallet/)
    expect(txt).toMatch(/can lose money/)
    expect(txt).toContain(kitDescription())
    expect(txt).toContain(
      '- $KITS tokenomics, from its launch configuration on Nearly: $KITS (Near Kits) is the NEARKITS token; its contract on NEAR is kits.nearlytrade.near. $KITS has a 2% buy tax and a 2% sell tax. The tax is split 50% Buyback & Burn and 50% Holder rewards',
    )
    expect(txt).not.toMatch(/\$KIT\b/)
    expect(txt).toContain('Separately from the tax, the pool fee is 1%, and 70% of the pool fee is allocated to NEARKITS.')
    expect(txt).not.toMatch(/APR|APY|guaranteed/i)
    // The Bridge, apart from Bridge & Buy: what it delivers and its fee, nothing bought.
    expect(txt).toMatch(/- The Bridge \(https:\/\/[^)]+\/bridge-near\), apart from Bridge & Buy: [^\n]*Nothing is bought\.[^\n]*wNEAR[^\n]*0\.25%[^\n]*no trading fee/)
    // The bot only where the build names it; the community and X, NEARKITS' own accounts, always.
    expect(llmsTxt(URL)).not.toContain('t.me/NearKitBot')
    expect(txt).toContain(
      [
        '## Community',
        '- [NEARKITS Community on Telegram](https://t.me/NearKitsCommunity): the official NEARKITS community chat on Telegram (@NearKitsCommunity).',
        '- [NEARKITS on X](https://x.com/Near_Kits): NEARKITS’ official account on X (@Near_Kits).',
      ].join('\n'),
    )
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

describe('llms.txt on the automations, by what the build runs on', () => {
  // The key fact on them (the All Tools page's description names them too, as tools).
  const automation = (txt: string) => txt.split('\n').filter((l) => /^- (In the demo, )?Limit Orders \(/.test(l))

  it('mainnet with NEARKITS’ server: live from NEARKITS wallets after a Telegram sign-in; never from a browser wallet; never "coming soon"', () => {
    const txt = llmsTxt(URL, 'NearKitBot', MAINNET)
    const [line, ...more] = automation(txt)
    expect(more).toEqual([])
    expect(line).toMatch(
      /^- Limit Orders \(limit buy, limit sell, take profit, stop loss\), DCA, Copy Trade and the Sniper are live on NEAR mainnet: NEARKITS’ server runs them from NEARKITS wallets/,
    )
    expect(line).toContain('signed in with Telegram (send /web to @NearKitBot for a one-time sign-in link)')
    expect(line).toContain('A browser wallet you connect can’t run them.')
    expect(line).toContain('https://nearkits.com/docs')
    expect(txt).not.toMatch(/coming soon/i)
    expect(llmsTxt(URL, null, MAINNET)).toContain('send /web to the NEARKITS bot')
  })

  it('testnet with the server: only when the server switches them on; no server: nothing runs here; the demo: simulated', () => {
    expect(automation(llmsTxt(URL, null, { services: 'near', network: 'testnet', server: true }))[0]).toMatch(
      /run on NEARKITS’ server on NEAR testnet when it switches them on, from NEARKITS wallets after a Telegram sign-in; a browser wallet you connect can’t run them/,
    )
    expect(automation(llmsTxt(URL, null, { services: 'near', network: 'mainnet', server: false }))[0]).toMatch(
      /run only on NEARKITS’ server, which this build doesn’t use: nothing runs or executes for them here\.$/,
    )
    expect(automation(llmsTxt(URL, null, { services: 'demo', network: 'mainnet', server: false }))[0]).toMatch(
      /^- In the demo, .* are simulated: rules are saved in standby and nothing runs or executes\.$/,
    )
  })
})
