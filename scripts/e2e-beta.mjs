// The public testnet beta's COMING SOON gate, checked in a production build:
//   npm run e2e:beta [-- --shots <dir>] [-- --width 390]
// Builds dist/e2e-beta in e2e mode (a production build, so the gate is on, that
// also carries the scripted test wallet), serves it on port 5204 and checks that
// Limit Orders, DCA, Copy Trade and Sniper are tagged and read-only
// while the live tools keep working. A fake NEAR network answers every request.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { createFakeNear } from './lib/fake-near.mjs'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const SHOTS = opt('shots', null)
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
const WIDTH = Number(opt('width', '1440'))
const PORT = 5204
const BASE = `http://localhost:${PORT}`
const OUT = 'dist/e2e-beta'
const VITE = join('node_modules', 'vite', 'bin', 'vite.js')

const build = spawnSync(process.execPath, [VITE, 'build', '--mode', 'e2e', '--outDir', OUT, '--logLevel', 'warn'], { stdio: 'inherit' })
if (build.status !== 0) process.exit(build.status ?? 1)
const server = spawn(process.execPath, [VITE, 'preview', '--outDir', OUT, '--port', String(PORT), '--strictPort'], { stdio: 'ignore' })
for (let i = 0; i < 100; i++) {
  const up = await fetch(BASE).then(
    (r) => r.ok,
    () => false,
  )
  if (up) break
  await new Promise((r) => setTimeout(r, 200))
}

const pw = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
const dir = existsSync(pw)
  ? readdirSync(pw)
      .filter((d) => d.startsWith('chromium-'))
      .sort()
      .pop()
  : null
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? (dir ? join(pw, dir, 'chrome-win64', 'chrome.exe') : undefined) })

const ONE = 10n ** 24n
const USER = 'e2e-user.testnet'
const USDT = 'usdt.itachicara.testnet'
const MIN = '1250000000000000000000'
const near = createFakeNear({
  accounts: {
    [USER]: { amount: String(5n * ONE) },
    'bob.testnet': { amount: String(ONE) },
    [USDT]: { amount: String(ONE), code: true },
    'wrap.testnet': { amount: String(ONE), code: true },
  },
  tokens: {
    [USDT]: {
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 24,
      balances: { [USER]: String(100n * ONE) },
      registered: [USER, 'bob.testnet', 'ref-finance-101.testnet'],
      boundsMin: MIN,
    },
    'wrap.testnet': { symbol: 'wNEAR', name: 'Wrapped NEAR', decimals: 24, balances: {}, registered: ['ref-finance-101.testnet'], boundsMin: MIN },
  },
})

// form: the page body has fields and keys.
const SOON = [
  { route: '/limit-orders', label: 'Limit Orders', form: true },
  { route: '/dca', label: 'DCA', form: true },
  { route: '/copy-trade', label: 'Copy Trade', form: true },
  { route: '/sniper', label: 'Sniper', form: true },
]
const LIVE = ['/swap', '/multi-trade', '/split', '/consolidate', '/batch-send', '/wallets', '/positions', '/pnl', '/scanner']
/** The sidebar, top to bottom: live features first, everything held back in COMING SOON. */
const SIDEBAR = [
  ['Trade', ['Swap', 'Quick Trade', 'Multi Trade']],
  ['Tools', ['Split', 'Consolidate', 'Batch Send', 'Wallets & Presets']],
  ['Portfolio', ['Positions', 'PnL']],
  ['Intelligence', ['Scanner']],
  ['Coming soon', ['$KIT', 'Limit Orders', 'Volume Bot', 'DCA', 'Copy Trade', 'Sniper', 'Telegram'].map((l) => `${l} SOON`)],
]
/** Group names and entries of a navigation body, as rendered. */
const navGroups = (nav) =>
  nav
    .locator('[role="group"]')
    .evaluateAll((groups) =>
      groups.map((g) => [g.getAttribute('aria-label'), [...g.querySelectorAll('li')].map((li) => li.innerText.replace(/\s+/g, ' ').trim().replace(/soon$/i, 'SOON'))]),
    )
