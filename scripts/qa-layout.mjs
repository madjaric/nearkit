// Layout QA at exact widths, against a local server or production:
//   node scripts/qa-layout.mjs --base <url> --out <dir> [--widths 1440,1280,390,360] [--until load|networkidle] [--wait ms] [--ticket] route[@name] ...
// Per page and width it reports page overflow, boxes that scroll sideways, truncated text, colliding chart
// axis labels and labels that spill out of their key, and saves a full-page capture. `--ticket` also opens the
// Quick Trade ticket from the Dashboard's BUY key (nothing is typed or sent). Paths: use C:/... on Windows.
import { chromium } from 'playwright-core'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const BASE = opt('base', 'http://localhost:5198')
const OUT = opt('out', 'qa')
const WIDTHS = opt('widths', '1440,1280,390,360').split(',').map(Number)
const TICKET = args.includes('--ticket')
const WAIT = Number(opt('wait', '1800'))
const UNTIL = opt('until', 'networkidle')
const skip = new Set(['--base', '--out', '--widths', '--wait', '--until'])
const routes = args.filter((a, i) => !a.startsWith('--') && !skip.has(args[i - 1]))
mkdirSync(OUT, { recursive: true })

const pw = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
const dir = existsSync(pw)
  ? readdirSync(pw)
      .filter((d) => d.startsWith('chromium-'))
      .sort()
      .pop()
  : null
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? (dir ? join(pw, dir, 'chrome-win64', 'chrome.exe') : undefined) })

const probe = (width) => {
  const text = (e) => e.textContent.trim().replace(/\s+/g, ' ').slice(0, 60)
  const visible = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'
  const truncated = []
  const scrollers = []
  for (const e of document.querySelectorAll('body *')) {
    if (!visible(e)) continue
    const cs = getComputedStyle(e)
    if (cs.textOverflow === 'ellipsis' && e.scrollWidth > e.clientWidth + 1) truncated.push(`${text(e)} [${e.clientWidth}<${e.scrollWidth}]`)
    if (/(auto|scroll)/.test(cs.overflowX) && e.scrollWidth > e.clientWidth + 1)
      scrollers.push(`${e.tagName.toLowerCase()}.${String(e.className).slice(0, 50)} [${e.clientWidth}<${e.scrollWidth}] ${text(e).slice(0, 30)}`)
  }
  let collide = 0
  for (const axis of document.querySelectorAll('[data-axis="x"]')) {
    const rects = [...axis.children].filter(visible).map((c) => c.getBoundingClientRect())
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) if (rects[i].left < rects[j].right && rects[j].left < rects[i].right) collide++
  }
  // Text that spills out of its own key (a label wider than its button).
  const spilled = []
  for (const b of document.querySelectorAll('button, a[class*="keycap"]')) {
    if (!visible(b)) continue
    if (b.scrollWidth > b.clientWidth + 1 && getComputedStyle(b).overflowX === 'visible') spilled.push(`${text(b)} [${b.clientWidth}<${b.scrollWidth}]`)
  }
  return {
    overflow: document.documentElement.scrollWidth - width,
    splash: /Starting NearKit/.test(document.body.innerText) && !document.querySelector('main'),
    truncated,
    scrollers,
    collide,
    spilled,
  }
}

const report = []
for (const width of WIDTHS) {
  const mobile = width < 768
  const ctx = await browser.newContext({ viewport: { width, height: mobile ? 844 : 900 }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1, reducedMotion: 'reduce' })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  for (const spec of routes.length ? routes : ['/']) {
    const [path, name = path === '/' ? 'dashboard' : path.replace(/^\//, '').replace(/[/?=&.]/g, '-')] = spec.split('@')
    await page.goto(BASE + path, { waitUntil: UNTIL, timeout: 45000 }).catch(() => {})
    await page.waitForSelector('main', { timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(WAIT)
    const r = await page.evaluate(probe, width)
    await page.screenshot({ path: join(OUT, `${name}-${width}.png`), fullPage: true })
    report.push({ width, path, ...r, errors: errors.splice(0) })
  }
  if (TICKET) {
    // The Quick Trade ticket, opened from the Dashboard's BUY key; nothing is typed or sent.
    await page.goto(BASE + '/', { waitUntil: UNTIL, timeout: 45000 }).catch(() => {})
    await page.waitForSelector('main', { timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(WAIT)
    const buy = page.locator('main').getByRole('button', { name: 'Buy', exact: true }).first()
    if (await buy.count()) {
      await buy.click()
      await page
        .getByRole('dialog', { name: 'Trade ticket' })
        .waitFor({ timeout: 8000 })
        .catch(() => {})
      await page.waitForTimeout(900)
      const r = await page.evaluate(probe, width)
      await page.screenshot({ path: join(OUT, `ticket-${width}.png`) })
      report.push({ width, path: 'ticket (Quick Trade)', ...r, errors: errors.splice(0) })
    } else report.push({ width, path: 'ticket (Quick Trade)', missing: 'no BUY key on the Dashboard' })
  }
  await ctx.close()
}
await browser.close()
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 1))
for (const r of report) {
  const flags = []
  if (r.missing) flags.push(r.missing)
  if (r.splash) flags.push('SPLASH (not loaded)')
  if (r.overflow > 0) flags.push(`page overflow ${r.overflow}px`)
  if (r.collide) flags.push(`${r.collide} colliding axis labels`)
  if (r.scrollers?.length) flags.push(`sideways scroll: ${r.scrollers.join(' | ')}`)
  if (r.spilled?.length) flags.push(`label spills its key: ${r.spilled.join(' | ')}`)
  if (r.truncated?.length) flags.push(`truncated: ${r.truncated.join(' | ')}`)
  if (r.errors?.length) flags.push(`errors: ${r.errors.join(' | ')}`)
  console.log(`[${r.width}] ${r.path}: ${flags.length ? flags.join('\n      ') : 'ok'}`)
}
