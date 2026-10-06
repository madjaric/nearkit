// The link-preview image and the app icons, drawn from the NEARKITS mark and type (no other asset):
//   node scripts/brand-images.mjs
// Writes public/og.png (1200×630), public/icon-512.png (the organization's logo) and
// public/apple-touch-icon.png (180×180). Rerun when the mark or the tagline changes.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const ROOT = process.cwd()
// Inline: a page set from a string can't load files from disk.
const font = (pkg, file) => `data:font/woff2;base64,${readFileSync(join(ROOT, 'node_modules', '@fontsource-variable', pkg, 'files', file)).toString('base64')}`
const pw = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
const dir = existsSync(pw)
  ? readdirSync(pw)
      .filter((d) => d.startsWith('chromium-'))
      .sort()
      .pop()
  : null
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? (dir ? join(pw, dir, 'chrome-win64', 'chrome.exe') : undefined) })

const BASE = `
  @font-face { font-family: Archivo; src: url(${font('archivo', 'archivo-latin-wdth-normal.woff2')}) format('woff2'); font-weight: 100 900; font-stretch: 62% 125%; }
  @font-face { font-family: Mono; src: url(${font('jetbrains-mono', 'jetbrains-mono-latin-wght-normal.woff2')}) format('woff2'); font-weight: 100 800; }
  :root { --canvas: oklch(0.145 0.006 250); --panel: oklch(0.18 0.007 250); --line: oklch(0.28 0.009 250); --line-strong: oklch(0.37 0.01 250);
    --fg: oklch(0.965 0.004 250); --fg-2: oklch(0.79 0.006 250); --fg-3: oklch(0.64 0.008 250); --accent: oklch(0.905 0.19 124); }
  * { margin: 0; box-sizing: border-box; }
  html, body { background: var(--canvas); }
`
// The mark (src/components/brand/Brand.tsx): an instrument screen with an accent slash as its trace.
const mark = (size) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 20 20"><rect x="0.5" y="0.5" width="19" height="19" rx="3" fill="oklch(0.18 0.007 250)" stroke="oklch(0.37 0.01 250)"/><path d="M6.2 14.6 13.8 5.4" stroke="oklch(0.905 0.19 124)" stroke-width="2.3" stroke-linecap="square" fill="none"/></svg>`

const OG = `<!doctype html><html><head><style>${BASE}
  body { width: 1200px; height: 630px; position: relative; overflow: hidden; font-family: Archivo; color: var(--fg); }
  .grid { position: absolute; inset: 0; background-image: linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px); background-size: 60px 60px; opacity: .35; }
  .trace { position: absolute; left: 0; right: 0; bottom: 112px; height: 110px; }
  .wrap { position: absolute; inset: 0; padding: 72px 80px; display: flex; flex-direction: column; justify-content: space-between; }
  .brand { display: flex; align-items: center; gap: 22px; }
  .word { font-size: 44px; font-weight: 700; letter-spacing: .07em; font-stretch: 118%; }
  h1 { font-size: 76px; line-height: 1.04; font-weight: 700; font-stretch: 108%; letter-spacing: -.01em; max-width: 960px; }
  .tools { font-family: Mono; font-size: 24px; color: var(--fg-2); letter-spacing: .01em; }
  .tools b { color: var(--accent); font-weight: 400; }
  .url { font-family: Mono; font-size: 24px; color: var(--fg-3); }
  .row { display: flex; justify-content: space-between; align-items: flex-end; }
</style></head><body>
  <div class="grid"></div>
  <svg class="trace" viewBox="0 0 1200 110" preserveAspectRatio="none"><path d="M0 92 L120 86 L220 98 L330 70 L430 80 L540 52 L640 64 L760 38 L860 54 L980 22 L1080 34 L1200 12" stroke="oklch(0.905 0.19 124)" stroke-width="3" fill="none"/></svg>
  <div class="wrap">
    <div class="brand">${mark(64)}<span class="word">NEARKITS</span></div>
    <h1>The trading toolkit for NEAR</h1>
    <div class="row"><div class="tools"><b>/</b> Swap · Multi Trade · Split · Batch Send · Volume Bot</div><div class="url">nearkits.com</div></div>
  </div>
</body></html>`

const ICON = (size) => `<!doctype html><html><head><style>${BASE}
  body { width: ${size}px; height: ${size}px; display: grid; place-items: center; }
</style></head><body>${mark(Math.round(size * 0.8))}</body></html>`

const shoot = async (html, width, height, file) => {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
  await page.setContent(html, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: join(ROOT, 'public', file), type: 'png' })
  await page.close()
  console.log(`public/${file} ${width}×${height}`)
}

await shoot(OG, 1200, 630, 'og.png')
await shoot(ICON(512), 512, 512, 'icon-512.png')
await shoot(ICON(180), 180, 180, 'apple-touch-icon.png')
await browser.close()
