import { FAQ, VOLUME_BOT_DESCRIPTION, VOLUME_BOT_PATH, VOLUME_BOT_TITLE, VOLUME_BOT_UPDATED } from '@/features/volumeBot/content'
import { BRIDGE_FEE_LABEL, NEARKIT_FEE_LABEL } from '@/lib/fees'
import { KIT, KIT_LAUNCH, KITS_CONTRACT } from './kit'
import { BETA_COMING_SOON } from './release'
import { canonicalUrl, SITEMAP_PATHS } from './site'

/**
 * What NEARKITS tells search engines, link previews and AI assistants about each public page:
 * its title, description and structured data. One table feeds the head the app sets as you
 * navigate (RouteMeta), the static HTML the build writes for each page (src/prerender.tsx),
 * sitemap.xml, robots.txt and llms.txt. Each description says what the page itself shows;
 * structured data only describes what is on the page.
 */

export const SITE_NAME = 'NEARKITS'
export const HOME_TITLE = 'NEARKITS — The trading toolkit for NEAR'
export const HOME_DESCRIPTION =
  'NEARKITS is the trading toolkit for NEAR: swap through Rhea, trade from many wallets at once, split and batch-send tokens, run a trading bot and track PnL.'

/** The link-preview image (1200×630, public/og.png) and the square logo (public/icon-512.png). */
export const OG_IMAGE = { path: '/og.png', width: 1200, height: 630, alt: 'NEARKITS, the trading toolkit for NEAR' }
export const LOGO_PATH = '/icon-512.png'

export interface PageSeo {
  path: string
  title: string
  description: string
  /** Its name in a breadcrumb trail and in llms.txt. */
  name: string
  /** What the page states, in plain sentences, for a reader without JavaScript (and llms.txt). */
  facts?: readonly string[]
}

const { tax, taxSplit, poolFee } = KIT_LAUNCH
const taxLine = `a ${tax.buyPct}% buy and sell tax, split ${taxSplit.buybackBurnPct}/${taxSplit.holdersPct} between Buyback & Burn and holder rewards`

/** What the token is (the same on every build: it is one token, on NEAR mainnet). */
export const kitDescription = () => `${KIT.ticker} (${KIT.name}) is the NEARKITS token on NEAR, at ${KITS_CONTRACT}: ${taxLine}.`

/** What $KITS is and its launch configuration, as its page states them: the tax and its split, then, apart from them, the pool fee. */
export const kitFacts = (): string[] => [
  `${KIT.ticker} (${KIT.name}) is the NEARKITS token; its contract on NEAR is ${KITS_CONTRACT}.`,
  `${KIT.ticker} has a ${tax.buyPct}% buy tax and a ${tax.sellPct}% sell tax.`,
  `The tax is split ${taxSplit.buybackBurnPct}% Buyback & Burn and ${taxSplit.holdersPct}% Holder rewards; ${taxSplit.creatorPct}% goes to the creator.`,
  `Separately from the tax, the pool fee is ${poolFee.pct}%, and ${poolFee.nearkitsSharePct}% of the pool fee is allocated to NEARKITS.`,
  `Buyback & Burn is tracked live on NEAR mainnet: the KITS burned, each burn transaction and the supply after burns, read from the chain. Holder rewards are tracked live too: what Nearly’s launchpad has paid to ${KIT.ticker} holders in NEAR and what it holds for them, each payout round verified on chain.`,
  'No return, reward rate, burn amount or buyback frequency is promised.',
]

/** What Bridge & Buy does, as its page states it. */
export const bridgeFacts = (): string[] => [
  `Bridge & Buy brings SOL (Solana), ETH (Ethereum) or BNB (BNB Chain) to NEAR through NEAR Intents and buys ${KIT.ticker} (${KITS_CONTRACT}) with it.`,
  'It runs in two steps: NEAR Intents delivers NEAR to the NEAR wallet you choose, then NEARKITS buys $KITS with that NEAR at the price then, never below the least $KITS you accepted.',
  `Your own wallet sends the funds; NEARKITS never holds them. If the bridge can’t complete, NEAR Intents refunds your address.`,
  `NEARKITS’ fee on the bridge is ${BRIDGE_FEE_LABEL}, with NEAR Intents’ own fee shown beside it; the $KITS purchase carries NEARKITS’ ${NEARKIT_FEE_LABEL} trading fee and $KITS’ own buy tax.`,
]

