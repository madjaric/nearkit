import { FAQ, VOLUME_BOT_DESCRIPTION, VOLUME_BOT_PATH, VOLUME_BOT_TITLE, VOLUME_BOT_UPDATED } from '@/features/volumeBot/content'
import { NEARKIT_FEE_LABEL } from '@/lib/fees'
import { KIT } from './kit'
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
  'NEARKITS is the trading toolkit for NEAR: swap tokens through Rhea, trade from many wallets at once, split and batch-send tokens, run a trading bot and track PnL.'

/** The link-preview image (1200×630, public/og.png) and the square logo (public/icon-512.png). */
export const OG_IMAGE = { path: '/og.png', width: 1200, height: 630, alt: 'NEARKITS, the trading toolkit for NEAR' }
export const LOGO_PATH = '/icon-512.png'

export interface PageSeo {
  path: string
  title: string
  description: string
  /** Its name in a breadcrumb trail and in llms.txt. */
  name: string
}

const kitDescription = () =>
  KIT.status === 'live'
    ? `${KIT.ticker} is the token of NEARKITS, live on NEAR: its contract, where it trades and how to buy it.`
    : `${KIT.ticker} is the token of NEARKITS. It has not launched: no contract, price or supply is published until it does.`

/** Every page the sitemap lists, in its order. */
export function publicPages(): PageSeo[] {
  const pages: Record<string, Omit<PageSeo, 'path'>> = {
    '/': { title: HOME_TITLE, description: HOME_DESCRIPTION, name: 'Dashboard' },
    '/swap': {
      title: 'Swap NEAR tokens through Rhea · NEARKITS',
      description: 'Swap any NEP-141 token on NEAR through Rhea. The route is quoted again right before you sign, and every fee is shown in the review.',
      name: 'Swap',
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
      title: 'NEAR token scanner: contract facts and risk indicators · NEARKITS',
      description: 'Contract facts and risk indicators for any NEAR token, read from chain and public indexers, each with its source. Indicators, never verdicts.',
      name: 'Scanner',
    },
    [VOLUME_BOT_PATH]: { title: VOLUME_BOT_TITLE, description: VOLUME_BOT_DESCRIPTION, name: 'Volume Bot' },
    '/kit': { title: `${KIT.ticker}, the NEARKITS token · NEARKITS`, description: kitDescription(), name: KIT.ticker },
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
function webPage(publicUrl: string, path: string): Json {
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
  }
}

/** What describes this page itself (beyond the site): the page, the app on the home page, the Volume Bot with its breadcrumb and FAQ. */
export function pageGraph(publicUrl: string, path: string): Json[] {
  if (path === '/')
    return [
      webPage(publicUrl, path),
      {
        '@type': 'SoftwareApplication',
        name: SITE_NAME,
        url: `${publicUrl}/`,
        applicationCategory: 'FinanceApplication',
        operatingSystem: 'Web',
        description: HOME_DESCRIPTION,
        publisher: { '@id': orgId(publicUrl) },
      },
    ]
  if (path === VOLUME_BOT_PATH)
    return [
      webPage(publicUrl, path),
      {
        '@type': 'SoftwareApplication',
        name: 'NEARKITS Volume Bot',
        url: canonicalUrl(publicUrl, path),
        applicationCategory: 'FinanceApplication',
        operatingSystem: 'Web',
        description: VOLUME_BOT_DESCRIPTION,
        publisher: { '@id': orgId(publicUrl) },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: SITE_NAME, item: `${publicUrl}/` },
          { '@type': 'ListItem', position: 2, name: 'Volume Bot', item: canonicalUrl(publicUrl, path) },
        ],
      },
      {
        '@type': 'FAQPage',
        mainEntity: FAQ.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
      },
    ]
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
export function llmsTxt(publicUrl: string): string {
  const pages = publicPages()
  const line = (p: PageSeo) => `- [${p.name}](${canonicalUrl(publicUrl, p.path)}): ${p.description}`
  const tools = pages.filter((p) => p.path !== '/' && p.path !== VOLUME_BOT_PATH && p.path !== '/docs')
  const bot = pages.find((p) => p.path === VOLUME_BOT_PATH)
  const docs = pages.find((p) => p.path === '/docs')
  return [
    `# ${SITE_NAME}`,
    '',
    `> ${HOME_DESCRIPTION}`,
    '',
    `${SITE_NAME} is a web app at ${publicUrl}/ with a Telegram bot. It trades on NEAR through Rhea, from wallets you connect (you sign) or from NEARKITS wallets (NEARKITS executes). On mainnet each swap carries the ${NEARKIT_FEE_LABEL} NEARKITS fee, shown in its review.`,
    '',
    '## Tools',
    ...tools.map(line),
    '',
    '## Automated trading',
    ...(bot ? [line(bot)] : []),
    '',
    '## Documentation',
    ...(docs ? [line(docs)] : []),
    '',
  ].join('\n')
}