const sameNav = (actual) => JSON.stringify(actual) === JSON.stringify(SIDEBAR)

const errors = []
const results = []
let passed = 0
const ctx = await browser.newContext({ viewport: { width: WIDTH, height: WIDTH < 768 ? 844 : 900 } })
await ctx.addInitScript((user) => {
  window.__NEARKIT_E2E_WALLET__ = { accounts: [user], walletName: 'E2E Test Wallet' }
}, USER)
const page = await ctx.newPage()
await near.install(page)
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error' && !/net::ERR_FAILED|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`)
})

async function finish(code) {
  await browser.close()
  server.kill()
  process.exit(code)
}
async function step(name, fn) {
  try {
    await fn()
    passed += 1
    results.push(`  ok   ${name}`)
  } catch (e) {
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'FAILED-' + name.replace(/[^a-z0-9]+/gi, '-').slice(0, 40) + '.png') }).catch(() => {})
    results.push(`  FAIL ${name}\n       ${String(e.message).split('\n')[0]}`)
    console.log(results.join('\n'))
    console.log(`\n${passed} passed, 1 failed`)
    if (errors.length) console.log('console/page errors:\n  ' + errors.join('\n  '))
    await finish(1)
  }
}
const shot = async (name) => SHOTS && page.screenshot({ path: join(SHOTS, `${name}.png`) })
const visible = (text, opts = {}) => page.getByText(text, opts).visible().first().waitFor({ state: 'visible', timeout: 8000 })
const hasSoonTag = () =>
  page
    .locator('main h1 + span')
    .filter({ hasText: /^coming soon$/i })
    .count()

await step('boots as the testnet beta', async () => {
  await page.goto(BASE + '/', { waitUntil: 'networkidle' })
  await visible('Testnet beta', { exact: true })
})

if (WIDTH >= 1024) {
  await step('the sidebar lists the live features first and every held-back one under COMING SOON', async () => {
    const groups = await navGroups(page.locator('aside nav[aria-label="Main"]'))
    if (!sameNav(groups)) throw new Error(`Sidebar is ${JSON.stringify(groups)}`)
    const footer = await page.locator('aside nav[aria-label="Main"] + div li').allInnerTexts()
    if (footer.map((t) => t.trim()).join() !== 'Settings,Documentation') throw new Error(`Footer is ${footer}`)
    await shot('beta-00-sidebar')
  })

  await step('Quick Trade in the sidebar opens the trade ticket without leaving the page', async () => {
    await page.locator('aside').getByRole('button', { name: 'Quick Trade' }).click()
    const ticket = page.getByRole('dialog', { name: 'Trade ticket' })
    await ticket.getByText('Trade USDT').waitFor()
    if (new URL(page.url()).pathname !== '/') throw new Error('Quick Trade navigated away')
    await ticket.getByRole('button', { name: 'Close trade ticket' }).click()
    await ticket.waitFor({ state: 'hidden' })
  })
}

await step('without a wallet, a held-back page says it is coming soon', async () => {
  await page.goto(BASE + '/limit-orders', { waitUntil: 'networkidle' })
  await visible('Limit Orders is not part of the public beta yet')
  await visible('Limit Orders is coming soon')
  if ((await hasSoonTag()) !== 1) throw new Error('No COMING SOON tag beside the title')
  await shot('beta-01-no-wallet')
})