/** What the Bridge (to NEAR, no purchase) does, as its page states it. */
export const nearBridgeFacts = (): string[] => [
  'The Bridge brings SOL (Solana), ETH (Ethereum) or BNB (BNB Chain) to NEAR through NEAR Intents, to fund a NEARKITS wallet, a connected NEAR wallet or any NEAR account. Nothing is bought.',
  'NEAR Intents delivers NEAR as wNEAR: in a NEARKITS wallet NEARKITS unwraps it to native NEAR, and a connected wallet unwraps it with one signature; an external NEAR account receives the wNEAR.',
  `Your own wallet sends the funds; NEARKITS never holds them. If the bridge can’t complete, NEAR Intents refunds your address.`,
  `NEARKITS’ fee on the bridge is ${BRIDGE_FEE_LABEL}, with NEAR Intents’ own fee shown beside it; there is no trading fee, because nothing is traded.`,
]

/** Every page the sitemap lists, in its order. */
export function publicPages(): PageSeo[] {
  const pages: Record<string, Omit<PageSeo, 'path'>> = {
    '/': { title: HOME_TITLE, description: HOME_DESCRIPTION, name: 'Dashboard' },
    '/swap': {
      title: 'Swap NEAR tokens through Rhea · NEARKITS',
      description: 'Swap NEP-141 tokens on NEAR through Rhea. The route is quoted again right before you sign, and every fee is shown in the review.',
      name: 'Swap',
    },
    '/bridge': {
      title: 'Bridge & Buy $KITS from SOL, ETH or BNB · NEARKITS',
      description: 'Bring SOL, ETH or BNB to NEAR through NEAR Intents and buy $KITS in one flow. Your own wallet sends; every fee is shown before you confirm.',
      name: 'Bridge & Buy',
      facts: bridgeFacts(),
    },
    '/bridge-near': {
      title: 'Bridge SOL, ETH or BNB to NEAR · NEARKITS',
      description: 'Move SOL, ETH or BNB into NEAR through NEAR Intents, to fund a NEARKITS wallet or any NEAR account. Your own wallet sends; every fee is shown first.',
      name: 'Bridge',
      facts: nearBridgeFacts(),
    },
    '/multi-trade': {
      title: 'Multi Trade: buy or sell from many NEAR wallets · NEARKITS',
      description: 'One order across many NEAR wallets: pick a preset or wallets, split the total equally or by hand, and review every leg before it runs.',
      name: 'Multi Trade',
    },
    '/split': {
      title: 'Split tokens across NEAR wallets · NEARKITS',
      description: 'Distribute NEAR or a token from one wallet across many, in equal shares or by custom percentage, and review every transfer before it is sent.',
      name: 'Split',
    },
    '/consolidate': {
      title: 'Consolidate tokens into one NEAR wallet · NEARKITS',
      description: 'Gather a token from many NEAR wallets back into one, the reverse of Split, and review every transfer before it is sent.',
      name: 'Consolidate',
    },
    '/batch-send': {
      title: 'Batch Send NEAR and tokens to many recipients · NEARKITS',
      description: 'Send NEAR or one token to many recipients from a single list. Every line is checked before anything is sent.',
      name: 'Batch Send',
    },
    '/scanner': {
      title: 'NEAR token scanner: contract risk indicators · NEARKITS',
      description: 'Contract facts and risk indicators for any NEAR token, read from chain and public indexers, each with its source. Indicators, never verdicts.',
      name: 'Scanner',
    },
    [VOLUME_BOT_PATH]: { title: VOLUME_BOT_TITLE, description: VOLUME_BOT_DESCRIPTION, name: 'Volume Bot' },
    '/kit': { title: `${KIT.ticker} (${KIT.name}), the NEARKITS token · NEARKITS`, description: kitDescription(), name: KIT.ticker, facts: kitFacts() },
    '/telegram': {
      title: 'Telegram bot for NEAR trading · NEARKITS',
      description: 'Trade NEAR tokens in Telegram: NEARKITS wallets buy and sell in the chat, signed by NEARKITS; a NEAR account you link signs its trades in your own wallet.',
      name: 'Telegram',
    },
    '/docs': {
      title: 'Documentation: fees, wallets and tools · NEARKITS',
      description: 'How NEARKITS works, what runs for real and what doesn’t yet, and the terms used across the app.',
      name: 'Documentation',
    },
  }
  return SITEMAP_PATHS.map((path) => {
    const page = pages[path]
    if (!page) throw new Error(`No SEO entry for sitemap page ${path}`)
    return { path, ...page }
  })
}

