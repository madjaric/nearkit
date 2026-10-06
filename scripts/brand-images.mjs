// NEARKITS brand assets, made from the official logo (brand/nearkits-logo.jpg: the mark and the
// NEAR/KITS wordmark on black). Rerun when the logo changes:
//   node scripts/brand-images.mjs
// The mark is drawn as vector, measured from the official file (the same shape as LogoMark in
// src/components/brand/Brand.tsx), so every size is sharp. The wordmark is the official artwork
// itself, its black made transparent. Writes:
//   public/brand/nearkits-wordmark-{240,480,853}.png   the wordmark (Brand.tsx)
//   public/brand/nearkits-logo.png                      the whole logo on transparent (PnL cards)
//   public/favicon.svg, public/favicon-48.png, public/apple-touch-icon.png,
//   public/icon-192.png, public/icon-512.png, public/icon-maskable-512.png   (index.html, the manifest)
//   public/og.png                                       link previews
//   brand/telegram-avatar.png                           the bot's profile photo (set in BotFather)
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const ROOT = process.cwd()
const SOURCE = join(ROOT, 'brand', 'nearkits-logo.jpg')
// Where the wordmark sits in the official file (1 px margin around its letters).
const WORDMARK = { x: 294, y: 566, w: 853, h: 96 }
// The mark's box in the official file: the whole logo is mark + gap + wordmark, centred on one line.
const MARK = { x: 113, y: 541, size: 145 }
const WORDMARK_WIDTHS = [240, 480, 853]

/** The mark, in the official file's own pixels (145 × 145): its ring, its screen and its slash. */
const MARK_SVG = (size) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 145 145">` +
  `<rect x="2.75" y="2.75" width="139.5" height="139.5" rx="21.25" fill="#0b0c0b" stroke="#5a6166" stroke-width="5.5"/>` +
  `<path d="M32.04 106.22 L100.04 26.88 L114.16 38.98 L46.16 118.32 Z" fill="#b6fa39"/></svg>`

const pw = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
const dir = existsSync(pw)
  ? readdirSync(pw)
      .filter((d) => d.startsWith('chromium-'))
      .sort()
      .pop()
  : null
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? (dir ? join(pw, dir, 'chrome-win64', 'chrome.exe') : undefined) })
const page = await browser.newPage()
const save = (file, dataUrl) => {
  writeFileSync(join(ROOT, file), Buffer.from(dataUrl.split(',')[1], 'base64'))
  console.log(file)
}

