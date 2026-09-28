// The public testnet beta's COMING SOON gate, checked in a production build:
//   npm run e2e:beta [-- --shots <dir>] [-- --width 390]
// Builds dist/e2e-beta in e2e mode (a production build, so the gate is on, that
// also carries the scripted test wallet), serves it on port 5204 and checks that
// Multi Trade, Limit Orders, DCA, Copy Trade and Sniper are tagged and read-only
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

// form: the page body has fields and keys (PnL's held-back body is a note and a link).
const SOON = [
  { route: '/multi-trade', label: 'Multi Trade', form: true },
  { route: '/limit-orders', label: 'Limit Orders', form: true },
  { route: '/dca', label: 'DCA', form: true },
  { route: '/copy-trade', label: 'Copy Trade', form: true },
  { route: '/sniper', label: 'Sniper', form: true },
  { route: '/pnl', label: 'PnL', form: false },
]
const LIVE = ['/swap', '/split', '/consolidate', '/batch-send', '/wallets', '/positions', '/scanner']
/** The sidebar, top to bottom: live features first, everything held back in COMING SOON. */
const SIDEBAR = [
  ['Trade', ['Swap', 'Quick Trade']],
  ['Tools', ['Split', 'Consolidate', 'Batch Send', 'Wallets & Presets']],
  ['Portfolio', ['Positions']],
  ['Intelligence', ['Scanner']],
  ['Coming soon', ['Multi Trade', 'Limit Orders', 'DCA', 'Copy Trade', 'Sniper', 'PnL', 'Telegram', '$KIT'].map((l) => `${l} SOON`)],
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
  await page.goto(BASE + '/multi-trade', { waitUntil: 'networkidle' })
  await visible('Multi Trade is not part of the public beta yet')
  await visible('Multi Trade is coming soon')
  if ((await hasSoonTag()) !== 1) throw new Error('No COMING SOON tag beside the title')
  await shot('beta-01-no-wallet')
})

await step('Dashboard: the Multi buy and limit-order shortcuts are tagged SOON', async () => {
  await page.goto(BASE + '/', { waitUntil: 'networkidle' })
  const main = page.locator('main')
  // Multi buy and Place a limit order are actions the beta can't do: shown, tagged, not clickable.
  for (const name of [/multi buy/i, /place a limit order/i]) {
    const key = main.locator('[aria-disabled="true"]', { hasText: name })
    if (!/soon/i.test(await key.innerText())) throw new Error(`${name} has no SOON tag`)
  }
  if ((await main.locator('a[href="/multi-trade"]').count()) !== 0) throw new Error('Multi buy still links to Multi Trade')
  // Manage only opens the orders page, which says COMING SOON itself.
  const manage = main.locator('a[href="/limit-orders"]', { hasText: /manage/i })
  if (!/soon/i.test(await manage.innerText())) throw new Error('Manage has no SOON tag')
  if ((await main.locator('a[href="/limit-orders"]', { hasText: /place a limit order/i }).count()) !== 0) throw new Error('Place a limit order still links')
  // The live shortcuts are untouched.
  for (const route of ['/split', '/batch-send']) {
    if (/soon/i.test(await main.locator(`header a[href="${route}"]`).innerText())) throw new Error(`${route} is tagged SOON`)
  }
  await shot('beta-02-dashboard')
})

if (WIDTH < 1024) {
  await step('phone: Multi (SOON) comes after the live tabs, and the menu matches the sidebar', async () => {
    const tabs = page.locator('nav[aria-label="Quick navigation"]')
    const order = (await tabs.locator('li').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim().replace(/soon$/i, 'SOON'))
    if (order.join('|') !== 'Home|Trade|Positions|Multi SOON|Menu') throw new Error(`Tabs are ${order.join(', ')}`)
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
    await search.fill('multi')
    if (!/soon/i.test(await option(/Multi Trade/).innerText())) throw new Error('Multi Trade result has no SOON tag')
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

await step('Wallets: a preset’s Use (Multi Trade) is disabled and tagged SOON; presets still work', async () => {
  await page.goto(BASE + '/wallets', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Create preset' }).first().click()
  const modal = page.getByRole('dialog', { name: 'Create preset' })
  await modal.getByLabel('Name').fill('beta')
  await modal.getByText('Main', { exact: true }).first().click()
  await modal.getByRole('button', { name: 'Create preset' }).click()
  await visible('Preset BETA created')
  const use = page.locator('main').getByRole('button', { name: 'Use', exact: true }).visible().first()
  if (await use.isEnabled()) throw new Error('Use is still enabled')
  if (!/soon/i.test(await use.locator('..').innerText())) throw new Error('Use has no SOON tag beside it')
  await shot('beta-03-preset')
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

await step('Split, Consolidate, Batch Send, Wallets and Scanner are not held back', async () => {
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