/** Pages that are personal, a tool's inside, or not shipped yet: never indexed (also sent as X-Robots-Tag, vercel.json). */
export const PRIVATE_PATHS: readonly string[] = ['/wallets', '/positions', '/pnl', '/settings', '/recover', '/tg', '/volume-bot/console']

export function isNoindexPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '') || '/'
  return PRIVATE_PATHS.includes(path) || BETA_COMING_SOON.includes(path)
}

export function pageSeo(pathname: string): PageSeo | null {
  const path = pathname.replace(/\/+$/, '') || '/'
  return publicPages().find((p) => p.path === path) ?? null
}

// ─── structured data ────────────────────────────────────────────────────────

type Json = Record<string, unknown>

const orgId = (u: string) => `${u}/#organization`

/** The organization and the site, on every page. */
export function siteGraph(publicUrl: string, telegramBot: string | null): Json[] {
  return [
    {
      '@type': 'Organization',
      '@id': orgId(publicUrl),
      name: SITE_NAME,
      url: `${publicUrl}/`,
      logo: `${publicUrl}${LOGO_PATH}`,
      description: HOME_DESCRIPTION,
      ...(telegramBot ? { sameAs: [`https://t.me/${telegramBot}`] } : {}),
    },
    { '@type': 'WebSite', '@id': `${publicUrl}/#website`, name: SITE_NAME, url: `${publicUrl}/`, publisher: { '@id': orgId(publicUrl) } },
  ]
}

/** The page itself: written and published by NEARKITS, part of the site; with its date where the page shows one. */
function webPage(publicUrl: string, path: string, links: Json = {}): Json {
  const page = pageSeo(path)
  return {
    '@type': 'WebPage',
    '@id': `${canonicalUrl(publicUrl, path)}#webpage`,
    url: canonicalUrl(publicUrl, path),
    name: page?.title ?? HOME_TITLE,
    description: page?.description ?? HOME_DESCRIPTION,
    isPartOf: { '@id': `${publicUrl}/#website` },
    author: { '@id': orgId(publicUrl) },
    publisher: { '@id': orgId(publicUrl) },
    ...(path === VOLUME_BOT_PATH ? { dateModified: VOLUME_BOT_UPDATED } : {}),
    ...links,
  }
}

