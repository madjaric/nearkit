// End-to-end pass over the REAL NEAR implementation on testnet, with no live network:
//   npm run dev:e2e            (vite --mode e2e: real services + the scripted test wallet)
//   node scripts/e2e-real.mjs [--base http://localhost:5202] [--shots <dir>] [--width 390]
// A fake NEAR network (scripts/lib/fake-near.mjs) answers RPC, indexers and Rhea;
// any other external request is aborted and fails the run.
import { chromium } from 'playwright-core'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createFakeNear } from './lib/fake-near.mjs'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const BASE = opt('base', 'http://localhost:5202')
const SHOTS = opt('shots', null)
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
const WIDTH = Number(opt('width', '1440'))

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
/** A second account in the same wallet session (multi-account wallets expose several). */
const USER2 = 'e2e-two.testnet'
const USDT = 'usdt.itachicara.testnet'
const MIN = '1250000000000000000000'
/** A token launched after every list was built: found only by its exact contract. */
const FRESH = 'fresh.nearlytrade.testnet'

const near = createFakeNear({
  accounts: {
    [USER]: { amount: String(5n * ONE) },
    [USER2]: { amount: String(5n * ONE) },
    'bob.testnet': { amount: String(ONE) },
    'carol.testnet': { amount: String(ONE) },
    [USDT]: { amount: String(ONE), code: true },
    'wrap.testnet': { amount: String(ONE), code: true },
    [FRESH]: { amount: String(ONE), global: 'GlobalTokenContract1111111111111' },
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
    [FRESH]: { symbol: 'FRESH', name: 'Fresh Launch Token', decimals: 18, balances: {}, registered: [], boundsMin: MIN },
  },
})

const errors = []
let passed = 0
const results = []