await step('Dashboard: the limit-order shortcuts are tagged SOON; Multi buy is live', async () => {
  await page.goto(BASE + '/', { waitUntil: 'networkidle' })
  const main = page.locator('main')
  // Place a limit order is an action the beta can't do: shown, tagged, not clickable.
  const key = main.locator('[aria-disabled="true"]', { hasText: /place a limit order/i })
  if (!/soon/i.test(await key.innerText())) throw new Error('Place a limit order has no SOON tag')
  const multi = main.locator('a[href="/multi-trade"]', { hasText: /multi buy/i })
  if ((await multi.count()) !== 1 || /soon/i.test(await multi.innerText())) throw new Error('Multi buy is not a live link')
  // Manage only opens the orders page, which says COMING SOON itself.
  const manage = main.locator('a[href="/limit-orders"]', { hasText: /manage/i })
  if (!/soon/i.test(await manage.innerText())) throw new Error('Manage has no SOON tag')
  if ((await main.locator('a[href="/limit-orders"]', { hasText: /place a limit order/i }).count()) !== 0) throw new Error('Place a limit order still links')
  // The live shortcuts are untouched.
  for (const route of ['/batch-send']) {
    if (/soon/i.test(await main.locator(`header a[href="${route}"]`).innerText())) throw new Error(`${route} is tagged SOON`)
  }
  await shot('beta-02-dashboard')
})

if (WIDTH < 1024) {
  await step('phone: the tabs are all live, and the menu matches the sidebar', async () => {
    const tabs = page.locator('nav[aria-label="Quick navigation"]')
    const order = (await tabs.locator('li').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim().replace(/soon$/i, 'SOON'))
    if (order.join('|') !== 'Home|Trade|Multi|Positions|Menu') throw new Error(`Tabs are ${order.join(', ')}`)
    await tabs.locator('a[href="/multi-trade"]').waitFor()
    await page.getByRole('button', { name: 'Open navigation' }).first().click()
    const drawer = page.getByRole('dialog', { name: 'Navigation' })
    const groups = await navGroups(drawer.locator('nav[aria-label="Main"]'))
    if (!sameNav(groups)) throw new Error(`Menu is ${JSON.stringify(groups)}`)
    await shot('beta-00-menu')
    await drawer.getByRole('button', { name: 'Close navigation' }).click()
    await drawer.waitFor({ state: 'hidden' })
  })
}

if (WIDTH >= 1024) {
  await step('search tags held-back pages and commands SOON, and only those', async () => {
    const search = page.getByLabel('Search token, contract or command')
    const option = (name) => page.getByRole('option', { name }).first()
    await search.fill('limit')
    if (!/soon/i.test(await option(/Limit Orders/).innerText())) throw new Error('Limit Orders result has no SOON tag')
    await search.fill('multi')
    if (/soon/i.test(await option(/Multi Trade/).innerText())) throw new Error('Multi Trade is tagged SOON')
    await search.fill('/snipe')
    if (!/soon/i.test(await option(/\/snipe/).innerText())) throw new Error('/snipe has no SOON tag')
    await search.fill('/split')
    if (/soon/i.test(await option(/\/split/).innerText())) throw new Error('/split is tagged SOON')
    await search.fill('')
    await page.keyboard.press('Escape')
  })
}

await step('connects through the wallet adapter', async () => {
  await page.getByRole('button', { name: 'Connect wallet' }).first().click()
  await page
    .getByRole('dialog', { name: 'Connect a wallet' })
    .getByRole('button', { name: /E2E Test Wallet/ })
    .click()
  await visible('Wallet connected')
})

