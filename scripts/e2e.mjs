// End-to-end interaction pass over every major flow, in DEMO mode (simulated services).
//   node scripts/e2e.mjs [--base http://localhost:5198] [--shots <dir>]
// Run the demo server first: npm run dev:demo (or preview a `vite build --mode demo`).
// Exits non-zero on the first failed expectation or any console/page error.
import { chromium } from 'playwright-core'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const BASE = opt('base', 'http://localhost:5198')
const SHOTS = opt('shots', null)
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

const pw = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
const dir = existsSync(pw)
  ? readdirSync(pw)
      .filter((d) => d.startsWith('chromium-'))
      .sort()
      .pop()
  : null
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? (dir ? join(pw, dir, 'chrome-win64', 'chrome.exe') : undefined) })

const errors = []
let passed = 0
const results = []

async function newPage(width = 1440, height = 900) {
  const mobile = width < 768
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`))
  return page
}

async function step(name, fn) {
  try {
    await fn()
    passed += 1
    results.push(`  ok   ${name}`)
  } catch (e) {
    for (const ctx of browser.contexts())
      for (const pg of ctx.pages()) if (SHOTS) await pg.screenshot({ path: join(SHOTS, 'FAILED-' + name.replace(/[^a-z0-9]+/gi, '-').slice(0, 40) + '.png') }).catch(() => {})
    results.push(`  FAIL ${name}\n       ${String(e.message).split('\n')[0]}`)
    console.log(results.join('\n'))
    console.log(`\n${passed} passed, 1 failed`)
    if (errors.length) console.log('console/page errors:\n  ' + errors.join('\n  '))
    await browser.close()
    process.exit(1)
  }
}

// Let entrance animations settle so captures show the resting state.
const shot = async (page, name) => {
  if (!SHOTS) return
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}
const visible = (page, text, opts = {}) => page.getByText(text, opts).first().waitFor({ state: 'visible', timeout: 6000 })

const page = await newPage()

await step('dashboard renders readouts, positions and ticket', async () => {
  await page.goto(BASE + '/', { waitUntil: 'networkidle' })
  await visible(page, 'Portfolio value')
  await visible(page, 'BLACKDRAGON')
  await page.getByRole('heading', { name: 'Quick trade' }).waitFor()
})

// NearKit's fee is set once, in src/lib/fees.ts (NEARKIT_FEE): 50 bps.
await step('quick trade: MAX fills, quote prints, fee is 0.50%', async () => {
  const ticket = page.locator('section', { has: page.getByRole('heading', { name: 'Quick trade' }) })
  await ticket.getByRole('button', { name: 'MAX' }).click()
  await ticket.getByText('You receive (est.)').waitFor()
  await ticket.getByText(/1 NEAR ≈ [\d,.]+[KMB]? BLACKDRAGON/).waitFor({ timeout: 6000 })
  await ticket.getByText('0.50%').first().waitFor()
})

await step('quick trade: two-step arm then confirm simulates and toasts', async () => {
  const ticket = page.locator('section', { has: page.getByRole('heading', { name: 'Quick trade' }) })
  const amount = ticket.getByLabel('You pay')
  await amount.fill('5')
  await page.waitForTimeout(700)
  await ticket.getByRole('button', { name: /^Buy BLACKDRAGON$/i }).click()
  await ticket.getByText('Armed. Press again to confirm').waitFor()
  await shot(page, 'quick-trade-armed')
  await ticket.getByRole('button', { name: /Confirm buy BLACKDRAGON/i }).click()
  // Confirming opens the review of the exact plan; signing it runs the (simulated) execution.
  const review = page.getByRole('dialog', { name: 'Review buy' })
  await review.getByText('You pay').waitFor({ timeout: 6000 })
  await review.getByText('Minimum received').waitFor()
  await review.getByText(/NEARKITS fee \(0\.50%\)/).waitFor()
  await shot(page, 'quick-trade-review')
  await review.getByRole('button', { name: /^Buy BLACKDRAGON$/i }).click()
  await page.getByRole('dialog', { name: 'Simulation complete' }).waitFor({ timeout: 8000 })
  await visible(page, /Simulated · Buy BLACKDRAGON/)
  await visible(page, 'Nothing was signed or sent. Balances are unchanged.')
  await page.getByRole('dialog', { name: 'Simulation complete' }).getByRole('button', { name: 'Close' }).last().click()
})

await step('quick trade: insufficient balance blocks the key', async () => {
  const ticket = page.locator('section', { has: page.getByRole('heading', { name: 'Quick trade' }) })
  await ticket.getByLabel('You pay').fill('999999')
  await ticket.getByText(/Main holds 8,420\.55 NEAR/).waitFor()
  if (await ticket.getByRole('button', { name: /^Buy BLACKDRAGON$/i }).isEnabled()) throw new Error('Buy key should be disabled when the balance is short')
  await ticket.getByLabel('You pay').fill('')
})

await step('positions BUY opens the trade drawer prefilled', async () => {
  await page.getByRole('button', { name: 'Sell SHITZU' }).first().click()
  const drawer = page.getByRole('dialog', { name: 'Trade ticket' })
  await drawer.getByText('Trade SHITZU').waitFor()
  await drawer.getByRole('radio', { name: 'Sell' }).waitFor()
  await shot(page, 'trade-drawer')
  await page.keyboard.press('Escape')
  await drawer.waitFor({ state: 'hidden' })
})

await step('the trade drawer’s token list opens inside the drawer (never behind it): search, pick, and the ticket follows', async () => {
  await page.getByRole('button', { name: 'Buy BLACKDRAGON' }).first().click()
  const drawer = page.getByRole('dialog', { name: 'Trade ticket' })
  await drawer.getByText('Trade BLACKDRAGON').waitFor()
  await drawer.getByRole('button', { name: /^Token: BLACKDRAGON/ }).click()
  // Inside the drawer's own dialog: a list mounted behind a modal dialog can't be reached at all.
  const search = drawer.getByRole('textbox', { name: 'Search tokens' })
  await search.fill('shi')
  await drawer
    .getByRole('option', { name: /SHITZU/ })
    .first()
    .click()
  await drawer.getByRole('button', { name: /^Token: SHITZU/ }).waitFor()
  await drawer.getByRole('button', { name: /^Buy SHITZU$/ }).waitFor()
  // Escape closes the list, not the drawer it sits in.
  await drawer.getByRole('button', { name: /^Token: SHITZU/ }).click()
  await search.waitFor()
  await page.keyboard.press('Escape')
  await search.waitFor({ state: 'hidden' })
  if (!(await drawer.isVisible())) throw new Error('Escape on the token list closed the trade drawer')
  await page.keyboard.press('Escape')
  await drawer.waitFor({ state: 'hidden' })
})

await step('the header’s NEAR price shows no ticking seconds counter', async () => {
  const text = ((await page.getByLabel('NEAR price').first().textContent()) ?? '').trim()
  if (!/^NEAR\/USD\$[\d.,]+/.test(text)) throw new Error(`unexpected ticker: ${text}`)
  if (/\d+s$/.test(text)) throw new Error(`the ticker still shows a seconds counter: ${text}`)
})

await step('portfolio value: 1D, 7D and 30D; 1D is the last 24 hours', async () => {
  await page.getByRole('radio', { name: '1D' }).click()
  await page.getByRole('img', { name: /Portfolio value, last 24 hours/ }).waitFor()
  await page.getByRole('radio', { name: '7D' }).click()
  await page.getByRole('img', { name: /Portfolio value, last 7 days/ }).waitFor()
})

await step('global search ranks the closest match first ("k": KIT before BLACKDRAGON) and opens Token Detail', async () => {
  // (The "/" shortcut skips form controls, and a range radio has focus here: click the box instead.)
  await page.getByRole('combobox', { name: 'Search token, contract or command' }).first().click()
  await page.keyboard.type('k')
  const first = page.getByRole('listbox', { name: 'Search results' }).getByRole('option').first()
  await first.waitFor()
  const label = ((await first.textContent()) ?? '').trim()
  if (!label.startsWith('KIT')) throw new Error(`the first result for "k" is ${label}`)
  await page.keyboard.press('Enter')
  await page.waitForURL(/\/token\/kit$/)
  await page.goto(BASE + '/', { waitUntil: 'networkidle' })
})

await step('global search: "/" focuses, command routes to Split', async () => {
  await page.keyboard.press('/')
  await page.keyboard.type('/split')
  await page
    .getByRole('option', { name: /\/split/ })
    .first()
    .waitFor()
  await page.keyboard.press('Enter')
  await page.waitForURL(/\/split$/)
  await page.getByRole('heading', { name: 'Split', level: 1 }).waitFor()
})

await step('split: brief example is balanced (25/25/20/15/15 → 1,000,000 KIT)', async () => {
  await visible(page, '100.00%')
  await page.getByText('Balanced', { exact: true }).first().waitFor()
  await visible(page, '250,000')
})

await step('split: percentages ≠ 100 block the key', async () => {
  await page.getByLabel('Recipient 5 percentage').first().fill('5')
  await visible(page, 'Percentages add up to 90.00%. They must total exactly 100%.')
  await page.getByRole('button', { name: 'Split tokens' }).isDisabled()
  await page.getByLabel('Recipient 5 percentage').first().fill('15')
})

await step('split: invalid external account is flagged', async () => {
  await page.getByRole('button', { name: /Add wallet/i }).click()
  const select = page.getByLabel('Recipient 6').first()
  await select.selectOption('__external__')
  await page.getByLabel('Recipient 6 account ID').first().fill('Bad..Account')
  await visible(page, 'Account IDs are lowercase')
  await shot(page, 'split-invalid')
  await page.getByRole('button', { name: 'Remove recipient 6' }).first().click()
})

await step('split: amount above balance is flagged', async () => {
  await page.getByLabel('Amount to distribute').fill('5000000')
  await visible(page, /Exceeds the available 1,250,000 KIT/)
  await page.getByLabel('Amount to distribute').fill('1000000')
})

await step('split: review shows exact amounts, then the execution log', async () => {
  await page.getByRole('button', { name: 'Split tokens' }).click()
  const modal = page.getByRole('dialog', { name: 'Review split' })
  await modal.waitFor()
  await modal.getByText('1,000,000 KIT').first().waitFor({ timeout: 6000 })
  await modal.getByText('250,000').first().waitFor()
  await modal.getByRole('button', { name: 'Split tokens' }).click()
  const done = page.getByRole('dialog', { name: 'Simulation complete' })
  await done.waitFor({ timeout: 8000 })
  await done.getByText('Simulation only: nothing is signed or sent.').waitFor()
  await shot(page, 'split-done')
  await done.getByRole('button', { name: 'Close' }).last().click()
})

await step('multi buy: equal split shows 2.00 NEAR per wallet and executes', async () => {
  await page.goto(BASE + '/multi-trade', { waitUntil: 'networkidle' })
  await visible(page, '2.00 NEAR / wallet')
  await page.getByRole('button', { name: /Execute multi buy/i }).click()
  const modal = page.getByRole('dialog', { name: /Review multi buy/i })
  await modal.waitFor()
  await modal.getByText('10 NEAR').first().waitFor({ timeout: 6000 })
  await modal.getByText(/NEARKITS fee \(0\.50%\)/).waitFor()
  await modal.getByText('5 in 5 approvals').waitFor()
  await shot(page, 'multi-confirm')
  await modal.getByRole('button', { name: /Execute multi buy/i }).click()
  const done = page.getByRole('dialog', { name: 'Simulation complete' })
  await done.waitFor({ timeout: 8000 })
  if ((await done.getByText('Simulated', { exact: true }).count()) !== 5) throw new Error('expected 5 simulated legs')
  await done.getByRole('button', { name: 'Close' }).last().click()
})

await step('multi buy: an underfunded wallet is flagged and skipped', async () => {
  await page.getByRole('button', { name: /SNIPERS/ }).click()
  await page.getByLabel('Total', { exact: true }).fill('500')
  await visible(page, /can't cover (its|their) allocation and will be skipped/)
})

await step('multi sell: each wallet has its own 25 / 50 / 75 / MAX, setting only that wallet’s share, and the estimate follows', async () => {
  await page.goto(BASE + '/multi-trade', { waitUntil: 'networkidle' })
  await page.getByRole('tablist', { name: 'Order side' }).getByRole('tab', { name: 'Multi sell' }).click()
  await page.getByRole('radiogroup', { name: 'Allocation mode' }).getByRole('radio', { name: 'Custom' }).click()
  const groups = page.getByRole('group', { name: /^Sell presets for / })
  await groups.first().waitFor()
  const shares = page.getByRole('textbox', { name: 'Percent of balance to sell' })
  await groups
    .nth(0)
    .getByRole('button', { name: /^Sell 75% of / })
    .click()
  await groups
    .nth(1)
    .getByRole('button', { name: /^Sell all of / })
    .click()
  const [a, b] = [await shares.nth(0).inputValue(), await shares.nth(1).inputValue()]
  if (a !== '75' || b !== '100') throw new Error(`the presets set ${a} and ${b}, not 75 and 100`)
  if (
    (await groups
      .nth(0)
      .getByRole('button', { name: /^Sell 75% of / })
      .getAttribute('aria-pressed')) !== 'true'
  )
    throw new Error('the chosen preset is not shown as chosen')
  // Typing a share still works, and changes only that wallet.
  await shares.nth(0).fill('10')
  if ((await shares.nth(1).inputValue()) !== '100') throw new Error('typing in one wallet changed another')
  await shot(page, 'multi-sell-presets')
})

await step('consolidate: brief total 427,560 KIT', async () => {
  await page.goto(BASE + '/consolidate', { waitUntil: 'networkidle' })
  await visible(page, '427,560')
  await page.getByRole('button', { name: 'Deselect all', exact: true }).click()
  await visible(page, 'Select at least one wallet')
  await page.getByRole('button', { name: 'Select all', exact: true }).click()
})

await step('batch send: parses the list and flags bad lines', async () => {
  await page.goto(BASE + '/batch-send', { waitUntil: 'networkidle' })
  await visible(page, 'charlie.near')
  const area = page.getByLabel('Batch list')
  await area.fill('alice.near,100\nbob.near,1,000\nCarl.near,5\nalice.near,9')
  await visible(page, 'Remove thousands separators (write 1000)')
  await visible(page, 'Account IDs are lowercase')
  await visible(page, 'Duplicate of line 1, skipped')
  await visible(page, 'Fix 2 invalid lines before sending')
  if (await page.getByRole('button', { name: 'Send batch' }).isEnabled()) throw new Error('Send batch should be disabled')
})

await step('wallets: create preset validates, saves, duplicates and deletes', async () => {
  await page.goto(BASE + '/wallets', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Create preset' }).first().click()
  const modal = page.getByRole('dialog', { name: 'Create preset' })
  await modal.getByRole('button', { name: 'Create preset' }).click()
  await modal.getByText('Give the preset a name').waitFor()
  await modal.getByLabel('Name').fill('scalp')
  await modal.getByText('Wallet 07').click()
  await modal.getByText('Wallet 08').click()
  await modal.getByRole('button', { name: 'Create preset' }).click()
  await visible(page, 'Preset SCALP created')
  await page.getByRole('button', { name: 'Duplicate SCALP' }).click()
  await visible(page, 'SCALP COPY')
  await page.getByRole('button', { name: 'Delete SCALP COPY' }).click()
  await page
    .getByRole('dialog', { name: /Delete SCALP COPY/ })
    .getByRole('button', { name: 'Delete preset' })
    .click()
  await visible(page, 'Preset SCALP COPY deleted')
})

await step('limit orders: place then cancel', async () => {
  await page.goto(BASE + '/limit-orders', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: '−10%' }).click()
  await page.getByLabel('Spend').fill('12')
  await page.getByRole('button', { name: /Place limit buy/i }).click()
  await visible(page, /Limit buy placed for BLACKDRAGON/)
  await page.getByRole('tab', { name: /Open orders 4/ }).waitFor()
  await page.getByRole('button', { name: 'Cancel' }).first().click()
  await page.getByRole('status').filter({ hasText: 'Limit buy cancelled' }).waitFor()
})

await step('limit orders: stop loss above market is rejected', async () => {
  await page.getByRole('radio', { name: 'Sell' }).click()
  await page.getByRole('radio', { name: 'Stop loss' }).click()
  await page.getByRole('button', { name: '+10%' }).click()
  await visible(page, 'A stop loss sits below the current price')
})

await step('DCA: summary sentence and create', async () => {
  await page.goto(BASE + '/dca', { waitUntil: 'networkidle' })
  await visible(page, 'every 4 hours')
  await page.getByRole('radio', { name: '1D' }).click()
  await visible(page, 'every day')
  await page.getByRole('button', { name: 'Create DCA' }).click()
  await visible(page, /DCA plan saved/)
  await page.getByText('1 day').first().waitFor()
})

await step('copy trade: validates target, creates rule', async () => {
  await page.goto(BASE + '/copy-trade', { waitUntil: 'networkidle' })
  await visible(page, 'No copy rules yet')
  await page.getByLabel('Target wallet').fill('Trader.near')
  await page.getByLabel('Target wallet').blur()
  await visible(page, 'Account IDs are lowercase')
  await page.getByLabel('Target wallet').fill('trader.near')
  await page.getByLabel('Token blacklist').fill('shitzu')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Remove SHITZU' }).waitFor()
  await page.getByRole('button', { name: 'Create copy rule' }).click()
  await visible(page, 'Copy rule saved for trader.near')
})

await step('sniper: saves config, arm stays unavailable', async () => {
  await page.goto(BASE + '/sniper', { waitUntil: 'networkidle' })
  await page.getByLabel('Token contract or symbol').fill('launch.token.near')
  await page.getByRole('button', { name: 'Save config' }).click()
  await visible(page, 'Sniper config saved for launch.token.near')
  if (await page.getByRole('button', { name: 'Arm sniper' }).isEnabled()) throw new Error('Arm sniper should be disabled')
})

await step('scanner: sample report, real token and unknown states', async () => {
  await page.goto(BASE + '/scanner', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'orbit.sample.near' }).click()
  await visible(page, 'Top 10 hold 38.4% of supply')
  await page.getByLabel('Token contract or symbol').fill('BLACKDRAGON')
  await page.getByRole('button', { name: 'Scan', exact: true }).click()
  await visible(page, 'No demo scan data for BLACKDRAGON')
  await page.getByLabel('Token contract or symbol').fill('nothing.near')
  await page.getByRole('button', { name: 'Scan', exact: true }).click()
  await visible(page, /Nothing found for/)
  const text = await page.locator('main').innerText()
  if (/\b(SAFE|SCAM)\b/.test(text)) throw new Error('Scanner must not print SAFE/SCAM verdicts')
})

await step('PnL: cursor handle moves with the keyboard', async () => {
  await page.goto(BASE + '/pnl', { waitUntil: 'networkidle' })
  const handle = page.getByRole('slider', { name: 'Cursor A' })
  const before = await handle.getAttribute('aria-valuenow')
  await handle.focus()
  await page.keyboard.press('Shift+ArrowRight')
  const after = await handle.getAttribute('aria-valuenow')
  if (Number(after) !== Number(before) + 7) throw new Error(`cursor moved ${before} → ${after}`)
  await page.getByRole('radio', { name: '30D' }).click()
  await page.getByText('Δ PnL (B − A)').waitFor()
})

await step('$KIT and Telegram show placeholders, no invented stats', async () => {
  await page.goto(BASE + '/kit', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Trade $KIT' }).click()
  await visible(page, 'Trading $KIT opens at launch')
  const kit = await page.locator('main').innerText()
  if (/\$\d/.test(kit)) throw new Error('$KIT page shows a dollar figure')
  // The demo has no bot server: the page says so, offers no bot button and shows no figures.
  await page.goto(BASE + '/telegram', { waitUntil: 'networkidle' })
  await visible(page, 'no NEARKITS bot server is connected to this build yet')
  if (await page.getByRole('button', { name: /Open .*bot/i }).count()) throw new Error('Telegram page offers a bot that is not connected')
  const telegram = await page.locator('main').innerText()
  if (/\$\d|≈\s?\d/.test(telegram)) throw new Error('Telegram page shows invented figures')
})

await step('disconnect shows connect states; demo account reconnects', async () => {
  await page.goto(BASE + '/', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /demo-trader\.near/ }).click()
  await page.getByRole('menuitem', { name: 'Disconnect' }).click()
  await page.getByRole('button', { name: 'Connect wallet' }).first().waitFor()
  // A reload re-seeds the demo session, so stay client-side.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Split' }).click()
  await visible(page, 'Connect a wallet to use Split')
  await shot(page, 'disconnected-split')
  await page.getByRole('button', { name: 'Connect wallet' }).last().click()
  const modal = page.getByRole('dialog', { name: 'Connect a wallet' })
  await modal.getByRole('button', { name: 'Use demo account' }).click()
  await visible(page, 'Demo account connected')
  await page.getByRole('heading', { name: 'Recipients' }).waitFor()
})

await step('settings: one-click mode fires without arming', async () => {
  await page.goto(BASE + '/settings', { waitUntil: 'networkidle' })
  // The NEAR MAX keeps back is the minimum wallet reserve, named apart from a transaction's refunded gas reserve.
  await visible(page, 'Minimum wallet reserve')
  if ((await page.getByText(/^Gas reserve$/).count()) !== 0) throw new Error('Settings still names it Gas reserve')
  await page.getByRole('switch', { name: 'Two-step confirmation' }).click()
  // Settings live in session state, so move client-side through the sidebar.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Dashboard' }).click()
  const ticket = page.locator('section', { has: page.getByRole('heading', { name: 'Quick trade' }) })
  await ticket.getByLabel('You pay').fill('3')
  await page.waitForTimeout(700)
  await ticket.getByRole('button', { name: /^Buy BLACKDRAGON$/i }).click()
  // One press goes straight to the review: no arming step.
  const review = page.getByRole('dialog', { name: 'Review buy' })
  await review.getByText('3 NEAR').first().waitFor({ timeout: 6000 })
  if (await ticket.getByText('Armed. Press again to confirm').isVisible()) throw new Error('one-click mode still armed')
  await review.getByRole('button', { name: /^Buy BLACKDRAGON$/i }).click()
  await visible(page, /Simulated · Buy BLACKDRAGON/)
})

await step('404 route renders inside the shell', async () => {
  await page.goto(BASE + '/definitely-not-here', { waitUntil: 'networkidle' })
  await visible(page, 'No panel at this address')
})

// ─── phone ────────────────────────────────────────────────────────────────
const phone = await newPage(390, 844)

await step('phone: tab bar, drawer navigation and trade access', async () => {
  await phone.goto(BASE + '/', { waitUntil: 'networkidle' })
  await phone.getByRole('navigation', { name: 'Quick navigation' }).waitFor()
  await phone.getByRole('heading', { name: 'Quick trade' }).waitFor()
  await phone.getByRole('button', { name: 'Open navigation' }).click()
  const drawer = phone.getByRole('dialog', { name: 'Navigation' })
  await drawer.getByRole('link', { name: 'Scanner' }).click()
  await phone.waitForURL(/\/scanner$/)
  await drawer.waitFor({ state: 'hidden' })
  await phone.getByRole('navigation', { name: 'Quick navigation' }).getByRole('link', { name: 'Positions' }).click()
  await phone.getByRole('button', { name: 'Buy KIT' }).click()
  await phone.getByRole('dialog', { name: 'Trade ticket' }).getByText('Trade KIT').waitFor()
  await shot(phone, 'phone-trade-sheet')
})

await browser.close()
console.log(results.join('\n'))
console.log(`\n${passed} passed`)
if (errors.length) {
  console.log('console/page errors:\n  ' + errors.join('\n  '))
  process.exit(1)
}