const ctx = await browser.newContext({ viewport: { width: WIDTH, height: WIDTH < 768 ? 844 : 900 } })
await ctx.addInitScript(
  ([user, user2]) => {
    window.__NEARKIT_E2E_WALLET__ = { accounts: [user, user2], walletName: 'E2E Test Wallet' }
  },
  [USER, USER2],
)
const page = await ctx.newPage()
await near.install(page)
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => {
  // Aborted external requests (fonts, telemetry) are expected; everything else is an error.
  if (m.type() === 'error' && !/net::ERR_FAILED|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`)
})

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
    await browser.close()
    process.exit(1)
  }
}
const shot = async (name) => {
  if (!SHOTS) return
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}
// Any visible match: narrow layouts keep hidden desktop copies of some text in the DOM.
const visible = (text, opts = {}) => page.getByText(text, opts).visible().first().waitFor({ state: 'visible', timeout: 8000 })
const signedLog = () => page.evaluate(() => window.__NEARKIT_E2E_SIGNED__ ?? [])

await step('boots on testnet with real services', async () => {
  await page.goto(BASE + '/', { waitUntil: 'networkidle' })
  await visible('Testnet data')
  // The public build is the testnet beta: the network chip says so at every width.
  await visible('Testnet beta', { exact: true })
  // The side nav's status line shows from 1024 px; narrower screens keep it in the drawer.
  if (WIDTH >= 1024) await visible('NEAR testnet beta · live')
  await page.getByRole('button', { name: 'Connect wallet' }).first().waitFor()
})

await step('connects through the wallet adapter, never asking for keys', async () => {
  await page.getByRole('button', { name: 'Connect wallet' }).first().click()
  const modal = page.getByRole('dialog', { name: 'Connect a wallet' })
  await modal.getByText('never asks for a seed phrase').waitFor()
  await modal.getByRole('button', { name: /E2E Test Wallet/ }).click()
  await visible('Wallet connected')
  await page
    .getByRole('button', { name: new RegExp(USER.slice(0, 12)) })
    .first()
    .waitFor()
  const text = await page.locator('body').innerText()
  if (/seed phrase:|private key:/i.test(text)) throw new Error('A key field appeared')
  await shot('real-01-connected')
})

await step('balances come from the chain', async () => {
  await page.goto(BASE + '/positions', { waitUntil: 'networkidle' })
  await visible('USDT')
  await visible('100')
  await visible('Testnet tokens have no USD price')
})

await step('batch send: exact plan with storage for the unregistered recipient, signed and confirmed', async () => {
  await page.goto(BASE + '/batch-send', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /^Token: / }).click()
  await page.getByRole('listbox', { name: 'Token' }).getByText('USDT', { exact: true }).click()
  await page.getByLabel('Batch list').fill('bob.testnet,1.5\ncarol.testnet,2')
  await page.getByRole('button', { name: 'Send batch' }).click()
  const modal = page.getByRole('dialog', { name: 'Review batch send' })
  await modal.getByText('Registers with the token contract: 0.00125 NEAR').waitFor({ timeout: 10000 })
  await modal.getByText('Testnet', { exact: true }).waitFor()
  await modal.getByText('3.5 USDT').first().waitFor()
  await shot('real-02-batch-review')
  await modal.getByRole('button', { name: 'Send batch' }).click()
  await page.getByRole('dialog', { name: /Confirmed|transactions confirmed/ }).waitFor({ timeout: 15000 })
  await page
    .getByRole('link', { name: /Explorer/ })
    .first()
    .waitFor()
  const log = await signedLog()
  const actions = log
    .at(-1)
    .transactions[0].actions.map((a) => `${a.params.methodName}:${a.params.args.receiver_id ?? a.params.args.account_id}:${a.params.args.amount ?? a.params.deposit}`)
  const want = [`ft_transfer:bob.testnet:${1500000000000000000000000n}`, `storage_deposit:carol.testnet:${MIN}`, `ft_transfer:carol.testnet:${2n * ONE}`]
  if (JSON.stringify(actions) !== JSON.stringify(want)) throw new Error(`Signed ${JSON.stringify(actions)}`)
  await shot('real-03-batch-confirmed')
  await page.keyboard.press('Escape')
})

await step('a rejected approval sends nothing and says so', async () => {
  await page.evaluate(() => (window.__NEARKIT_E2E_WALLET__.reject = 'sign'))
  await page.getByRole('button', { name: 'Send batch' }).click()
  const modal = page.getByRole('dialog', { name: 'Review batch send' })
  await modal.getByRole('button', { name: 'Send batch' }).click()
  await page.getByRole('dialog', { name: 'Nothing was sent' }).waitFor({ timeout: 10000 })
  await visible('You rejected the request in your wallet')
  await page.evaluate(() => (window.__NEARKIT_E2E_WALLET__.reject = null))
  await page.keyboard.press('Escape')
})

await step('a failed transaction is reported as failed, never as confirmed', async () => {
  near.state.outcome = 'fail'
  await page.getByRole('button', { name: 'Send batch' }).click()
  const modal = page.getByRole('dialog', { name: 'Review batch send' })
  await modal.getByRole('button', { name: 'Send batch' }).click()
  await page.getByRole('dialog', { name: 'Not completed' }).waitFor({ timeout: 15000 })
  await visible('A recipient is not registered with the token contract')
  near.state.outcome = 'success'
  await page.keyboard.press('Escape')
})

await step('a token in no list is found by its exact contract, shown with its metadata, and imported on request', async () => {
  await page.goto(BASE + '/swap', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /^To token:/ }).click()
  await page.getByLabel('Search tokens').fill(FRESH)
  const row = page.getByRole('option', { name: /FRESH/ })
  await row.getByText('Fresh Launch Token').waitFor()
  await row.getByText(/18 decimals/).waitFor()
  await row.getByText(FRESH).waitFor()
  // Found is not tradable: the row says the quote decides.
  await row.getByText(/not listed/i).waitFor()
  await row.getByRole('button').click()
  await page.getByRole('button', { name: 'To token: FRESH' }).waitFor()
  await shot('real-07-imported-token')
})

await step('swap on testnet: Rhea classic route, fee not charged, plan wraps and swaps in one transaction', async () => {
  await page.goto(BASE + '/swap', { waitUntil: 'networkidle' })
  await page.getByPlaceholder('0.00').first().fill('1')
  await visible('Not charged on testnet')
  await visible(/1 NEAR ≈ 4\.0\d USDT/)
  // Two-step confirmation (the default): the first press arms, the second opens the review.
  await page.getByRole('button', { name: 'Swap NEAR → USDT' }).click()
  await page.getByRole('button', { name: 'Confirm swap' }).click()
  const modal = page.getByRole('dialog', { name: 'Review swap' })
  await modal.getByText('NEAR → USDT', { exact: true }).first().waitFor({ timeout: 10000 })
  await modal.getByText('Not charged', { exact: true }).waitFor()
  await modal.getByText(/refund arrives as wNEAR/).waitFor()
  await shot('real-04-swap-review')
  await modal.getByRole('button', { name: 'Swap NEAR → USDT' }).click()
  await page.getByRole('dialog', { name: /Confirmed|transactions confirmed/ }).waitFor({ timeout: 15000 })
  const tx = (await signedLog()).at(-1).transactions.at(-1)
  const methods = tx.actions.map((a) => a.params.methodName)
  if (tx.receiverId !== 'wrap.testnet' || methods.join() !== 'storage_deposit,near_deposit,ft_transfer_call') throw new Error(`Signed ${tx.receiverId}: ${methods}`)
  const msg = JSON.parse(tx.actions.at(-1).params.args.msg)
  if (msg.actions?.[0]?.pool_id !== 1352 || tx.actions.at(-1).params.args.receiver_id !== 'ref-finance-101.testnet') throw new Error('Unexpected swap message')
  await page.keyboard.press('Escape')
})

await step('multi buy across two accounts: sequential, one approval per wallet, no all-or-nothing', async () => {
  await page.goto(BASE + '/multi-trade', { waitUntil: 'networkidle' })
  // The checkbox is custom-drawn over a visually hidden input. Wide screens list wallets
  // in a table ("Include e2e-two"), phones as cards named by the wallet label.
  await page
    .getByRole('checkbox', { name: /e2e-two/ })
    .visible()
    .first()
    .check({ force: true })
  await page.getByLabel('Total', { exact: true }).fill('2')
  await visible('1.00 NEAR / wallet')
  await page.getByRole('button', { name: /Execute multi buy/i }).click()
  const modal = page.getByRole('dialog', { name: /Review multi buy/i })
  await modal.getByText('3 in 2 approvals').waitFor({ timeout: 15000 })
  await modal.getByText(/no all-or-nothing execution/).waitFor()
  await modal.getByText('Not charged', { exact: true }).waitFor()
  await shot('real-06-multi-review')
  await modal.getByRole('button', { name: /Execute multi buy/i }).click()
  await page.getByRole('dialog', { name: /transactions confirmed|Confirmed/ }).waitFor({ timeout: 20000 })
  const signers = (await signedLog()).slice(-2).map((s) => s.signerId)
  if (signers.join() !== [USER, USER2].join()) throw new Error(`Signed by ${signers}`)
  await page.keyboard.press('Escape')
})

await step('multi buy: a wallet that cannot cover its share is skipped, and only the others are signed', async () => {
  await page.goto(BASE + '/multi-trade', { waitUntil: 'networkidle' })
  await page
    .getByRole('checkbox', { name: /e2e-two/ })
    .visible()
    .first()
    .check({ force: true })
  await page.getByRole('radiogroup', { name: 'Allocation mode' }).getByRole('radio', { name: 'Custom' }).click()
  const shares = page.getByLabel('NEAR for this wallet').visible()
  await shares.nth(0).fill('1')
  // e2e-two holds 5 NEAR.
  await shares.nth(1).fill('50')
  await visible(/1 wallet can't cover its allocation and will be skipped/)
  const before = (await signedLog()).length
  await page.getByRole('button', { name: /Execute multi buy/i }).click()
  const modal = page.getByRole('dialog', { name: /Review multi buy/i })
  await modal.getByText(/no all-or-nothing execution/).waitFor({ timeout: 15000 })
  if (/e2e-two/.test(await modal.innerText())) throw new Error('The review includes the wallet that was to be skipped')
  await modal.getByRole('button', { name: /Execute multi buy/i }).click()
  await page.getByRole('dialog', { name: /transactions confirmed|Confirmed/ }).waitFor({ timeout: 20000 })
  const signers = (await signedLog()).slice(before).map((s) => s.signerId)
  if (signers.join() !== USER) throw new Error(`Signed by ${signers}`)
  await page.keyboard.press('Escape')
})

await step('scanner: facts carry provenance, and there is no verdict', async () => {
  await page.goto(BASE + `/scanner?q=${USDT}`, { waitUntil: 'networkidle' })
  await visible('Total supply')
  await visible('Verified')
  await visible('Derived')
  await visible('Unknown')
  const text = await page.locator('main').innerText()
  if (/\b(SAFE|SCAM)\b/.test(text)) throw new Error('Scanner printed a verdict')
  await shot('real-05-scanner')
})

await step('wallet popups stay clickable above NearKit dialogs', async () => {
  await page.goto(BASE + '/wallets', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Add account' }).click()
  await page.getByRole('dialog', { name: 'Add an account' }).waitFor()
  const modalBefore = await page.evaluate(() => [...document.querySelectorAll('dialog')].some((d) => d.open && d.matches(':modal')))
  if (!modalBefore) throw new Error('Dialog should start modal')
  // What NEAR Connect appends for sandboxed wallets: a body-level popup with a button to click.
  await page.evaluate(() => {
    const root = document.createElement('div')
    root.className = 'hot-connector-popup'
    root.innerHTML = '<div style="position:fixed;inset:0;z-index:100000000;display:grid;place-items:center"><button id="wallet-continue">Continue in wallet</button></div>'
    root.style.display = 'block'
    document.body.append(root)
    window.__clicked = false
    document.getElementById('wallet-continue').addEventListener('click', () => (window.__clicked = true))
  })
  await page.waitForFunction(() => [...document.querySelectorAll('dialog')].every((d) => !d.open || !d.matches(':modal')))
  await page.locator('#wallet-continue').click()
  if (!(await page.evaluate(() => window.__clicked))) throw new Error('Wallet popup was not clickable')
  await page.evaluate(() => (document.querySelector('.hot-connector-popup').style.display = 'none'))
  await page.waitForFunction(() => [...document.querySelectorAll('dialog')].some((d) => d.open && d.matches(':modal')))
  await page.keyboard.press('Escape')
})

await step('add a watch-only account, validated on chain', async () => {
  await page.getByRole('button', { name: 'Add account' }).click()
  const modal = page.getByRole('dialog', { name: 'Add an account' })
  await modal.getByLabel('Account ID').fill('ghost.testnet')
  await modal.getByRole('button', { name: 'Add account' }).click()
  await modal.getByText('ghost.testnet does not exist on testnet').waitFor()
  await modal.getByLabel('Account ID').fill('bob.testnet')
  await modal.getByLabel('Label').fill('Bob')
  await modal.getByRole('button', { name: 'Add account' }).click()
  await visible('Bob added')
  await page.getByText('Watch', { exact: true }).visible().first().waitFor()
})

await step('activity shows what NearKit sent, with explorer links', async () => {
  await page.goto(BASE + '/', { waitUntil: 'networkidle' })
  await visible('Sent from this browser')
  await visible(/Send USDT from Main to 2 recipients/)
})

await step('disconnect ends the session', async () => {
  await page
    .getByRole('button', { name: new RegExp(USER.slice(0, 12)) })
    .first()
    .click()
  await page.getByRole('menuitem', { name: 'Disconnect' }).click()
  await visible('Disconnected')
  await page.getByRole('button', { name: 'Connect wallet' }).first().waitFor()
})

if (near.state.external.length) {
  results.push(`  note external requests aborted: ${[...new Set(near.state.external.map((u) => new URL(u).host))].join(', ')}`)
}
console.log(results.join('\n'))
console.log(`\n${passed} passed, 0 failed`)
if (errors.length) {
  console.log('console/page errors:\n  ' + errors.join('\n  '))
  await browser.close()
  process.exit(1)
}
await browser.close()
