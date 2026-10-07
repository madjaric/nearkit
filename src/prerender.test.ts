import { describe, expect, it } from 'vitest'
import { publicPages } from '@/config/seo'
import { FAQ } from '@/features/volumeBot/content'
import { fileOf, siteFiles } from './prerender'

/** The static files the build writes: each public page's own head, the Volume Bot page's whole body, the shell, the 404 page. */

const TEMPLATE = [
  '<!doctype html>',
  '<html lang="en">',
  '  <head>',
  '    <meta charset="UTF-8" />',
  '    <!-- seo -->',
  '    <title>Generic</title>',
  '    <!-- /seo -->',
  '    <script type="module" src="/assets/index.js"></script>',
  '  </head>',
  '  <body>',
  '    <div id="root"></div>',
  '  </body>',
  '</html>',
].join('\n')

const files = siteFiles(TEMPLATE, 'https://nearkits.com')

describe('the prerendered site', () => {
  it('writes every public page with its own title and canonical address, the shell, 404.html and the crawler files', () => {
    for (const p of publicPages()) {
      const html = files[fileOf(p.path)] ?? ''
      expect(html, p.path).toContain(`<link rel="canonical" href="https://nearkits.com${p.path === '/' ? '/' : p.path}" />`)
      expect(html).not.toContain('<title>Generic</title>')
      expect(html.match(/<title>/g)).toHaveLength(1)
      if (p.path !== '/volume-bot') expect(html).toContain('<script type="module" src="/assets/index.js"></script>')
    }
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['index.html', 'app.html', '404.html', 'robots.txt', 'sitemap.xml', 'llms.txt']))
  })

  it('the Volume Bot page carries its whole body: the H1, every section and the FAQ, readable without JavaScript', () => {
    const html = files['volume-bot.html'] ?? ''
    const body = html.slice(html.indexOf('<div id="root">'))
    expect(body).toContain('NEARKITS Volume Bot — Automated Trading on NEAR</h1>')
    expect(body.match(/<h1/g)).toHaveLength(1)
    for (const f of FAQ) expect(body).toContain(f.q)
    expect(body).toContain('href="/volume-bot/console"')
    expect(html).toContain('"@type":"FAQPage"')
    expect(html).not.toContain('<noscript>')
    // Complete as HTML: no script loads, the stylesheet and fonts do.
    expect(html).not.toContain('<script type="module"')
    expect(html).toContain('<meta charset="UTF-8" />')
    expect(files['swap.html']).toContain('<script type="module" src="/assets/index.js"></script>')
    // Every other page stays the app's to render.
    expect(files['swap.html']).toContain('<div id="root"></div>')
  })

  it('an app page tells a reader without JavaScript what it is, and links every other public page', () => {
    const html = files['swap.html'] ?? ''
    const noscript = html.slice(html.indexOf('<noscript>'), html.indexOf('</noscript>'))
    expect(noscript).toContain('<h1 class="text-2xl font-bold">Swap NEAR tokens through Rhea</h1>')
    for (const p of publicPages().filter((x) => x.path !== '/swap')) expect(noscript).toContain(`href="${p.path}"`)
    expect(files['index.html']).toContain('NEARKITS — The trading toolkit for NEAR</h1>')
  })

  it('the $KITS page tells a reader without JavaScript what the token is, its tax, the split and, apart from them, the pool fee', () => {
    const html = files['kit.html'] ?? ''
    const noscript = html.slice(html.indexOf('<noscript>'), html.indexOf('</noscript>'))
    expect(noscript).toContain('$KITS (Near Kits) is the NEARKITS token; its contract on NEAR is kits.nearlytrade.near.')
    expect(noscript).toContain('$KITS has a 2% buy tax and a 2% sell tax.')
    expect(html).toContain('<title>$KITS (Near Kits), the NEARKITS token · NEARKITS</title>')
    expect(noscript).toContain('The tax is split 50% to Buyback &amp; Burn and 50% to holder rewards; 0% goes to the creator.')
    expect(noscript).toContain('Separately from the tax, the pool fee is 1%, and 70% of the pool fee is allocated to NEARKITS.')
    expect(files['swap.html']).not.toContain('pool fee')
  })

  it('each app page reads as its own: the other pages are listed by name, never with their descriptions', () => {
    const html = files['swap.html'] ?? ''
    const noscript = html.slice(html.indexOf('<noscript>'), html.indexOf('</noscript>'))
    for (const p of publicPages().filter((x) => x.path !== '/swap')) expect(noscript, p.path).not.toContain(p.description)
  })

  it('the shell names no canonical address and is not indexed alone; the 404 page is never indexed', () => {
    expect(files['app.html']).not.toContain('rel="canonical"')
    expect(files['404.html']).toContain('<meta name="robots" content="noindex" />')
    expect(files['404.html']).toContain('<title>Page not found · NEARKITS</title>')
    // Without JavaScript it still says so, and where to go.
    const html = files['404.html'] ?? ''
    const noscript = html.slice(html.indexOf('<noscript>'), html.indexOf('</noscript>'))
    expect(noscript).toContain('Page not found')
    for (const p of publicPages()) expect(noscript).toContain(`href="${p.path}"`)
  })

  it('refuses a template without its seo block or empty root', () => {
    expect(() => siteFiles('<html><div id="root"></div></html>', 'https://nearkits.com')).toThrow(/seo/)
  })
})