/** What describes this page itself (beyond the site): the page, the app on the home page, the Volume Bot with its breadcrumb and FAQ. */
export function pageGraph(publicUrl: string, path: string): Json[] {
  // Each node has its own @id, and the page names what it is about: one graph, no orphans.
  if (path === '/')
    return [
      webPage(publicUrl, path, { mainEntity: { '@id': `${publicUrl}/#app` } }),
      {
        '@type': 'SoftwareApplication',
        '@id': `${publicUrl}/#app`,
        name: SITE_NAME,
        url: `${publicUrl}/`,
        applicationCategory: 'FinanceApplication',
        operatingSystem: 'Web',
        description: HOME_DESCRIPTION,
        publisher: { '@id': orgId(publicUrl) },
      },
    ]
  if (path === VOLUME_BOT_PATH) {
    const url = canonicalUrl(publicUrl, path)
    return [
      webPage(publicUrl, path, { mainEntity: { '@id': `${url}#app` }, breadcrumb: { '@id': `${url}#breadcrumb` } }),
      {
        '@type': 'SoftwareApplication',
        '@id': `${url}#app`,
        name: 'NEARKITS Volume Bot',
        url: canonicalUrl(publicUrl, path),
        applicationCategory: 'FinanceApplication',
        operatingSystem: 'Web',
        description: VOLUME_BOT_DESCRIPTION,
        publisher: { '@id': orgId(publicUrl) },
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${url}#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: SITE_NAME, item: `${publicUrl}/` },
          { '@type': 'ListItem', position: 2, name: 'Volume Bot', item: canonicalUrl(publicUrl, path) },
        ],
      },
      {
        '@type': 'FAQPage',
        '@id': `${url}#faq`,
        isPartOf: { '@id': `${url}#webpage` },
        mainEntity: FAQ.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
      },
    ]
  }
  return pageSeo(path) ? [webPage(publicUrl, path)] : []
}

/** JSON for a <script type="application/ld+json">: "<" escaped, so no text in it can end the script. */
export function jsonLdText(graph: Json[]): string {
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c')
}

// ─── the head of a page ─────────────────────────────────────────────────────

export interface HeadTags {
  title: string
  description: string
  canonical: string | null
  robots: string | null
  ogTitle: string
  image: string
}

export function headTags(publicUrl: string, pathname: string): HeadTags {
  const page = pageSeo(pathname)
  const noindex = isNoindexPath(pathname)
  return {
    title: page?.title ?? HOME_TITLE,
    description: page?.description ?? HOME_DESCRIPTION,
    canonical: page ? canonicalUrl(publicUrl, page.path) : null,
    robots: noindex ? 'noindex' : null,
    ogTitle: page?.path === '/' ? HOME_TITLE : (page?.title.replace(/ · NEARKITS$/, '') ?? HOME_TITLE),
    image: `${publicUrl}${OG_IMAGE.path}`,
  }
}

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const text = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The SEO part of a page's <head> as static HTML: what the build writes into each page. */
export function headHtml(publicUrl: string, pathname: string, telegramBot: string | null, extra: { robots?: string; title?: string } = {}): string {
  const h = headTags(publicUrl, pathname)
  const title = extra.title ?? h.title
  const robots = extra.robots ?? h.robots
  const page = pageSeo(pathname)
  const graph = [...siteGraph(publicUrl, telegramBot), ...(page ? pageGraph(publicUrl, page.path) : [])]
  return [
    `<title>${text(title)}</title>`,
    `<meta name="description" content="${attr(h.description)}" />`,
    ...(robots ? [`<meta name="robots" content="${attr(robots)}" />`] : []),
    ...(h.canonical ? [`<link rel="canonical" href="${attr(h.canonical)}" />`] : []),
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:title" content="${attr(h.ogTitle)}" />`,
    `<meta property="og:description" content="${attr(h.description)}" />`,
    ...(h.canonical ? [`<meta property="og:url" content="${attr(h.canonical)}" />`] : []),
    `<meta property="og:image" content="${attr(h.image)}" />`,
    `<meta property="og:image:width" content="${OG_IMAGE.width}" />`,
    `<meta property="og:image:height" content="${OG_IMAGE.height}" />`,
    `<meta property="og:image:alt" content="${attr(OG_IMAGE.alt)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${attr(h.ogTitle)}" />`,
    `<meta name="twitter:description" content="${attr(h.description)}" />`,
    `<meta name="twitter:image" content="${attr(h.image)}" />`,
    `<script type="application/ld+json">${jsonLdText(graph)}</script>`,
  ].join('\n    ')
}

