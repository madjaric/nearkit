// Quick full-resolution capture: node scripts/snap.mjs <url> <out.png> [width] [height] [fullPage]
import { chromium } from 'playwright-core'
import { readdirSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const [url, out, w = '1440', h = '900', full = '1'] = process.argv.slice(2)
const pw = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
const dir = existsSync(pw)
  ? readdirSync(pw)
      .filter((d) => d.startsWith('chromium-'))
      .sort()
      .pop()
  : null
const exe = process.env.CHROME_PATH ?? (dir ? join(pw, dir, 'chrome-win64', 'chrome.exe') : undefined)
const browser = await chromium.launch({ executablePath: exe })
const mobile = Number(w) < 768
const ctx = await browser.newContext({ viewport: { width: Number(w), height: Number(h) }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 })
const page = await ctx.newPage()
await page.goto(url, { waitUntil: 'networkidle' })
await page.waitForTimeout(600)
mkdirSync(dirname(out), { recursive: true })
await page.screenshot({ path: out, fullPage: full === '1' })
await browser.close()
console.log('wrote', out)