await step('Wallets: a preset’s Use opens Multi Trade with that preset', async () => {
  await page.goto(BASE + '/wallets', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Create preset' }).first().click()
  const modal = page.getByRole('dialog', { name: 'Create preset' })
  await modal.getByLabel('Name').fill('beta')
  await modal.getByText('Main', { exact: true }).first().click()
  await modal.getByRole('button', { name: 'Create preset' }).click()
  await visible('Preset BETA created')
  const use = page.locator('main').getByRole('button', { name: 'Use', exact: true }).visible().first()
  if (!(await use.isEnabled())) throw new Error('Use is disabled')
  if (/soon/i.test(await use.locator('..').innerText())) throw new Error('Use is tagged SOON')
  await shot('beta-03-preset')
  await use.click()
  await page.waitForURL(/\/multi-trade\?preset=/)
  await page
    .getByRole('button', { name: /Execute multi buy/i })
    .first()
    .waitFor()
})

for (const { route, label, form } of SOON) {
  await step(`${label}: COMING SOON, and every field and key is disabled`, async () => {
    const before = (await page.evaluate(() => window.__NEARKIT_E2E_SIGNED__ ?? [])).length
    await page.goto(BASE + route, { waitUntil: 'networkidle' })
    await visible(`${label} is not part of the public beta yet`)
    if ((await hasSoonTag()) !== 1) throw new Error('No COMING SOON tag beside the title')
    const gate = page.locator('main fieldset[disabled]')
    await gate.waitFor({ timeout: 8000 })
    // Pages that execute say why under their key; PnL executes nothing.
    if (form) await gate.getByText('Coming soon. This is not available in the public beta yet').first().waitFor()
    const controls = await gate.locator('button, input, select, textarea').count()
    const enabled = await gate.locator('button:enabled, input:enabled, select:enabled, textarea:enabled').count()
    if (form && controls === 0) throw new Error('The page rendered no controls to check')
    if (enabled !== 0) throw new Error(`${enabled} of ${controls} controls are still enabled`)
    const text = await page.locator('main').innerText()
    if (/Enter a (total|buy) amount|Enter a trigger price|Select at least one wallet/.test(text)) throw new Error('A form hint suggests the page can be used')
    if ((await page.getByRole('dialog').count()) !== 0) throw new Error('A dialog is open')
    const after = (await page.evaluate(() => window.__NEARKIT_E2E_SIGNED__ ?? [])).length
    if (after !== before) throw new Error('Something was signed')
    await shot(`beta-${route.slice(1)}`)
  })
}

await step('the live tools stay live: a testnet swap quotes and can be reviewed', async () => {
  await page.goto(BASE + '/swap', { waitUntil: 'networkidle' })
  if ((await hasSoonTag()) !== 0) throw new Error('Swap is tagged COMING SOON')
  await page.getByPlaceholder('0.00').first().fill('1')
  await visible(/1 NEAR ≈ 4\.0\d USDT/)
  await page.getByRole('button', { name: 'Swap NEAR → USDT' }).click()
  await page.getByRole('button', { name: 'Confirm swap' }).click()
  await page.getByRole('dialog', { name: 'Review swap' }).waitFor({ timeout: 10000 })
  await shot('beta-swap-review')
  await page.keyboard.press('Escape')
})

await step('Multi Trade is live: a multi buy quotes and can be reviewed', async () => {
  await page.goto(BASE + '/multi-trade', { waitUntil: 'networkidle' })
  if ((await hasSoonTag()) !== 0) throw new Error('Multi Trade is tagged COMING SOON')
  await page.getByLabel('Total', { exact: true }).fill('1')
  await page.getByRole('button', { name: /Execute multi buy/i }).click()
  const modal = page.getByRole('dialog', { name: /Review multi buy/i })
  await modal.getByText(/no all-or-nothing execution/).waitFor({ timeout: 15000 })
  await shot('beta-multi-review')
  await page.keyboard.press('Escape')
})

await step('Multi Trade, Split, Consolidate, Batch Send, Wallets, Positions, PnL and Scanner are not held back', async () => {
  for (const route of LIVE.slice(1)) {
    await page.goto(BASE + route, { waitUntil: 'networkidle' })
    await page.locator('main h1').first().waitFor()
    if ((await hasSoonTag()) !== 0) throw new Error(`${route} is tagged COMING SOON`)
    if ((await page.locator('main fieldset[disabled]').count()) !== 0) throw new Error(`${route} is read-only`)
    if (/not part of the public beta/.test(await page.locator('main').innerText())) throw new Error(`${route} shows the coming-soon notice`)
  }
  await page.goto(BASE + '/batch-send', { waitUntil: 'networkidle' })
  const list = page.locator('main textarea').first()
  await list.waitFor()
  if (!(await list.isEnabled())) throw new Error('Batch Send is not editable')
})

await step('PnL is live on the beta and honest: NEAR figures from on-chain history, partial when history does not explain a balance', async () => {
  await page.goto(BASE + '/pnl', { waitUntil: 'networkidle' })
  await visible('On-chain history')
  await visible('in NEAR: no USD prices on this network')
  // The fake index has no transactions, yet the account holds USDT: said, not hidden.
  await page
    .getByText(/doesn’t explain the whole balance/)
    .visible()
    .first()
    .waitFor({ timeout: 15000 })
  if ((await page.locator('main fieldset[disabled]').count()) !== 0) throw new Error('PnL is read-only')
  await shot('beta-pnl')
})

await step(
  'the public address is nearkits.com: every page names it (canonical, og:url), robots.txt, sitemap.xml and the JSON-LD point there, and vercel.app appears nowhere',
  async () => {
    const html = await (await fetch(BASE + '/token/kit')).text()
    // The served HTML names no canonical of its own (each page sets one as it renders): never two that disagree.
    if (/rel="canonical"/.test(html)) throw new Error('the served HTML names a canonical')
    if (html.includes('vercel.app')) throw new Error('the served HTML names vercel.app')
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)?.[1] ?? '{}')
    if (ld.url !== 'https://nearkits.com/' || ld.name !== 'NEARKITS') throw new Error(`JSON-LD: ${JSON.stringify(ld)}`)
    const robots = await fetch(BASE + '/robots.txt')
    const robotsText = await robots.text()
    if (!robots.ok || !robotsText.includes('Sitemap: https://nearkits.com/sitemap.xml')) throw new Error(`robots.txt: ${robots.status} ${robotsText.slice(0, 200)}`)
    const sitemap = await fetch(BASE + '/sitemap.xml')
    const xml = await sitemap.text()
    if (!sitemap.ok || !xml.includes('<loc>https://nearkits.com/</loc>') || !xml.includes('<loc>https://nearkits.com/docs</loc>') || xml.includes('vercel.app'))
      throw new Error(`sitemap.xml: ${sitemap.status} ${xml.slice(0, 300)}`)
    const named = () =>
      page.evaluate(() => `${document.querySelector('link[rel="canonical"]')?.getAttribute('href')} ${document.querySelector('meta[property="og:url"]')?.getAttribute('content')}`)
    // The page names its address once it has rendered (an effect after the URL changes): wait for it, briefly.
    const expectNamed = async (url) => {
      const want = `${url} ${url}`
      await page
        .waitForFunction(
          (w) => `${document.querySelector('link[rel="canonical"]')?.getAttribute('href')} ${document.querySelector('meta[property="og:url"]')?.getAttribute('content')}` === w,
          want,
          { timeout: 5000 },
        )
        .catch(async () => {
          throw new Error(`${new URL(page.url()).pathname} names ${await named()}, not ${url}`)
        })
    }
    // Served from localhost here, as from nearkit.vercel.app: the page still names nearkits.com, without the query.
    await page.goto(BASE + '/swap?from=near&to=kit', { waitUntil: 'networkidle' })
    await expectNamed('https://nearkits.com/swap')
    // And follows in-app navigation.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Split', exact: true }).click()
    await page.waitForURL(/\/split$/)
    await expectNamed('https://nearkits.com/split')
  },
)

if (near.state.external.length) {
  results.push(`  note external requests aborted: ${[...new Set(near.state.external.map((u) => new URL(u).host))].join(', ')}`)
}
console.log(results.join('\n'))
console.log(`\n${passed} passed, 0 failed`)
if (errors.length) {
  console.log('console/page errors:\n  ' + errors.join('\n  '))
  await finish(1)
}
await finish(0)
