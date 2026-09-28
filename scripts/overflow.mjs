// Lists the outermost elements that extend past the viewport: node scripts/overflow.mjs <url> [width]
import { chromium } from 'playwright-core'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
const [url, w = '390'] = process.argv.slice(2)
const width = Number(w)
const pw = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
const dir = existsSync(pw)
  ? readdirSync(pw)
      .filter((d) => d.startsWith('chromium-'))
      .sort()
      .pop()
  : null
const browser = await chromium.launch({ executablePath: dir ? join(pw, dir, 'chrome-win64', 'chrome.exe') : undefined })
const mobile = width < 768
const page = await (await browser.newContext({ viewport: { width, height: 844 }, isMobile: mobile, hasTouch: mobile })).newPage()
await page.goto(url, { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
const found = await page.evaluate((limit) => {
  const out = []
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.right <= limit + 1) continue
    let p = el.parentElement,
      clipped = false
    while (p && p !== document.body) {
      const cs = getComputedStyle(p)
      if (/(auto|scroll|hidden|clip)/.test(cs.overflowX)) {
        const pr = p.getBoundingClientRect()
        if (pr.right <= limit + 1) {
          clipped = true
          break
        }
      }
      p = p.parentElement
    }
    if (clipped) continue
    const parentOver = el.parentElement && el.parentElement.getBoundingClientRect().right > limit + 1
    if (parentOver && el.parentElement !== document.body) continue
    out.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 90)} right=${Math.round(r.right)} w=${Math.round(r.width)}`)
  }
  return out.slice(0, 12)
}, width)
console.log(found.join('\n') || 'no overflow')
await browser.close()
