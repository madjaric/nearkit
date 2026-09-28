// Visual QA captures with a local Chromium.
//   node scripts/shoot.mjs --out <dir> [--base http://localhost:5196] [--widths 1440,390] [--full] route[@name] ...
// Captures each route at each width, waiting for the app to settle (skeletons gone).
import { chromium } from 'playwright-core'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const flag = (name) => args.includes(`--${name}`)
const BASE = opt('base', 'http://localhost:5196')
const OUT = opt('out', '.impeccable/review')
const WIDTHS = opt('widths', '1440,390').split(',').map(Number)
const FULL = flag('full')
const HEIGHT = Number(opt('height', '900'))
const skip = new Set(['--base', '--out', '--widths', '--height'])
const routes = args.filter((a, i) => !a.startsWith('--') && !skip.has(args[i - 1]))
mkdirSync(OUT, { recursive: true })

const pw = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
const dir = existsSync(pw)
  ? readdirSync(pw)
      .filter((d) => d.startsWith('chromium-'))
      .sort()
      .pop()
  : null
const exe = process.env.CHROME_PATH ?? (dir ? join(pw, dir, 'chrome-win64', 'chrome.exe') : undefined)
const browser = await chromium.launch({ executablePath: exe })

const errors = []
for (const width of WIDTHS) {
  const mobile = width < 768
  const ctx = await browser.newContext({ viewport: { width, height: mobile ? 844 : HEIGHT }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1, reducedMotion: 'reduce' })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(`[${width}] pageerror: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && errors.push(`[${width}] console: ${m.text()}`))
  for (const spec of routes.length ? routes : ['/']) {
    const [path, name = path === '/' ? 'dashboard' : path.replace(/^\//, '').replace(/[/?=&.]/g, '-')] = spec.split('@')
    await page.goto(BASE + path, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1400)
    const overflow = await page.evaluate((w) => document.documentElement.scrollWidth - w, width)
    if (overflow > 0) errors.push(`[${width}] ${path}: horizontal overflow ${overflow}px`)
    const file = join(OUT, `${name}-${width}.png`)
    await page.screenshot({ path: file, fullPage: FULL })
    console.log(file)
  }
  await ctx.close()
}
await browser.close()
if (errors.length) {
  console.log('\nISSUES')
  for (const e of errors) console.log(' ', e)
}