// ─── crawler files ──────────────────────────────────────────────────────────

/** AI crawlers named on their own, so the policy reads explicitly: they are welcome (the owner's default). */
export const AI_CRAWLERS: readonly string[] = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-SearchBot',
  'Claude-User',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'Applebot-Extended',
]

export function robotsTxt(publicUrl: string): string {
  return ['User-agent: *', 'Allow: /', '', ...AI_CRAWLERS.map((a) => `User-agent: ${a}`), 'Allow: /', '', `Sitemap: ${publicUrl}/sitemap.xml`, ''].join('\n')
}

/** llms.txt: what NEARKITS is and its public pages, for AI assistants (llmstxt.org). */
/** The features COMING SOON in this build, by name (llms.txt states them plainly). */
const COMING_SOON_NAMES: Record<string, string> = {
  '/limit-orders': 'limit orders (take-profit, stop-loss)',
  '/dca': 'DCA',
  '/copy-trade': 'copy trading',
  '/sniper': 'the sniper',
}

export function llmsTxt(publicUrl: string, telegramBot: string | null = null): string {
  const pages = publicPages()
  const line = (p: PageSeo) => `- [${p.name}](${canonicalUrl(publicUrl, p.path)}): ${p.description}`
  const apart = new Set(['/', VOLUME_BOT_PATH, '/docs', '/telegram', '/kit'])
  const tools = pages.filter((p) => !apart.has(p.path))
  const of = (path: string) => pages.filter((p) => p.path === path).map(line)
  const soon = BETA_COMING_SOON.map((p) => COMING_SOON_NAMES[p]).filter((x): x is string => Boolean(x))
  return [
    `# ${SITE_NAME}`,
    '',
    `> ${HOME_DESCRIPTION}`,
    '',
    `${SITE_NAME} is a web app at ${publicUrl}/${telegramBot ? ` with a Telegram bot, [@${telegramBot}](https://t.me/${telegramBot})` : ' with a Telegram bot'}. It trades on NEAR through Rhea, from wallets you connect (you sign) or from NEARKITS wallets (NEARKITS signs). On mainnet each swap carries the ${NEARKIT_FEE_LABEL} NEARKITS fee, shown in its review; Split, Consolidate and Batch Send carry none.`,
    '',
    '## Tools',
    ...tools.map(line),
    '',
    '## Automated trading',
    ...of(VOLUME_BOT_PATH),
    '',
    '## Telegram and the token',
    ...of('/telegram'),
    ...of('/kit'),
    '',
    '## Documentation',
    ...of('/docs'),
    '',
    '## Key facts',
    '- NEARKITS wallets are custodial: NEARKITS holds their keys, in a separate signer that keeps each key encrypted under a key held in OpenBao, and signs their trades. Wallets you connect sign every transaction themselves.',
    '- A NEARKITS wallet withdraws only to its owner wallet, to the same user’s other NEARKITS wallets, or to an address approved once: by the owner wallet’s signature, or in NEARKITS’ Telegram Mini App for a wallet with no owner wallet. Linking an owner wallet is optional.',
    '- Whoever controls a user’s Telegram account or a signed-in NEARKITS web session can trade that user’s NEARKITS wallets, but not withdraw to an address that wasn’t approved.',
    '- Trading can lose money: prices move, pools can lose liquidity, and fees and gas apply to every trade. NEARKITS promises no profit, volume, liquidity or returns.',
    `- ${kitDescription()}`,
    `- ${KIT.ticker} tokenomics, from its launch configuration on ${KIT.launchVenue}: ${kitFacts().join(' ')}`,
    `- The Bridge (${publicUrl}/bridge-near), apart from Bridge & Buy: ${nearBridgeFacts().join(' ')}`,
    ...(soon.length ? [`- Coming soon (nothing runs or executes for them yet): ${soon.join(', ')}.`] : []),
    '',
  ].join('\n')
}
