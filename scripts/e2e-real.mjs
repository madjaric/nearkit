// End-to-end pass over the REAL NEAR implementation on testnet, with no live network:
//   npm run dev:e2e            (vite --mode e2e: real services + the scripted test wallet)
//   node scripts/e2e-real.mjs [--base http://localhost:5202] [--shots <dir>] [--width 390]
// A fake NEAR network (scripts/lib/fake-near.mjs) answers RPC, indexers and Rhea;
// any other external request is aborted and fails the run.
import { chromium } from 'playwright-core'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
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
/** Ref's DCL exchange on testnet, where FRESH has its only pool (Rhea's router knows nothing of it). */
const DCL = 'dclv2.ref-dev.testnet'
const POOL = `${FRESH}|wrap.testnet|10000`

const near = createFakeNear({
  accounts: {
    [USER]: { amount: String(5n * ONE) },
    [USER2]: { amount: String(5n * ONE) },
    'bob.testnet': { amount: String(ONE) },
    'carol.testnet': { amount: String(ONE) },
    [USDT]: { amount: String(ONE), code: true },
    'wrap.testnet': { amount: String(ONE), code: true },
    [FRESH]: { amount: String(ONE), global: 'GlobalTokenContract1111111111111' },
    [DCL]: { amount: String(ONE), code: true },
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
  // 1 wNEAR (24 decimals) buys 1,000 FRESH (18 decimals), less the pool's 1% fee; and back.
  dcl: {
    contract: DCL,
    pools: {
      [POOL]: {
        tokenX: FRESH,
        tokenY: 'wrap.testnet',
        fee: 10000,
        liquidity: '100000000000000000000000',
        rate: (tokenIn, amountIn) => ((tokenIn === 'wrap.testnet' ? amountIn / 1000n : amountIn * 1000n) * 99n) / 100n,
      },
    },
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

await step('the top-bar search finds a token in no list by its exact contract and opens its Token Detail, not the swap', async () => {
  await page.goto(BASE + '/', { waitUntil: 'networkidle' })
  await page.getByLabel('Search token, contract or command').fill(FRESH)
  const row = page.getByRole('option', { name: /Fresh Launch Token/ })
  await row.getByText('Fresh Launch Token · 18 decimals · not in your list').waitFor()
  await row.click()
  await page.waitForURL(/\/token\/fresh\.nearlytrade\.testnet$/)
  // The page reads it from chain and offers to add it to the user's own list; nothing is imported until asked.
  await page.getByText('Not in your token list').first().waitFor()
  await page.getByRole('button', { name: 'Add FRESH' }).waitFor()
  await page.getByText('No recent trading activity available.').waitFor()
})

await step('the top-bar search: a symbol and a name open Token Detail; an address that isn’t a token says Token not found', async () => {
  const search = page.getByLabel('Search token, contract or command')
  await search.fill('usdt')
  const usdt = page.getByRole('option', { name: /USDT/ }).first()
  await usdt.getByText(USDT, { exact: false }).waitFor()
  await usdt.click()
  await page.waitForURL(/\/token\/usdt\.itachicara\.testnet$/)
  await search.fill('tether')
  await page.getByRole('option', { name: /USDT/ }).first().click()
  await page.waitForURL(/\/token\/usdt\.itachicara\.testnet$/)
  await search.fill('ghost.testnet')
  await page.getByRole('option', { name: /Token not found/ }).waitFor()
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
  // Found is not "tradable": the row says only that it isn't in the user's list.
  await row.getByText(/not in your list/i).waitFor()
  await row.getByRole('button').click()
  await page.getByRole('button', { name: 'To token: FRESH' }).waitFor()
  await shot('real-07-imported-token')
})

await step('swap on testnet: Rhea classic route, fee not charged, plan wraps and swaps in one transaction', async () => {
  await page.goto(BASE + '/swap', { waitUntil: 'networkidle' })
  await page.getByPlaceholder('0.00').first().fill('1')
  await visible('Not charged on testnet')
  await visible('Actual network fee (est.)')
  await visible(/1 NEAR ≈ 4\.0\d USDT/)
  // Two-step confirmation (the default): the first press arms, the second opens the review.
  await page.getByRole('button', { name: 'Swap NEAR → USDT' }).click()
  await page.getByRole('button', { name: 'Confirm swap' }).click()
  const modal = page.getByRole('dialog', { name: 'Review swap' })
  // The review names the route and its source.
  await modal.getByText('NEAR → USDT · Rhea', { exact: true }).first().waitFor({ timeout: 10000 })
  await modal.getByText('Not charged', { exact: true }).waitFor()
  await modal.getByText(/refund arrives as wNEAR/).waitFor()
  // The gas reserve is named and explained as held and refunded, never as a fee.
  await modal.getByText('Gas reserve (refunded)').first().waitFor()
  await modal.getByText('Temporarily held while the transaction runs. Unused gas is refunded automatically.').first().waitFor()
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

await step('a token outside every list trades on DCL: the pair’s pool read from chain, the review says DCL, fee not charged, the swap goes to the DCL contract', async () => {
  await page.goto(BASE + `/token/${FRESH}`, { waitUntil: 'networkidle' })
  await page.locator('main').getByRole('button', { name: 'Buy FRESH' }).click()
  const sheet = page.getByRole('dialog', { name: 'Trade ticket' })
  await sheet.getByText('Trade FRESH').waitFor()
  await sheet.getByPlaceholder('0.00').first().fill('1')
  // Rhea's router has no path for FRESH; the DCL pool pays 1,000 per NEAR less its 1% fee.
  await sheet
    .getByText(/1 NEAR ≈ 990 FRESH/)
    .first()
    .waitFor({ timeout: 10000 })
  await sheet.getByText('Not charged on testnet').first().waitFor()
  // Two-step fire: the first press arms, the second opens the review.
  await sheet.getByRole('button', { name: 'Buy FRESH' }).click()
  await sheet.getByRole('button', { name: 'Confirm buy FRESH' }).click()
  const modal = page.getByRole('dialog', { name: 'Review buy' })
  await modal.getByText('NEAR → FRESH · DCL', { exact: true }).first().waitFor({ timeout: 10000 })
  await shot('real-04b-dcl-review')
  await modal.getByRole('button', { name: 'Buy FRESH' }).click()
  await page.getByRole('dialog', { name: /Confirmed|transactions confirmed/ }).waitFor({ timeout: 15000 })
  const txs = (await signedLog()).at(-1).transactions
  const swap = txs.at(-1)
  const methods = swap.actions.map((a) => a.params.methodName)
  if (swap.receiverId !== 'wrap.testnet' || methods.join() !== 'storage_deposit,near_deposit,ft_transfer_call') throw new Error(`Signed ${swap.receiverId}: ${methods}`)
  const call = swap.actions.at(-1).params.args
  const msg = JSON.parse(call.msg)
  if (call.receiver_id !== DCL || msg.Swap?.pool_ids?.[0] !== POOL || msg.Swap?.output_token !== FRESH) throw new Error(`Unexpected DCL swap: ${call.msg}`)
  if (txs.length !== 2 || txs[0].receiverId !== FRESH || txs[0].actions[0].params.methodName !== 'storage_deposit')
    throw new Error('Expected the wallet’s registration on FRESH first')
  await page.keyboard.press('Escape')
  await sheet.waitFor({ state: 'hidden' })
})

await step('…and sells it on DCL: the pool pays wNEAR, unwrapped to NEAR by the exchange, in one transaction on the token', async () => {
  const fresh = near.state.tokens.get(FRESH)
  fresh.balances.set(USER, String(1000n * 10n ** 18n))
  fresh.registered.add(USER)
  await page.goto(BASE + `/token/${FRESH}`, { waitUntil: 'networkidle' })
  await page.locator('main').getByRole('button', { name: 'Sell FRESH' }).click()
  const sheet = page.getByRole('dialog', { name: 'Trade ticket' })
  await sheet.getByText('Trade FRESH').waitFor()
  await sheet.getByPlaceholder('0.00').first().fill('100')
  await sheet
    .getByText(/0\.099/)
    .first()
    .waitFor({ timeout: 10000 })
  await sheet.getByRole('button', { name: 'Sell FRESH' }).click()
  await sheet.getByRole('button', { name: 'Confirm sell FRESH' }).click()
  const modal = page.getByRole('dialog', { name: 'Review sell' })
  await modal.getByText('FRESH → NEAR · DCL', { exact: true }).first().waitFor({ timeout: 10000 })
  await modal.getByRole('button', { name: 'Sell FRESH' }).click()
  await page.getByRole('dialog', { name: /Confirmed|transactions confirmed/ }).waitFor({ timeout: 15000 })
  const tx = (await signedLog()).at(-1).transactions.at(-1)
  const call = tx.actions.at(-1).params
  const msg = JSON.parse(call.args.msg)
  if (tx.receiverId !== FRESH || call.methodName !== 'ft_transfer_call' || call.args.receiver_id !== DCL || msg.Swap?.output_token !== 'wrap.testnet' || msg.Swap?.skip_unwrap_near)
    throw new Error(`Unexpected DCL sell: ${call.args.msg}`)
  await page.keyboard.press('Escape')
  await sheet.waitFor({ state: 'hidden' })
})

await step('after a confirmed swap the balances refresh on their own, with no reload: "Updating balances…" meanwhile', async () => {
  await page.goto(BASE + '/swap', { waitUntil: 'networkidle' })
  const usdt = near.state.tokens.get(USDT)
  const before = BigInt(usdt.balances.get(USER) ?? '0')
  await page.getByPlaceholder('0.00').first().fill('1')
  await visible(/1 NEAR ≈ 4\.0\d USDT/)
  const shown = (units) => new RegExp(`Balance\\s*${units}(\\.0+)?\\s*USDT`)
  await visible(shown(String(before / ONE)))
  let reloads = 0
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) reloads++
  })
  await page.getByRole('button', { name: 'Swap NEAR → USDT' }).click()
  await page.getByRole('button', { name: 'Confirm swap' }).click()
  const modal = page.getByRole('dialog', { name: 'Review swap' })
  await modal.getByRole('button', { name: 'Swap NEAR → USDT' }).waitFor({ timeout: 10000 })
  await modal.getByRole('button', { name: 'Swap NEAR → USDT' }).click()
  await page.getByRole('dialog', { name: /Confirmed|transactions confirmed/ }).waitFor({ timeout: 15000 })
  // The chain's readers lag behind the confirmation: the new balance shows up a moment later.
  setTimeout(() => usdt.balances.set(USER, String(before + 4n * ONE)), 1500)
  await page.getByRole('status').filter({ hasText: 'Updating balances…' }).first().waitFor({ timeout: 5000 })
  await shot('real-05-updating-balances')
  await page.keyboard.press('Escape')
  await page
    .getByText(shown(String(before / ONE + 4n)))
    .first()
    .waitFor({ state: 'visible', timeout: 20000 })
  await page.getByRole('status').filter({ hasText: 'Balances updated' }).first().waitFor({ timeout: 5000 })
  if (reloads) throw new Error(`the page navigated ${reloads} time(s) after the swap`)
  usdt.balances.set(USER, String(before))
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
  // Listed under Watch / Follow, tagged as never trading or sending.
  await page.getByText('Watch only', { exact: true }).visible().first().waitFor()
})

await step('the Wallets page copies a wallet’s full account id, the watched one too', async () => {
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto(BASE + '/wallets', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Copy Main account' }).locator('visible=true').first().click()
  const main = await page.evaluate(() => navigator.clipboard.readText())
  if (main !== USER) throw new Error(`Copy Main account copied ${main}`)
  await page.getByRole('button', { name: 'Copy Bob account' }).locator('visible=true').first().click()
  const bob = await page.evaluate(() => navigator.clipboard.readText())
  if (bob !== 'bob.testnet') throw new Error(`Copy Bob account copied ${bob}`)
})

await step('the dashboard counts executable wallets only: the watched account is listed, never summed', async () => {
  await page.goto(BASE + '/', { waitUntil: 'networkidle' })
  await visible(/2 executable · 1 watch-only/)
  await visible(/2 executable wallets · /)
})

await step('a watch-only account never joins a Multi Buy or a preset: not offered, and said so', async () => {
  await page.goto(BASE + '/multi-trade', { waitUntil: 'networkidle' })
  await visible('1 watch-only wallet is not listed: watch-only wallets can’t trade.')
  if ((await page.getByRole('checkbox', { name: /Bob/ }).count()) !== 0) throw new Error('Bob (watch-only) is offered in Multi Buy')
  await page.goto(BASE + '/wallets', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Create preset' }).first().click()
  const modal = page.getByRole('dialog', { name: 'Create preset' })
  if (!(await modal.getByRole('checkbox', { name: /Bob/ }).isDisabled())) throw new Error('Bob (watch-only) can be put in a preset')
  await page.keyboard.press('Escape')
})

await step('activity shows what NearKit sent, with explorer links', async () => {
  await page.goto(BASE + '/', { waitUntil: 'networkidle' })
  await visible('Sent from this browser')
  // The Dashboard lists the latest six operations: the DCL sell and buy are the newest.
  await visible(/100 FRESH → min 0\.09801 NEAR/)
  await visible(/1 NEAR → min 980\.1 FRESH/)
})

await step('PnL card: the figures on screen, exported as a PNG', async () => {
  await page.goto(BASE + '/pnl', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Share card' }).click()
  const dialog = page.getByRole('dialog', { name: 'Share PnL card' })
  const card = dialog.getByRole('img', { name: /^PnL card: Portfolio, Last 90 days, Total PnL/ })
  await card.waitFor()
  const label = await card.getAttribute('aria-label')
  // The fake index has no history for a held token, so the card must say it is partial.
  if (!/Partial: .*history incomplete/.test(label ?? '')) throw new Error(`Card label: ${label}`)
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Download PNG' }).click()])
  if (download.suggestedFilename() !== 'nearkit-pnl-portfolio.png') throw new Error(`File is ${download.suggestedFilename()}`)
  const bytes = readFileSync(await download.path())
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.length < 10_000) throw new Error('Not a PNG card')
  await shot('real-pnl-card')
  await page.keyboard.press('Escape')
})

await step('token screen: a position opens it; with no price source it says so and draws nothing', async () => {
  await page.goto(BASE + '/positions', { waitUntil: 'networkidle' })
  await page.locator('main').getByRole('link', { name: 'USDT', exact: true }).visible().first().click()
  await page.waitForURL(/\/token\/usdt\.itachicara\.testnet$/)
  await visible('Price unavailable')
  await visible('Testnet has no market prices.')
  await visible('Price unavailable: nothing to draw.')
  await page.locator('main').getByText(USDT).first().waitFor()
  // No trade in the token's latest transactions on this network: said so, nothing invented.
  await visible('No recent trading activity available.')
  // No price source on testnet: no dollar figure anywhere, no FDV, no market cap.
  const text = await page.locator('main').innerText()
  if (/\$\s?\d/.test(text)) throw new Error('A dollar figure is shown with no price source')
  await shot('real-token-screen')
})

await step('token screen: Buy and Sell open the existing trade ticket with the token selected', async () => {
  for (const side of ['Buy', 'Sell']) {
    await page
      .locator('main')
      .getByRole('button', { name: `${side} USDT` })
      .click()
    const sheet = page.getByRole('dialog', { name: 'Trade ticket' })
    await sheet.getByText('Trade USDT').waitFor()
    if ((await sheet.getByRole('radio', { name: side }).getAttribute('aria-checked')) !== 'true') throw new Error(`${side} is not selected`)
    await sheet.getByRole('button', { name: 'Token: USDT' }).waitFor()
    await page.keyboard.press('Escape')
    await sheet.waitFor({ state: 'hidden' })
  }
})

await step('token screen: Send opens the existing send flow with the token and the wallet selected', async () => {
  await page.locator('main').getByRole('button', { name: 'Send USDT' }).click()
  // One connected account holding USDT goes straight to Batch Send; several get a chooser first.
  const chooser = page.getByRole('dialog', { name: 'Send USDT from…' })
  await Promise.race([chooser.waitFor({ timeout: 5000 }).catch(() => {}), page.waitForURL(/\/batch-send/, { timeout: 5000 }).catch(() => {})])
  if (await chooser.isVisible()) await chooser.getByRole('button', { name: 'Send', exact: true }).first().click()
  await page.waitForURL(/\/batch-send\?token=usdt\.itachicara\.testnet&from=/)
  await page.locator('main').getByRole('button', { name: 'Token: USDT' }).first().waitFor()
  await shot('real-token-send')
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