// ─── the wordmark, and the whole logo, from the official artwork ────────────
const source = `data:image/jpeg;base64,${readFileSync(SOURCE).toString('base64')}`
const markSvg = `data:image/svg+xml;base64,${Buffer.from(MARK_SVG(MARK.size)).toString('base64')}`
const made = await page.evaluate(
  async ({ source, markSvg, crop, mark, widths }) => {
    const load = async (src) => {
      const img = new Image()
      img.src = src
      await img.decode()
      return img
    }
    const art = await load(source)
    // The wordmark: its black becomes transparent (alpha from the brightest channel), and each pixel takes
    // the nearer of the logo's two exact colours, so the JPEG's colour noise is gone and edges stay smooth.
    const COLOURS = [
      [252, 252, 252],
      [182, 250, 57],
    ]
    const word = document.createElement('canvas')
    word.width = crop.w
    word.height = crop.h
    const wctx = word.getContext('2d')
    wctx.drawImage(art, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h)
    const data = wctx.getImageData(0, 0, crop.w, crop.h)
    const p = data.data
    for (let i = 0; i < p.length; i += 4) {
      const a = Math.min(1, Math.max(0, (Math.max(p[i], p[i + 1], p[i + 2]) - 14) / (244 - 14)))
      if (a === 0) {
        p[i + 3] = 0
        continue
      }
      const r = p[i] / a
      const g = p[i + 1] / a
      const b = p[i + 2] / a
      const near = COLOURS.reduce((best, c) => ((c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2 < (best[0] - r) ** 2 + (best[1] - g) ** 2 + (best[2] - b) ** 2 ? c : best))
      p[i] = near[0]
      p[i + 1] = near[1]
      p[i + 2] = near[2]
      p[i + 3] = Math.round(a * 255)
    }
    wctx.putImageData(data, 0, 0)
    const sized = {}
    for (const w of widths) {
      const c = document.createElement('canvas')
      c.width = w
      c.height = Math.round((crop.h * w) / crop.w)
      const ctx = c.getContext('2d')
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(word, 0, 0, c.width, c.height)
      sized[w] = c.toDataURL('image/png')
    }
    // The whole logo: the vector mark and the wordmark where the official file places them.
    const logo = document.createElement('canvas')
    logo.width = crop.x + crop.w - mark.x
    logo.height = mark.size
    const lctx = logo.getContext('2d')
    lctx.drawImage(await load(markSvg), 0, 0, mark.size, mark.size)
    lctx.drawImage(word, crop.x - mark.x, crop.y - mark.y)
    return { sized, logo: logo.toDataURL('image/png') }
  },
  { source, markSvg, crop: WORDMARK, mark: MARK, widths: WORDMARK_WIDTHS },
)
mkdirSync(join(ROOT, 'public', 'brand'), { recursive: true })
for (const w of WORDMARK_WIDTHS) save(`public/brand/nearkits-wordmark-${w}.png`, made.sized[w])
save('public/brand/nearkits-logo.png', made.logo)
writeFileSync(join(ROOT, 'public', 'favicon.svg'), MARK_SVG(145).replace(' width="145" height="145"', '') + '\n')
console.log('public/favicon.svg')

// ─── icons: the mark alone ──────────────────────────────────────────────────
/** The mark at `share` of a `size` square, on black (`opaque`) or on nothing. */
const shoot = async (file, size, share, opaque) => {
  const p = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
  await p.setContent(
    `<!doctype html><html><body style="margin:0;width:${size}px;height:${size}px;display:grid;place-items:center;background:${opaque ? '#000' : 'transparent'}">${MARK_SVG(Math.round(size * share))}</body></html>`,
  )
  await p.screenshot({ path: join(ROOT, file), type: 'png', omitBackground: !opaque })
  await p.close()
  console.log(file)
}
await shoot('public/favicon-48.png', 48, 1, false)
await shoot('public/icon-192.png', 192, 0.96, false)
await shoot('public/icon-512.png', 512, 0.96, false)
// Home screens and launchers draw on their own: an opaque square, the mark inside the safe zone.
await shoot('public/apple-touch-icon.png', 180, 0.78, true)
await shoot('public/icon-maskable-512.png', 512, 0.6, true)
await shoot('brand/telegram-avatar.png', 640, 0.6, true)

// ─── the link preview ───────────────────────────────────────────────────────
const font = (pkg, file) => `data:font/woff2;base64,${readFileSync(join(ROOT, 'node_modules', '@fontsource-variable', pkg, 'files', file)).toString('base64')}`
const wordmark = `data:image/png;base64,${readFileSync(join(ROOT, 'public', 'brand', 'nearkits-wordmark-853.png')).toString('base64')}`
const OG = `<!doctype html><html><head><style>
  @font-face { font-family: Archivo; src: url(${font('archivo', 'archivo-latin-wdth-normal.woff2')}) format('woff2'); font-weight: 100 900; font-stretch: 62% 125%; }
  @font-face { font-family: Mono; src: url(${font('jetbrains-mono', 'jetbrains-mono-latin-wght-normal.woff2')}) format('woff2'); font-weight: 100 800; }
  :root { --line: oklch(0.28 0.009 250); --fg: oklch(0.965 0.004 250); --fg-2: oklch(0.79 0.006 250); --fg-3: oklch(0.64 0.008 250); --lime: #b6fa39; }
  * { margin: 0; box-sizing: border-box; }
  body { width: 1200px; height: 630px; position: relative; overflow: hidden; background: oklch(0.145 0.006 250); font-family: Archivo; color: var(--fg); }
  .grid { position: absolute; inset: 0; background-image: linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px); background-size: 60px 60px; opacity: .35; }
  .trace { position: absolute; left: 0; right: 0; bottom: 112px; height: 110px; }
  .wrap { position: absolute; inset: 0; padding: 72px 80px; display: flex; flex-direction: column; justify-content: space-between; }
  .brand { display: flex; align-items: center; gap: 19px; }
  h1 { font-size: 76px; line-height: 1.04; font-weight: 700; font-stretch: 108%; letter-spacing: -.01em; max-width: 960px; }
  .tools { font-family: Mono; font-size: 24px; color: var(--fg-2); letter-spacing: .01em; }
  .tools b { color: var(--lime); font-weight: 400; }
  .url { font-family: Mono; font-size: 24px; color: var(--fg-3); }
  .row { display: flex; justify-content: space-between; align-items: flex-end; }
</style></head><body>
  <div class="grid"></div>
  <svg class="trace" viewBox="0 0 1200 110" preserveAspectRatio="none"><path d="M0 92 L120 86 L220 98 L330 70 L430 80 L540 52 L640 64 L760 38 L860 54 L980 22 L1080 34 L1200 12" stroke="#b6fa39" stroke-width="3" fill="none"/></svg>
  <div class="wrap">
    <div class="brand">${MARK_SVG(72)}<img src="${wordmark}" height="47" alt="NEARKITS"></div>
    <h1>The trading toolkit for NEAR</h1>
    <div class="row"><div class="tools"><b>/</b> Swap · Multi Trade · Split · Batch Send · Volume Bot</div><div class="url">nearkits.com</div></div>
  </div>
</body></html>`
const og = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
await og.setContent(OG, { waitUntil: 'load' })
await og.evaluate(() => document.fonts.ready)
await og.screenshot({ path: join(ROOT, 'public', 'og.png'), type: 'png' })
console.log('public/og.png')
await browser.close()
