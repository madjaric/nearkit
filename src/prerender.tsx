/* eslint-disable react-refresh/only-export-components -- rendered at build time only, never hot-reloaded */
import { renderToStaticMarkup, renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { ENV } from '@/config/env'
import { headHtml, HOME_TITLE, llmsTxt, publicPages, robotsTxt, type PageSeo } from '@/config/seo'
import { sitemapXml } from '@/config/site'
import { VOLUME_BOT_PATH } from '@/features/volumeBot/content'
import VolumeBotPage from '@/pages/VolumeBotPage'

/**
 * The static files of a build, written next to the app by vite.config.ts (prerenderSite): each
 * public page's HTML with its own head (title, description, canonical, link preview, structured
 * data), the app's shell for every other route, the 404 page, and the crawler files.
 *
 * The Volume Bot page also carries its whole body, rendered from the same component the app
 * shows (it uses no wallet or service), so a crawler that runs no JavaScript reads all of it, and
 * a visitor gets it without loading the app.
 */

const SEO_BLOCK = /<!-- seo -->[\s\S]*?<!-- \/seo -->/
const ROOT = '<div id="root"></div>'

/** The file a public page is served from (vercel.json rewrites each path to it). */
export const fileOf = (path: string) => (path === '/' ? 'index.html' : `${path.slice(1)}.html`)

/**
 * What a visitor without JavaScript (and a crawler that runs none) reads on an app page: its
 * heading, what it does, and every other public page by name (their descriptions are their own
 * pages': listed here too, every page would read alike). With JavaScript it is never shown; the
 * app renders the page itself.
 */
function NoScript({ page, pages }: { page: PageSeo; pages: PageSeo[] }) {
  const heading = page.path === '/' ? HOME_TITLE : page.title.replace(/ · NEARKITS$/, '')
  return (
    <main className="mx-auto max-w-3xl px-4 py-10 text-fg">
      <h1 className="text-2xl font-bold">{heading}</h1>
      <p className="mt-3 text-fg-2">{page.description}</p>
      {page.facts && (
        <ul className="mt-3 flex list-disc flex-col gap-1 pl-5 text-fg-2">
          {page.facts.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-fg-3">NEARKITS runs in your browser: turn on JavaScript to use it.</p>
      <nav aria-label="NEARKITS" className="mt-8">
        <ul className="flex flex-col gap-3">
          {pages
            .filter((p) => p.path !== page.path)
            .map((p) => (
              <li key={p.path}>
                <a href={p.path} className="text-fg underline">
                  {p.name}
                </a>
              </li>
            ))}
        </ul>
      </nav>
    </main>
  )
}

export function siteFiles(template: string, publicUrl: string): Record<string, string> {
  if (!SEO_BLOCK.test(template)) throw new Error('index.html has no <!-- seo --> … <!-- /seo --> block')
  if (!template.includes(ROOT)) throw new Error(`index.html has no empty ${ROOT}`)
  const page = (head: string, body?: { root?: string; noscript?: string }) => {
    const html = template.replace(SEO_BLOCK, () => `<!-- seo -->\n    ${head}\n    <!-- /seo -->`)
    const root = body?.root === undefined ? ROOT : `<div id="root">${body.root}</div>`
    return html.replace(ROOT, () => (body?.noscript ? `<noscript>${body.noscript}</noscript>\n    ${root}` : root))
  }
  const bot = ENV.telegramBot
  const pages = publicPages()
  const files: Record<string, string> = {}
  for (const p of pages) {
    const body =
      p.path === VOLUME_BOT_PATH
        ? {
            root: renderToString(
              <MemoryRouter initialEntries={[p.path]}>
                <VolumeBotPage />
              </MemoryRouter>,
            ),
          }
        : { noscript: renderToStaticMarkup(<NoScript page={p} pages={pages} />) }
    const html = page(headHtml(publicUrl, p.path, bot), body)
    // A page whose whole body is here is complete as HTML: its links are plain links, so it loads no
    // script at all. (The app would only render the same markup again, which the browser counts as a
    // second, later paint.) Opened from inside the app, the app renders it like any page.
    files[fileOf(p.path)] = body.root === undefined ? html : html.replace(/\s*<script type="module"[^>]*><\/script>/g, '').replace(/\s*<link rel="modulepreload"[^>]*>/g, '')
  }
  // Every other route of the app (a token, the tools' insides): the site's head and no canonical, which the app sets as it renders.
  files['app.html'] = page(headHtml(publicUrl, '/app', bot))
  const notFound: PageSeo = {
    path: '/404',
    name: 'Not found',
    title: 'Page not found · NEARKITS',
    description: 'There is no page at this address. These are the pages NEARKITS has.',
  }
  files['404.html'] = page(headHtml(publicUrl, '/404', bot, { robots: 'noindex', title: notFound.title }), {
    noscript: renderToStaticMarkup(<NoScript page={notFound} pages={pages} />),
  })
  files['robots.txt'] = robotsTxt(publicUrl)
  files['sitemap.xml'] = sitemapXml(publicUrl)
  files['llms.txt'] = llmsTxt(publicUrl, bot)
  return files
}
