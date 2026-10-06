// End-to-end: the Telegram bot and the web app together, as they run for real.
//   npm run e2e:telegram [-- --shots <dir>]
// Starts the built bot server (dist-server) and the web app (vite --mode e2e), with
// Telegram faked over HTTP (TELEGRAM_API_URL) and NEAR faked for both the server
// (NEAR_RPC_URL, plus a fetch guard that sends every other external request to the
// fake network) and the page (request routing). Nothing touches a live network, and
// the real bot token is never read (NEARKIT_ENV_FILE points nowhere).
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'
import { createFakeNear } from './lib/fake-near.mjs'
import { startFakeTelegram } from './lib/fake-telegram.mjs'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const SHOTS = opt('shots', null)
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
const ROOT = process.cwd()
const WEB_PORT = 5206
const API_PORT = 8799
const WEB = `http://localhost:${WEB_PORT}`
const TOKEN = '4242424242:E2E-fake-token-not-a-real-bot-000000000'
// A test-only key-encryption key: NearKit trading wallets are on for this server.
const KEK = Buffer.alloc(32, 9).toString('base64')
const ONE = 10n ** 24n
const USER = 'e2e-user.testnet'
const TG_USER = { id: 777, is_bot: false, first_name: 'Tess', username: 'tester' }
const TG_OTHER = { id: 888, is_bot: false, first_name: 'Other', username: 'other' }

// A real ed25519 key for the scripted wallet; its public key is a full-access key of USER on the fake chain.
const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const b58 = (bytes) => {
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  let s = ''
  while (n > 0n) ((s = B58[Number(n % 58n)] + s), (n /= 58n))
  // Each leading zero byte is a leading '1'.
  for (const b of bytes) {
    if (b !== 0) break
    s = '1' + s
  }
  return s
}
const PUBLIC_KEY = `ed25519:${b58(raw)}`
const appPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
const APP_KEY = `ed25519:${b58(new Uint8Array(await crypto.subtle.exportKey('raw', appPair.publicKey)))}`

const USDT = 'usdt.itachicara.testnet'
const MIN = '1250000000000000000000'
const near = createFakeNear({
  accounts: {
    [USER]: { amount: String(5n * ONE), keys: { [PUBLIC_KEY]: 'full', [APP_KEY]: 'function-call' } },
    'wrap.testnet': { amount: String(ONE), code: true },
    [USDT]: { amount: String(ONE), code: true },
    // The network's other known tokens: the signer reads each one itself before it erases a never-funded wallet's key.
    'usdc.itachicara.testnet': { amount: String(ONE), code: true },
    'ref.fakes.testnet': { amount: String(ONE), code: true },
  },
  tokens: {
    'wrap.testnet': { symbol: 'wNEAR', name: 'Wrapped NEAR', decimals: 24, balances: {}, registered: ['ref-finance-101.testnet'], boundsMin: MIN },
    [USDT]: { symbol: 'USDT', name: 'Tether USD', decimals: 24, balances: {}, registered: [USER, 'ref-finance-101.testnet'], boundsMin: MIN },
    'usdc.itachicara.testnet': { symbol: 'USDC', name: 'USD Coin', decimals: 6, balances: {}, registered: [], boundsMin: MIN },
    'ref.fakes.testnet': { symbol: 'REF', name: 'Ref Finance Token', decimals: 18, balances: {}, registered: [], boundsMin: MIN },
  },
})

// The fake network over HTTP for the server process: JSON-RPC at the root, and any other
// external host through /__proxy/<host>/<path> (see lib/fetch-guard.mjs).
const rpcServer = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const send = (status, json) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(json))
    }
    const proxied = /^\/__proxy\/([^/]+)(\/.*)?$/.exec(req.url ?? '')
    if (!proxied) return send(200, near.rpc(JSON.parse(body || '{}')))
    const url = new URL(`https://${proxied[1]}${proxied[2] ?? '/'}`)
    const r = near.respond({ url, method: req.method, body })
    if (r) return send(r.status, r.json)
    near.state.external.push(`server: ${url.href}`)
    send(502, { error: 'no live network in tests' })
  })
})
await new Promise((r) => rpcServer.listen(0, '127.0.0.1', r))
const RPC_URL = `http://127.0.0.1:${rpcServer.address().port}`
const tg = await startFakeTelegram({ token: TOKEN })

const vite = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
const build = spawnSync(process.execPath, [vite, 'build', '-c', 'vite.server.config.ts', '--logLevel', 'warn'], { cwd: ROOT, stdio: 'inherit' })
if (build.status !== 0) process.exit(1)

const data = mkdtempSync(join(tmpdir(), 'nearkit-e2e-tg-'))
const serverLog = []
const guard = pathToFileURL(join(ROOT, 'scripts', 'lib', 'fetch-guard.mjs')).href
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', guard, join(ROOT, 'dist-server', 'main.js')], {
  cwd: ROOT,
  env: {
    NEARKIT_E2E_FAKE_HTTP: RPC_URL,
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT,
    NEARKIT_ENV_FILE: join(data, 'no-such-file'),
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_API_URL: tg.url,
    NEAR_NETWORK: 'testnet',
    NEAR_RPC_URL: RPC_URL,
    NEARKIT_WEB_URL: WEB,
    NEARKIT_API_PORT: String(API_PORT),
    NEARKIT_DB_PATH: join(data, 'e2e.sqlite'),
    NEARKIT_WALLET_KEK: KEK,
    BUYBOT_ENABLED: 'false',
    LOG_LEVEL: 'warn',
  },
})
server.stdout.on('data', (d) => serverLog.push(String(d)))
server.stderr.on('data', (d) => serverLog.push(String(d)))
const web = spawn(process.execPath, [vite, '--mode', 'e2e', '--port', String(WEB_PORT), '--strictPort'], {
  cwd: ROOT,
  env: { ...process.env, VITE_NEARKIT_API_URL: `http://localhost:${API_PORT}`, VITE_TELEGRAM_BOT: 'NearKitTestBot' },
  stdio: 'ignore',
})

async function up(url) {
  for (let i = 0; i < 150; i++) {
    if (
      await fetch(url).then(
        (r) => r.ok,
        () => false,
      )
    )
      return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`${url} did not come up`)
}

const pw = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
const dir = existsSync(pw)
  ? readdirSync(pw)
      .filter((d) => d.startsWith('chromium-'))
      .sort()
      .pop()
  : null
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? (dir ? join(pw, dir, 'chrome-win64', 'chrome.exe') : undefined) })
const errors = []
const results = []
let passed = 0

async function finish(code) {
  await browser.close().catch(() => {})
  server.kill()
  web.kill()
  await tg.close()
  rpcServer.close()
  process.exit(code)
}

async function newPage(walletScript) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await ctx.addInitScript((script) => (window.__NEARKIT_E2E_WALLET__ = script), walletScript)
  const page = await ctx.newPage()
  await near.install(page)
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  if (process.env.E2E_DEBUG) {
    page.on('request', (r) => r.url().includes(':8799') && console.log('API >', r.method(), r.url(), r.postData()?.slice(0, 200)))
    page.on('response', async (r) => r.url().includes(':8799') && console.log('API <', r.status(), (await r.text().catch(() => '')).slice(0, 300)))
    page.on('console', (m) => console.log('console:', m.type(), m.text().slice(0, 200)))
  }
  page.on('console', (m) => {
    if (m.type() === 'error' && !/net::ERR_FAILED|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`)
  })
  return page
}

let page
async function step(name, fn) {
  try {
    await fn()
    passed += 1
    results.push(`  ok   ${name}`)
  } catch (e) {
    if (SHOTS && page) await page.screenshot({ path: join(SHOTS, 'FAILED-' + name.replace(/[^a-z0-9]+/gi, '-').slice(0, 40) + '.png') }).catch(() => {})
    results.push(`  FAIL ${name}\n       ${String(e.message).split('\n')[0]}`)
    console.log(results.join('\n'))
    console.log(`\n${passed} passed, 1 failed`)
    if (errors.length) console.log('console/page errors:\n  ' + errors.join('\n  '))
    if (serverLog.length) console.log('server log:\n' + serverLog.join('').slice(-3000))
    await finish(1)
  }
}
const shot = async (name) => SHOTS && page && page.screenshot({ path: join(SHOTS, `${name}.png`) })
const say = (user, text) =>
  tg.push({ message: { message_id: Math.floor(Math.random() * 1e6), date: 0, chat: { id: user.id, type: 'private', first_name: user.first_name }, from: user, text } })
const press = (user, data) =>
  tg.push({ callback_query: { id: `cb${Math.random()}`, from: user, data, message: { message_id: 1, date: 0, chat: { id: user.id, type: 'private' }, text: '' } } })

try {
  await up(`http://127.0.0.1:${API_PORT}/health`)
  await up(WEB)
  // Warm the dev server: the first visit to a page compiles it, which can outlast a step's timeout.
  const warm = await newPage({ accounts: [USER] })
  for (const path of ['/telegram', '/swap']) await warm.goto(WEB + path, { waitUntil: 'networkidle' })
  await warm.context().close()
} catch (e) {
  console.log(String(e.message))
  console.log(serverLog.join(''))
  await finish(1)
}

let linkUrl = ''
await step('the bot greets a new user and never asks for keys', async () => {
  const from = tg.sent.length
  say(TG_USER, '/start')
  const m = await tg.waitFor(TG_USER.id, (x) => x.text.includes('<b>NEARKITS</b> · NEAR trading'), { from })
  if (!/never asks for your seed phrase/.test(m.text)) throw new Error('safety line missing')
})

await step('/link answers with a one-time link to the web app', async () => {
  const from = tg.sent.length
  say(TG_USER, '/link')
  const m = await tg.waitFor(TG_USER.id, (x) => x.buttons.some((b) => b.url?.includes('/telegram#link=')), { from })
  linkUrl = m.buttons.find((b) => b.url).url
  if (!linkUrl.startsWith(`${WEB}/telegram#link=`)) throw new Error(`unexpected link ${linkUrl}`)
})

await step('the web page names the Telegram account and the exact message, then links after the wallet signs', async () => {
  page = await newPage({ accounts: [USER], walletName: 'E2E Test Wallet', signingKey: { jwk, publicKey: PUBLIC_KEY } })
  await page.goto(linkUrl, { waitUntil: 'networkidle' })
  await page.getByText('@tester').first().waitFor()
  await page.getByText('NearKit: link this NEAR account to Telegram').waitFor()
  await shot('tg-01-link-page')
  await page.getByRole('button', { name: 'Connect wallet to link' }).click()
  await page
    .getByRole('dialog', { name: 'Connect a wallet' })
    .getByRole('button', { name: /E2E Test Wallet/ })
    .click()
  await page.getByRole('button', { name: `Sign and link ${USER}` }).click()
  await page.getByText(`Linked ${USER} to Telegram @tester`).waitFor()
  const signed = await page.evaluate(() => window.__NEARKIT_E2E_MESSAGES__ ?? [])
  if (signed.length !== 1 || signed[0].recipient !== 'localhost' || signed[0].nonce.length !== 32) throw new Error(`unexpected signMessage call ${JSON.stringify(signed)}`)
  await shot('tg-02-linked')
})

await step('the bot confirms the link in Telegram and lists the account', async () => {
  await tg.waitFor(TG_USER.id, (x) => x.text.includes('✅ Linked') && x.text.includes(USER))
  const from = tg.sent.length
  say(TG_USER, '/accounts')
  await tg.waitFor(TG_USER.id, (x) => x.text.includes('Linked accounts') && x.text.includes(USER), { from })
})

await step('a used link can’t be replayed', async () => {
  await page.goto(WEB + '/', { waitUntil: 'networkidle' })
  await page.goto(linkUrl, { waitUntil: 'networkidle' })
  await page.getByText(/already used/).waitFor()
})

await step('a function-call key can’t prove ownership: nothing is linked', async () => {
  const from = tg.sent.length
  say(TG_OTHER, '/link')
  const m = await tg.waitFor(TG_OTHER.id, (x) => x.buttons.some((b) => b.url?.includes('/telegram#link=')), { from })
  const appJwk = await crypto.subtle.exportKey('jwk', appPair.privateKey)
  page = await newPage({ accounts: [USER], walletName: 'E2E Test Wallet', signingKey: { jwk: appJwk, publicKey: APP_KEY } })
  await page.goto(m.buttons.find((b) => b.url).url, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Connect wallet to link' }).click()
  await page
    .getByRole('dialog', { name: 'Connect a wallet' })
    .getByRole('button', { name: /E2E Test Wallet/ })
    .click()
  await page.getByRole('button', { name: `Sign and link ${USER}` }).click()
  await page.getByText(/full-access key/).waitFor()
  await shot('tg-03-refused')
  const other = tg.sent.filter((x) => x.chatId === TG_OTHER.id && x.text.includes('✅ Linked'))
  if (other.length) throw new Error('the other Telegram user was linked')
})

await step('a buy prepared in Telegram is signed in NEARKITS, checked on chain and reported back', async () => {
  let from = tg.sent.length
  say(TG_USER, `/buy ${USDT} 1`)
  const quote = await tg.waitFor(TG_USER.id, (x) => x.buttons.some((b) => b.url?.includes('/swap?')), { from })
  if (!quote.text.includes('NEARKITS fee none on testnet') || !quote.text.includes('Route NEAR')) throw new Error(`unexpected quote: ${quote.text.slice(0, 200)}`)
  const url = quote.buttons.find((b) => b.url?.includes('/swap?')).url
  // A properly formed transaction hash (32 bytes, base58): the server refuses anything else.
  const TX_HASH = b58(crypto.getRandomValues(new Uint8Array(32)))
  page = await newPage({ accounts: [USER], walletName: 'E2E Test Wallet', signingKey: { jwk, publicKey: PUBLIC_KEY }, hashes: [TX_HASH] })
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.getByText('Prepared in Telegram').waitFor()
  await page.getByText(`for ${USER}`).waitFor()
  if ((await page.getByPlaceholder('0.00').first().inputValue()) !== '1') throw new Error('the amount was not filled in from the link')
  await page.getByRole('button', { name: 'Connect wallet' }).first().click()
  await page
    .getByRole('dialog', { name: 'Connect a wallet' })
    .getByRole('button', { name: /E2E Test Wallet/ })
    .click()
  await page.getByRole('button', { name: 'Swap NEAR → USDT' }).click()
  await page.getByRole('button', { name: 'Confirm swap' }).click()
  const modal = page.getByRole('dialog', { name: 'Review swap' })
  await modal.getByText('NEAR → USDT · Rhea', { exact: true }).first().waitFor({ timeout: 10000 })
  await shot('tg-04-trade-review')
  await modal.getByRole('button', { name: 'Swap NEAR → USDT' }).click()
  await page.getByRole('dialog', { name: /Confirmed|transactions confirmed/ }).waitFor({ timeout: 15000 })
  if (process.env.E2E_DEBUG) {
    await page.waitForTimeout(3000)
    console.log(
      'MODAL:',
      (
        await page
          .getByRole('dialog')
          .first()
          .innerText()
          .catch(() => '')
      )
        .replace(/\s+/g, ' ')
        .slice(0, 1200),
    )
    console.log('STATUS:', (await page.locator('[role=status]').allInnerTexts()).join(' | ').slice(0, 600))
  }
  await page.keyboard.press('Escape')
  await page.getByText('Confirmed on chain and sent to Telegram.').waitFor({ timeout: 15000 })
  await shot('tg-05-trade-reported')
  from = tg.sent.length
  const done = await tg.waitFor(TG_USER.id, (x) => x.text.includes('Bought'), { timeoutMs: 15000 })
  if (!/Bought 4\.0\d+ USDT/.test(done.text) || !done.text.includes('for 1 NEAR')) throw new Error(`unexpected result: ${done.text}`)
})

let mainAddress = ''
await step('a token contract pasted on its own opens the buy flow at its amount step, prepares nothing, and a plain word still points to /help', async () => {
  let from = tg.sent.length
  say(TG_USER, USDT)
  const ask = await tg.waitFor(TG_USER.id, (x) => x.text.includes('Buy USDT'), { from })
  if (!ask.text.includes('How much NEAR?')) throw new Error(`the buy flow did not reach its amount step: ${ask.text.slice(0, 200)}`)
  if (ask.buttons.some((b) => b.url?.includes('/swap?'))) throw new Error('a pasted contract prepared a trade by itself')
  from = tg.sent.length
  say(TG_USER, '/cancel')
  await tg.waitFor(TG_USER.id, (x) => /cancel/i.test(x.text), { from })
  from = tg.sent.length
  say(TG_USER, 'hello')
  const help = await tg.waitFor(TG_USER.id, () => true, { from })
  if (!help.text.includes('/help')) throw new Error(`a plain word did not get the help pointer: ${help.text.slice(0, 120)}`)
})

await step('a NEARKITS wallet is created in Telegram: one address even on a double tap, and /health says wallets are on', async () => {
  const health = await fetch(`http://127.0.0.1:${API_PORT}/health`).then((r) => r.json())
  if (health.wallets !== 'on') throw new Error(`wallets: ${health.wallets}`)
  if (health.signer !== 'ok') throw new Error(`signer: ${health.signer}`)
  if (health.pauses?.trading !== false || health.pauses?.withdrawals !== false) throw new Error(`pauses: ${JSON.stringify(health.pauses)}`)
  let from = tg.sent.length
  say(TG_USER, '/wallet')
  const offer = await tg.waitFor(TG_USER.id, (x) => x.text.includes('not created yet'), { from })
  const create = offer.buttons.find((b) => b.text.includes('Create NEARKITS wallet'))?.callback_data
  if (!create?.startsWith('cw:new:')) throw new Error(`no one-time Create button: ${create}`)
  from = tg.sent.length
  press(TG_USER, create)
  press(TG_USER, create)
  const made = await tg.waitFor(TG_USER.id, (x) => /[0-9a-f]{64}/.test(x.text), { from })
  const address = made.text.match(/[0-9a-f]{64}/)[0]
  mainAddress = address
  await new Promise((r) => setTimeout(r, 300))
  const shown = new Set(tg.sent.slice(from).flatMap((x) => x.text.match(/[0-9a-f]{64}/g) ?? []))
  if (shown.size !== 1) throw new Error(`more than one wallet address: ${[...shown].join(', ')}`)
  from = tg.sent.length
  press(TG_USER, 'cw:dep')
  const dep = await tg.waitFor(TG_USER.id, (x) => x.text.includes('Deposit'), { from })
  if (!dep.text.includes(address) || !dep.text.includes('NEAR Testnet')) throw new Error(`unexpected deposit screen: ${dep.text.slice(0, 200)}`)
})

// ─── NearKit web: the user's NearKit wallets on the website ─────────────────

const API = `http://localhost:${API_PORT}`
/** A call to NearKit's API from the page, with the page's NearKit web session (what any client could send). */
const webApi = (path, body, session = true) =>
  page.evaluate(
    async ([api, path, body, session]) => {
      const s = JSON.parse(localStorage.getItem('nearkit:web-session:testnet') ?? 'null')
      const r = await fetch(api + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...(session ? { session: s?.token } : {}), ...body }),
      })
      return { status: r.status, json: await r.json().catch(() => null) }
    },
    [API, path, body, session],
  )
let webLogin = ''
let degenAddress = ''

await step('NEARKITS web: /web sends a one-time sign-in link, and the site lists the NEARKITS wallets with no browser wallet', async () => {
  const from = tg.sent.length
  say(TG_USER, '/web')
  const m = await tg.waitFor(TG_USER.id, (x) => x.buttons.some((b) => b.url?.includes('/wallets#login=')), { from })
  if (!m.text.includes('one-time sign-in link')) throw new Error(`unexpected /web answer: ${m.text.slice(0, 200)}`)
  webLogin = m.buttons.find((b) => b.url?.includes('#login=')).url
  if (!webLogin.startsWith(`${WEB}/wallets#login=`)) throw new Error(`unexpected link ${webLogin}`)
  near.state.accounts.set(mainAddress, { amount: String(3n * ONE) })
  page = await newPage({ accounts: [USER], walletName: 'E2E Test Wallet' })
  await page.goto(webLogin, { waitUntil: 'networkidle' })
  // A link can be anyone's: the page names its Telegram account and signs in only once confirmed.
  const ask = page.getByRole('dialog', { name: 'Sign in to NEARKITS web?' })
  await ask.getByText('Tess (@tester)').waitFor()
  if (page.url().includes('#login=')) throw new Error('the sign-in code stayed in the address bar')
  await shot('tg-06a-web-sign-in-confirm')
  await ask.getByRole('button', { name: 'Sign in' }).click()
  await page.getByText('Signed in as Tess').waitFor()
  const table = page.getByRole('table', { name: 'NEARKITS wallets' })
  await table.getByText('Main', { exact: true }).waitFor()
  await table.getByText('3.00').waitFor()
  if ((await page.getByRole('button', { name: 'Connect wallet' }).count()) === 0) throw new Error('the page claims a browser wallet is connected')
  await shot('tg-06-web-wallets')
})

await step('with only a NEARKITS web session (no browser wallet), Consolidate, Split and Batch Send open: NEARKITS wallets are their sources', async () => {
  const opens = async (path, ready) => {
    await page.goto(WEB + path, { waitUntil: 'networkidle' })
    await ready()
      .waitFor({ timeout: 15000 })
      .catch(() => undefined)
    if ((await page.getByText(/to use (Consolidate|Split|Batch Send)$/).count()) > 0) throw new Error(`${path} still asks for a browser wallet`)
    await ready().waitFor({ timeout: 5000 })
  }
  await opens('/consolidate', () => page.getByRole('button', { name: /^Token: / }))
  await opens('/split', () => page.getByLabel('Source wallet', { exact: true }))
  if (
    !(
      await page
        .getByLabel('Source wallet', { exact: true })
        .locator('option')
        .evaluateAll((os) => os.map((o) => o.value))
    ).includes(mainAddress)
  )
    throw new Error('Split doesn’t offer the NEARKITS wallet as its source')
  await opens('/batch-send', () => page.getByLabel('Send from', { exact: true }))
  if ((await page.getByRole('button', { name: 'Connect wallet' }).count()) === 0) throw new Error('a browser wallet got connected on the way')
  await page.goto(WEB + '/wallets', { waitUntil: 'networkidle' })
})

await step('a used sign-in link signs nobody in', async () => {
  const other = await newPage({ accounts: [USER] })
  await other.goto(webLogin, { waitUntil: 'networkidle' })
  await other.getByText(/expired or was already used/).waitFor()
  await other.context().close()
})

await step('a sign-in link someone else sent names their account; refused, the browser keeps its own session', async () => {
  const from = tg.sent.length
  say(TG_OTHER, '/web')
  const m = await tg.waitFor(TG_OTHER.id, (x) => x.buttons.some((b) => b.url?.includes('/wallets#login=')), { from })
  await page.goto(m.buttons.find((b) => b.url?.includes('#login=')).url, { waitUntil: 'networkidle' })
  const ask = page.getByRole('dialog', { name: 'Sign in to NEARKITS web?' })
  await ask.getByText('Other (@other)').waitFor()
  await ask.getByText(/You’re signed in as Tess/).waitFor()
  await ask.getByRole('button', { name: 'Not my account' }).click()
  await page.getByRole('table', { name: 'NEARKITS wallets' }).getByText('Main', { exact: true }).waitFor()
})

await step('Create wallet on NEARKITS web: named, listed at once, announced in Telegram, no key on the page', async () => {
  const from = tg.sent.length
  await page.getByRole('button', { name: 'Create wallet' }).first().click()
  const modal = page.getByRole('dialog', { name: 'Create a NEARKITS wallet' })
  await modal.getByLabel('Name').fill('Degen 1')
  await modal.getByRole('button', { name: 'Create wallet' }).click()
  await page.getByText('Degen 1 created').waitFor()
  await page.getByRole('table', { name: 'NEARKITS wallets' }).getByText('Degen 1', { exact: true }).waitFor()
  await tg.waitFor(TG_USER.id, (x) => x.text.includes('NEARKITS wallet created on NEARKITS web') && x.text.includes('Degen 1'), { from })
  const list = await webApi('/api/web/wallets', {})
  const degen = list.json?.wallets?.find((w) => w.name === 'Degen 1')
  if (!degen || !/^[0-9a-f]{64}$/.test(degen.accountId)) throw new Error(`not listed: ${JSON.stringify(list.json)}`)
  degenAddress = degen.accountId
  // The notice shows the address shortened; its Copy address key carries the full id from the wallet record.
  const notice = tg.sent.slice(from).find((x) => x.chatId === TG_USER.id && x.text.includes('NEARKITS wallet created on NEARKITS web'))
  if (!notice || notice.text.includes(degenAddress)) throw new Error('the notice shows the full address, or is missing')
  // The shortened address is plain text: nothing in the message copies it.
  if (!notice.text.includes(`${degenAddress.slice(0, 6)}…${degenAddress.slice(-4)}`) || /<code>|<pre>/.test(notice.text))
    throw new Error(`the shortened address is missing or copyable: ${notice.text}`)
  const copyKey = notice.buttons.find((b) => b.text === '📋 Copy address')
  if (copyKey?.copy_text?.text !== degenAddress) throw new Error(`Copy address carries ${JSON.stringify(copyKey)}`)
  // On the web, the wallet's copy control copies the same 64-character id in full.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.getByRole('button', { name: 'Copy Degen 1 address' }).locator('visible=true').first().click()
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  if (copied !== degenAddress) throw new Error(`the web copy control copied ${copied}`)
  const html = await page.content()
  if (/ed25519:|privateKey|sealed/.test(html)) throw new Error('key material reached the page')
  await shot('tg-07-web-created')
})

await step('Rename on NEARKITS web changes the name only', async () => {
  await page.getByRole('button', { name: 'Rename Degen 1' }).first().click()
  const modal = page.getByRole('dialog', { name: 'Rename Degen 1' })
  await modal.getByLabel('Name').fill('Sniper A')
  await modal.getByRole('button', { name: 'Save name' }).click()
  await page.getByText('Renamed to Sniper A').waitFor()
  const list = await webApi('/api/web/wallets', {})
  const w = list.json?.wallets?.find((x) => x.name === 'Sniper A')
  if (!w || w.accountId !== degenAddress) throw new Error('the rename changed more than the name')
})

await step('Order and delete on NEARKITS web: the server keeps the order; an empty wallet is deleted the bot’s way and Telegram is told', async () => {
  const listed = async () => (await webApi('/api/web/wallets', {})).json?.wallets ?? []
  const names = async () => (await listed()).map((x) => x.name).join()
  const until = async (want) => {
    for (let i = 0; i < 40 && (await names()) !== want; i++) await new Promise((r) => setTimeout(r, 250))
    if ((await names()) !== want) throw new Error(`wallets listed as ${await names()}, not ${want}`)
  }
  const [main, sniper] = await listed()
  if ((await names()) !== 'Main,Sniper A') throw new Error(`unexpected wallets: ${await names()}`)
  await page.getByRole('button', { name: 'Move Sniper A up' }).first().click()
  await until('Sniper A,Main')
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByRole('table', { name: 'NEARKITS wallets' }).locator('tbody tr').first().getByText('Sniper A').waitFor()
  // An empty wallet, deleted through its confirmation.
  await webApi('/api/web/wallets/create', { name: 'Temp', createKey: 'e2e-manage-temp-0001' })
  await page.reload({ waitUntil: 'networkidle' })
  const from = tg.sent.length
  await page.getByRole('button', { name: 'Delete Temp' }).first().click()
  await page.getByRole('dialog', { name: 'Delete Temp?' }).getByRole('button', { name: 'Delete wallet' }).click()
  await page.getByText('Temp deleted').waitFor()
  await until('Sniper A,Main')
  await tg.waitFor(TG_USER.id, (x) => x.text.includes('NEARKITS wallet deleted on NEARKITS web') && x.text.includes('Temp'), { from })
  // Back to the order the steps after this one expect.
  await webApi('/api/web/wallets/order', { walletIds: [main.id, sniper.id] })
  await page.reload({ waitUntil: 'networkidle' })
  // The same keys on a phone (captured with --shots).
  if (SHOTS) {
    await page.setViewportSize({ width: 360, height: 800 })
    await page.getByRole('list', { name: 'NEARKITS wallets' }).waitFor()
    await shot('tg-11-wallets-360')
    await page.setViewportSize({ width: 1280, height: 900 })
  }
})

await step('Multi Buy across NEARKITS wallets runs from the web: the server quotes each wallet, Execute runs each one, and Telegram takes no part', async () => {
  near.state.accounts.set(degenAddress, { amount: String(3n * ONE) })
  await page.goto(WEB + '/multi-trade', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Select all', exact: true }).click()
  await page.getByLabel('Total', { exact: true }).fill('0.2')
  await page.getByText('0.10 NEAR / wallet').waitFor()
  const from = tg.sent.length
  await page.getByRole('button', { name: /Execute multi buy/i }).click()
  const modal = page.getByRole('dialog', { name: /Review multi buy/i })
  // The server's fresh quote for each wallet, and the web's own Execute.
  const execute = modal.getByRole('button', { name: 'Execute multi buy (2)' })
  await execute.waitFor({ timeout: 15000 })
  await modal.getByText('Main', { exact: true }).waitFor()
  await modal.getByText('Sniper A', { exact: true }).waitFor()
  // The gas reserve is its own line, explained; the actual network fee and NearKit's fee are theirs.
  await modal.getByText('Gas reserve (refunded)').first().waitFor()
  await modal.getByText('Temporarily held while the transaction runs. Unused gas is refunded automatically.').first().waitFor()
  await modal.getByText('Actual network fee (est.)').first().waitFor()
  await modal.getByText('NEARKITS fee', { exact: true }).first().waitFor()
  if ((await modal.getByText('Network fee (est.)', { exact: true }).count()) !== 0) throw new Error('the review still labels a figure Network fee')
  await shot('tg-08-web-multi-review')
  await execute.click()
  // Each wallet reports its own result. This fake network can't run a server-signed transaction,
  // so each one ends as its own failure; nothing is ever sent for real.
  await modal.getByText(/Finished: \d of 2 trades confirmed/).waitFor({ timeout: 30000 })
  await shot('tg-08b-web-multi-status')
  await new Promise((r) => setTimeout(r, 300))
  const toTelegram = tg.sent.slice(from).filter((m) => m.chatId === TG_USER.id)
  if (toTelegram.length) throw new Error(`Telegram got ${toTelegram.length} message(s): ${toTelegram[0].text.slice(0, 120)}`)
  await page.keyboard.press('Escape')
})

await step('a single Buy from a NEARKITS wallet in the normal trade ticket: no browser wallet to connect, no Telegram; NEARKITS runs it', async () => {
  await page.goto(WEB + `/token/${USDT}`, { waitUntil: 'networkidle' })
  const from = tg.sent.length
  await page.locator('main').getByRole('button', { name: 'Buy USDT' }).click()
  const sheet = page.getByRole('dialog', { name: 'Trade ticket' })
  await sheet.getByLabel('Trade from wallet').waitFor()
  if (await sheet.getByRole('button', { name: 'Connect wallet' }).count()) throw new Error('the ticket asks to connect a wallet for a NEARKITS wallet')
  await sheet.getByText(/NEARKITS executes it from/).waitFor()
  await sheet.getByPlaceholder('0.00').fill('0.1')
  // Two-step confirmation (the default): the first press arms, the second opens the review.
  await sheet.getByRole('button', { name: 'Buy USDT' }).click()
  await sheet.getByRole('button', { name: 'Confirm buy USDT' }).click()
  const modal = page.getByRole('dialog', { name: 'Review buy' })
  const buy = modal.getByRole('button', { name: 'Buy USDT' })
  await buy.waitFor({ timeout: 15000 })
  await shot('tg-08c-web-single-review')
  await buy.click()
  await modal.getByText(/Finished: \d of 1 trade confirmed/).waitFor({ timeout: 30000 })
  await new Promise((r) => setTimeout(r, 300))
  if (tg.sent.slice(from).some((m) => m.chatId === TG_USER.id)) throw new Error('Telegram took part in a web buy')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
})

await step(
  'Send from a NEARKITS wallet is reviewed and sent from the web; an unapproved address offers Approve & continue (the owner approves it right there, then the review); Telegram takes no part',
  async () => {
    near.state.accounts.set('friend.testnet', { amount: String(ONE) })
    near.state.accounts.set('friend3.testnet', { amount: String(ONE) })
    await page.goto(WEB + '/wallets', { waitUntil: 'networkidle' })
    await page.getByRole('table', { name: 'NEARKITS wallets' }).getByRole('button', { name: 'Send' }).first().click()
    const modal = page.getByRole('dialog', { name: 'Send from Main' })
    const from = tg.sent.length
    // An address the owner wallet never approved: one way forward, Approve & continue (no competing Review).
    await modal.getByLabel('Amount').fill('0.5')
    await modal.getByLabel('To').fill('friend3.testnet')
    await modal.getByRole('button', { name: 'Review', exact: true }).click()
    await modal.getByText(/friend3\.testnet isn’t approved for Main yet/).waitFor()
    await modal.getByRole('button', { name: 'Approve & continue' }).waitFor()
    if ((await modal.getByRole('button', { name: 'Review', exact: true }).count()) !== 0) throw new Error('Review competes with Approve & continue')
    await shot('tg-09a-web-send-approve-continue')
    // This page's scripted wallet signs with USER's key, as the owner wallet would.
    await page.evaluate(([key, publicKey]) => Object.assign(window.__NEARKIT_E2E_WALLET__, { signingKey: { jwk: key, publicKey } }), [jwk, PUBLIC_KEY])
    await modal.getByRole('button', { name: 'Approve & continue' }).click()
    // The owner approval, right here: the signer's message, the owner wallet signs it.
    await modal.getByText('Your wallet will sign').waitFor({ timeout: 15000 })
    const connectOwner = modal.getByRole('button', { name: `Connect ${USER}` })
    if (await connectOwner.isVisible().catch(() => false)) {
      await connectOwner.click()
      const connect = page.getByRole('dialog', { name: `Connect ${USER}` })
      await connect.getByRole('button', { name: /E2E Test Wallet/ }).click()
      await connect.waitFor({ state: 'hidden' })
    }
    await modal.getByRole('button', { name: 'Sign to approve friend3.testnet' }).click()
    // Approved: the same send is reviewed again, and goes through to its review.
    await modal.getByText('Check the address: transfers can’t be undone.').waitFor({ timeout: 20000 })
    await modal.getByText('friend3.testnet').first().waitFor()
    await modal.getByRole('button', { name: 'Back' }).click()
    // Another address that isn't approved: the same choice.
    await modal.getByLabel('To').fill('friend.testnet')
    await modal.getByRole('button', { name: 'Review', exact: true }).click()
    await modal.getByText(/friend\.testnet isn’t approved for Main yet/).waitFor()
    await modal.getByRole('button', { name: 'Approve & continue' }).waitFor()
    // The shortcut to one of the user's own NEARKITS wallets fills in its full account id. Under the same
    // owner wallet it needs no approval: the review goes straight through and names it.
    const sniper = (await webApi('/api/web/wallets', {})).json?.wallets?.find((x) => x.name === 'Sniper A')
    await modal.getByLabel('Pick one of my NEARKITS wallets as the destination').selectOption(sniper.accountId)
    if ((await modal.getByLabel('To').inputValue()) !== sniper.accountId) throw new Error('the shortcut did not fill in the full account id')
    await modal.getByRole('button', { name: 'Review', exact: true }).click()
    await modal.getByText('Check the address: transfers can’t be undone.').waitFor()
    await modal.getByText(/your NEARKITS wallet Sniper A \(same owner: no approval needed\)/).waitFor()
    if ((await modal.getByRole('button', { name: 'Approve & continue' }).count()) !== 0) throw new Error('a wallet under the same owner asked for an approval')
    await modal.getByRole('button', { name: 'Back' }).click()
    // The owner wallet: the review, then Send, right here.
    await modal.getByLabel('To').fill(USER)
    await modal.getByRole('button', { name: 'Review', exact: true }).click()
    await modal.getByText('Check the address: transfers can’t be undone.').waitFor()
    await modal.getByText(USER).first().waitFor()
    await shot('tg-09-web-send-review')
    await modal.getByRole('button', { name: 'Send', exact: true }).click()
    // NearKit runs it itself (this fake network can't execute it, so it ends as failed: nothing real).
    await modal.getByText(/^(Sent|Failed)$/).waitFor({ timeout: 30000 })
    await new Promise((r) => setTimeout(r, 300))
    // Telegram hears of the approval (a security notice), never of the send itself.
    const told = tg.sent.slice(from).filter((m) => m.chatId === TG_USER.id)
    if (!told.some((m) => m.text.includes('friend3.testnet') && m.text.includes('can now receive withdrawals'))) throw new Error('the approval was not announced in Telegram')
    if (told.some((m) => !m.text.includes('can now receive withdrawals'))) throw new Error('Telegram took part in a web send')
    await page.keyboard.press('Escape')
  },
)

await step(
  'Recover: the owner is whoever signs with a full-access key of the owner: no key reported or the NEARKITS wallet’s own exported key is refused before anything reaches the signer (never "Wallet connected"); the same account signing with the owner’s key, or the owner listed second, gets the approval through',
  async () => {
    const EVM = '0x52908400098527886E0F7030069857D2E4169EE7'
    // The NearKit wallet's own key, as a wallet app holds it after Recover exported it: a key of that wallet, not of its owner.
    const MAIN_KEY = `ed25519:${b58(Buffer.from(mainAddress, 'hex'))}`
    const rp = await newPage({ accounts: [USER], walletName: 'E2E Test Wallet', signingKey: { jwk, publicKey: PUBLIC_KEY } })
    const setWallet = (accounts, keys = {}) => rp.evaluate(([a, k]) => Object.assign(window.__NEARKIT_E2E_WALLET__, { accounts: a, keys: k }), [accounts, keys])
    const asked = () => rp.evaluate(() => (window.__NEARKIT_E2E_MESSAGES__ ?? []).map((m) => m.signerId))
    // What reached NearKit's signer through the app: every approval sent, with the key it was signed with.
    const sent = []
    rp.on('request', (r) => r.method() === 'POST' && r.url().endsWith('/api/recovery/destination') && sent.push(JSON.parse(r.postData() ?? '{}').publicKey))
    // The browser wallet is on the NearKit wallet's own account, and says no key.
    await rp.goto(WEB + '/', { waitUntil: 'networkidle' })
    await rp.evaluate((a) => sessionStorage.setItem('nearkit:e2e:session', JSON.stringify([a])), mainAddress)
    await rp.goto(`${WEB}/recover#approve=${mainAddress}&to=friend.testnet`, { waitUntil: 'networkidle' })
    await rp.getByRole('button', { name: 'Prepare the approval' }).click()
    await rp.getByText(`Your wallet returned ${mainAddress}, not ${USER}, and didn’t say which key it signs with`).waitFor({ timeout: 15000 })
    await rp.getByRole('button', { name: `Connect ${USER}` }).click()
    const dialog = rp.getByRole('dialog', { name: `Connect ${USER}` })
    const alert = dialog.getByRole('alert')
    const pick = () => dialog.getByRole('button', { name: /E2E Test Wallet/ }).click()
    // Still the same account after the reconnect, and still no key: an error naming it, with what the wallet returned.
    await setWallet([mainAddress])
    await pick()
    await alert
      .getByText(
        `Your wallet returned ${mainAddress}, not ${USER}, and didn’t say which key it signs with, so NEARKITS can’t tell whether it holds a key of ${USER}. Switch to ${USER} itself in your wallet; if it keeps returning the same account, remove NEARKITS from the wallet’s connected sites, then connect again.`,
      )
      .waitFor()
    await alert.getByText('What your wallet returned').click()
    await alert.getByText(`accountId: ${mainAddress}`).waitFor()
    // Only an EVM address: named as one, never as the connected account.
    await setWallet([EVM])
    await pick()
    await alert.getByText(`Your wallet returned an EVM address (${EVM}), not a NEAR account. Switch to the NEAR account ${USER} in your wallet, then try again.`).waitFor()
    if (SHOTS) await rp.screenshot({ path: join(SHOTS, 'tg-10b-recover-evm-only.png') })
    // The NearKit wallet's own exported key: refused, said as it is; the wallet is never asked to sign.
    await setWallet([mainAddress], { [mainAddress]: MAIN_KEY })
    await pick()
    await alert
      .getByText(
        `Your wallet is connected as ${mainAddress}, your NEARKITS wallet itself: it signs with that wallet’s exported key (${MAIN_KEY}), which isn’t a key of ${USER}. Connect the wallet that holds ${USER}’s own key, then try again.`,
      )
      .waitFor()
    await alert.getByText('What your wallet returned').click()
    await alert.getByText(`publicKey: ${MAIN_KEY}`).waitFor()
    if (SHOTS) await rp.screenshot({ path: join(SHOTS, 'tg-10a-recover-own-key.png') })
    if ((await rp.getByText('Wallet connected').count()) !== 0) throw new Error('"Wallet connected" was shown for a wallet that can’t sign for the owner')
    if ((await asked()).length !== 0 || sent.length !== 0) throw new Error(`a refused wallet was asked to sign (${(await asked()).join()}) or a proof was sent (${sent.join()})`)
    // The same account, signing with a full-access key of the owner: connected as itself, and its signature approves.
    await setWallet([mainAddress], { [mainAddress]: PUBLIC_KEY })
    await pick()
    await dialog.waitFor({ state: 'hidden' })
    await rp.getByText(`It signs with a full-access key of ${USER}, so it can sign ${USER}’s requests.`).first().waitFor()
    await rp.getByText(`Your wallet is connected as ${mainAddress}. It signs with ${PUBLIC_KEY}, a full-access key of ${USER}, so its signature counts as ${USER}’s.`).waitFor()
    if (SHOTS) await rp.screenshot({ path: join(SHOTS, 'tg-10c-recover-owner-key.png') })
    await rp.getByRole('button', { name: 'Sign to approve friend.testnet' }).click()
    await rp.getByText(/^Approved\./).waitFor({ timeout: 15000 })
    if ((await asked()).join() !== mainAddress) throw new Error(`the wallet was asked to sign as: ${(await asked()).join() || 'nobody'}`)
    if (sent.join() !== PUBLIC_KEY) throw new Error(`the approval reached the signer with: ${sent.join() || 'nothing'}`)
    // The owner's NearKit wallets, listed by naming the owner: the wallet still calls itself mainAddress but signs with the owner's key.
    await rp.goto(`${WEB}/recover`, { waitUntil: 'networkidle' })
    await setWallet([mainAddress], { [mainAddress]: PUBLIC_KEY })
    await rp.getByLabel('Owner account').fill(USER)
    await rp.getByRole('button', { name: `Sign to show the NEARKITS wallets of ${USER}` }).click()
    await rp.getByText(mainAddress).first().waitFor({ timeout: 15000 })
    await rp.context().close()

    // A wallet that lists the owner after the NearKit wallet's account: the owner is taken by name, and signs as itself.
    const rp2 = await newPage({ accounts: [USER], walletName: 'E2E Test Wallet', signingKey: { jwk, publicKey: PUBLIC_KEY } })
    await rp2.goto(WEB + '/', { waitUntil: 'networkidle' })
    await rp2.evaluate((a) => sessionStorage.setItem('nearkit:e2e:session', JSON.stringify([a])), mainAddress)
    await rp2.goto(`${WEB}/recover#approve=${mainAddress}&to=friend2.testnet`, { waitUntil: 'networkidle' })
    await rp2.getByRole('button', { name: 'Prepare the approval' }).click()
    await rp2.getByRole('button', { name: `Connect ${USER}` }).click()
    await rp2.evaluate((a) => (window.__NEARKIT_E2E_WALLET__.accounts = a), [mainAddress, USER])
    const dialog2 = rp2.getByRole('dialog', { name: `Connect ${USER}` })
    await dialog2.getByRole('button', { name: /E2E Test Wallet/ }).click()
    await dialog2.waitFor({ state: 'hidden' })
    await rp2.getByText(`${USER} via E2E Test Wallet`).first().waitFor()
    await rp2.getByRole('button', { name: 'Sign to approve friend2.testnet' }).click()
    await rp2.getByText(/^Approved\./).waitFor({ timeout: 15000 })
    const signers = await rp2.evaluate(() => (window.__NEARKIT_E2E_MESSAGES__ ?? []).map((m) => m.signerId))
    if (signers.join() !== USER) throw new Error(`the wallet was asked to sign as: ${signers.join() || 'nobody'}`)
    await rp2.context().close()
  },
)

await step(
  'Batch Send from a NEARKITS wallet: it is a source; each line is a web send under the custody rule (an unapproved line blocks the batch, with its approval link); a ready batch is sent by NEARKITS, nothing signed in the browser',
  async () => {
    near.state.accounts.set('friend4.testnet', { amount: String(ONE) })
    await page.goto(WEB + '/batch-send', { waitUntil: 'networkidle' })
    await page.getByLabel('Send from', { exact: true }).selectOption(mainAddress)
    const list = page.getByRole('textbox', { name: 'Batch list' })
    await list.fill(`${USER},0.1\nfriend4.testnet,0.1`)
    await page.getByRole('button', { name: 'Send batch' }).click()
    const review = page.getByRole('dialog', { name: 'Review batch send' })
    await review.getByText('Needs approval').waitFor({ timeout: 15000 })
    await review.getByRole('link', { name: `Approve with ${USER}` }).waitFor()
    if (await review.getByRole('button', { name: 'Send batch' }).isEnabled()) throw new Error('a batch with a line that needs approval could be sent')
    await shot('tg-09b-web-batch-needs-approval')
    await review.getByRole('button', { name: 'Cancel' }).click()
    // The owner only: ready, and sent by NearKit's server (this fake network can't execute it, so it ends as failed: nothing real).
    await list.fill(`${USER},0.1`)
    await page.getByRole('button', { name: 'Send batch' }).click()
    await review.getByText('Ready').waitFor({ timeout: 15000 })
    const signed = () => page.evaluate(() => (window.__NEARKIT_E2E_SIGNED__ ?? []).length)
    const before = await signed()
    await review.getByRole('button', { name: 'Send batch' }).click()
    await review.getByText(/^Sent [01] of 1\.$/).waitFor({ timeout: 60000 })
    if ((await signed()) !== before) throw new Error('the browser wallet signed a NEARKITS wallet’s batch')
    // The footer's Close (the dialog's own × is named Close too).
    await review.getByRole('button', { name: 'Close' }).last().click()
  },
)

await step(
  'Batch Send, Manual: each row sends from its own NEARKITS wallet (Send from until one is chosen); the preview and the review name each row’s wallet and NEARKITS’ server reviews each line from it; never a connected or watch-only account; Paste list unchanged',
  async () => {
    near.state.accounts.set('friend5.testnet', { amount: String(ONE) })
    await page.goto(WEB + '/batch-send', { waitUntil: 'networkidle' })
    // Send from starts on the connected account (also called "Main"): Manual rows follow it, and the page
    // says how to send each row from its own NEARKITS wallet; Send from lists the two kinds apart.
    const sendFrom = page.getByLabel('Send from', { exact: true })
    await sendFrom.locator('optgroup').first().waitFor({ state: 'attached', timeout: 15000 })
    const groups = await sendFrom.locator('optgroup').evaluateAll((gs) => gs.map((g) => g.getAttribute('label')))
    if (groups.join() !== 'NEARKITS wallets,Connected wallet') throw new Error(`Send from lists ${groups.join()}`)
    if ((await sendFrom.inputValue()) !== USER) throw new Error('Send from didn’t start on the connected account')
    await page.getByRole('tab', { name: 'Manual' }).click()
    if ((await page.getByRole('combobox', { name: /^From, recipient/ }).count()) !== 0) throw new Error('a connected Send from offers per-row wallets')
    await shot('tg-09f-batch-manual-connected')
    await page.getByRole('button', { name: 'Use NEARKITS wallets' }).click()
    await page.getByLabel('From, recipient 1', { exact: true }).waitFor()
    if ((await sendFrom.inputValue()) !== mainAddress) throw new Error('Use NEARKITS wallets didn’t switch Send from to a NEARKITS wallet')
    await page.getByRole('tab', { name: 'Paste list' }).click()
    await page.getByLabel('Send from', { exact: true }).selectOption(mainAddress)
    // Paste list: one source, no per-row wallet, exactly as before.
    if ((await page.getByRole('combobox', { name: /^From, recipient/ }).count()) !== 0) throw new Error('Paste list offers a per-row wallet')
    await page.getByRole('tab', { name: 'Manual' }).click()
    const from1 = page.getByLabel('From, recipient 1', { exact: true })
    await from1.waitFor()
    // Only NearKit wallets (never the connected account or a watch-only one); a row follows Send from.
    const offered = await from1.locator('option').evaluateAll((os) => os.map((o) => o.value))
    if ([...offered].sort().join() !== [mainAddress, degenAddress].sort().join()) throw new Error(`a row offers ${offered.join(', ')}`)
    if ((await from1.inputValue()) !== mainAddress) throw new Error('a new row doesn’t follow Send from')
    await page.getByLabel('Recipient 1', { exact: true }).fill(USER)
    await page.getByLabel('Amount 1', { exact: true }).fill('0.1')
    await page.getByRole('button', { name: 'Add recipient' }).click()
    await page.getByLabel('From, recipient 2', { exact: true }).selectOption(degenAddress)
    await page.getByLabel('Recipient 2', { exact: true }).fill('friend5.testnet')
    await page.getByLabel('Amount 2', { exact: true }).fill('0.1')
    if ((await from1.inputValue()) !== mainAddress) throw new Error('choosing row 2’s wallet changed row 1')
    // The preview names each row's wallet.
    const rows = page.getByRole('table', { name: 'Batch preview' }).locator('tbody tr')
    await rows.nth(1).getByText('Sniper A').waitFor({ timeout: 15000 })
    if (!(await rows.nth(0).innerText()).includes('Main')) throw new Error(`preview row 1: ${await rows.nth(0).innerText()}`)
    await page.getByText('2 NEARKITS wallets').waitFor()
    await shot('tg-09c-batch-manual-per-row')
    await page.getByRole('button', { name: 'Send batch' }).click()
    const review = page.getByRole('dialog', { name: 'Review batch send' })
    await review.getByText(/^From 2 NEARKITS wallets/).waitFor({ timeout: 15000 })
    for (let i = 0; i < 60 && (await review.getByText('Checking…').count()) > 0; i++) await new Promise((r) => setTimeout(r, 250))
    // Row 1 from Main to its owner: ready. Row 2 from Sniper A: reviewed as Sniper A (its approval link names Sniper A, not Main).
    const lines = review.locator('tbody tr')
    if (!/Main[\s\S]*Ready/.test(await lines.nth(0).innerText())) throw new Error(`review line 1: ${await lines.nth(0).innerText()}`)
    if (!(await lines.nth(1).innerText()).includes('Sniper A')) throw new Error(`review line 2: ${await lines.nth(1).innerText()}`)
    const approve = await lines
      .nth(1)
      .getByRole('link', { name: /^Approve with / })
      .getAttribute('href')
    if (!approve?.includes(`approve=${degenAddress}`) || !approve.includes('to=friend5.testnet')) throw new Error(`row 2 was reviewed for another wallet: ${approve}`)
    if (await review.getByRole('button', { name: 'Send batch' }).isEnabled()) throw new Error('a batch with a line that needs approval could be sent')
    await shot('tg-09d-batch-manual-review')
    await review.getByRole('button', { name: 'Cancel' }).click()
    await page.setViewportSize({ width: 375, height: 812 })
    await page.getByLabel('From, recipient 2', { exact: true }).waitFor()
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    if (wide > 1) throw new Error(`Batch Send Manual scrolls sideways by ${wide}px at 375px`)
    await shot('tg-09e-batch-manual-375')
    await page.setViewportSize({ width: 1280, height: 900 })
  },
)

await step(
  'Consolidate gathers a token held across NEARKITS wallets (in no list, no price, known by its contract): offered first, both wallets are sources, NEARKITS’ server reviews each into the destination; Split puts what its source holds first, by that wallet’s own balance, and still finds the rest',
  async () => {
    const GATHER = 'gather.tkn.testnet'
    near.state.accounts.set(GATHER, { amount: String(ONE), code: true })
    near.state.tokens.set(GATHER, {
      symbol: 'GATHER',
      name: 'Gather Token',
      decimals: 18,
      boundsMin: MIN,
      balances: new Map([
        [mainAddress, String(5_000n * 10n ** 18n)],
        [degenAddress, String(7_000n * 10n ** 18n)],
      ]),
      registered: new Set([mainAddress, degenAddress, USER]),
    })
    const options = async (listbox) => (await listbox.getByRole('option').allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim())
    // An option reads: the glyph's letter (no icon here), the symbol, its name, the balance.
    const isToken = (text, symbol) => new RegExp(`^.?${symbol}`).test(text ?? '')
    const fits = async (where) => {
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      if (wide > 1) throw new Error(`${where} scrolls sideways by ${wide}px`)
    }

    // ── Consolidate ──
    await page.goto(WEB + '/consolidate', { waitUntil: 'networkidle' })
    const dest = page.getByLabel('Destination', { exact: true })
    // The connected account is listed once its wallet session is restored: wait for it before choosing.
    const userListed = async () => (await dest.locator('option').evaluateAll((os) => os.map((o) => o.value))).includes(USER)
    for (let i = 0; i < 40 && !(await userListed()); i++) await new Promise((r) => setTimeout(r, 250))
    const into = (await userListed()) ? USER : mainAddress
    await dest.selectOption(into)
    // It opens on what the sources hold most of: the unlisted, unpriced token, by its contract.
    await page.getByRole('button', { name: 'Token: GATHER' }).waitFor({ timeout: 20000 })
    await page.getByText(into === USER ? '2 of 2 with GATHER' : '1 of 1 with GATHER').waitFor({ timeout: 15000 })
    await page.getByRole('button', { name: 'Token: GATHER' }).click()
    const picker = page.getByRole('listbox', { name: 'Token' })
    const listed = await options(picker)
    if (!isToken(listed[0], 'GATHER')) throw new Error(`Consolidate's picker starts with ${listed[0]}`)
    // The two wallets' balances, summed (12,000), for the token they hold together.
    if (!/12,000|12K/.test(listed[0])) throw new Error(`Consolidate's picker shows ${listed[0]}, not the sources’ 12,000 together`)
    await page.getByRole('textbox', { name: 'Search tokens' }).fill('usdt')
    if (!isToken((await options(picker))[0], 'USDT')) throw new Error('search no longer finds a token the sources don’t hold')
    await page.keyboard.press('Escape')
    await shot('tg-12-consolidate-nearkit')
    const signed = () => page.evaluate(() => (window.__NEARKIT_E2E_SIGNED__ ?? []).length)
    const before = await signed()
    await page.getByRole('button', { name: 'Consolidate', exact: true }).click()
    const review = page.getByRole('dialog', { name: 'Review consolidation' })
    await review.getByText(/^Into .*NEARKITS’ server sends from each NEARKITS wallet/).waitFor({ timeout: 15000 })
    await review.getByText(`${degenAddress.slice(0, 6)}…${degenAddress.slice(-4)}`).waitFor()
    // Reviewed by NearKit's server, wallet by wallet: every line ends ready or says how it gets approved.
    for (let i = 0; i < 60 && (await review.getByText('Checking…').count()) > 0; i++) await new Promise((r) => setTimeout(r, 250))
    if ((await review.getByText('Checking…').count()) > 0) throw new Error('the consolidation was never reviewed')
    if ((await review.getByText('Ready').count()) + (await review.getByText('Needs approval').count()) !== (into === USER ? 2 : 1))
      throw new Error(`unexpected review: ${(await review.innerText()).replace(/\s+/g, ' ')}`)
    if (into === USER && (await review.getByText('Ready').count()) < 1) throw new Error('Main can’t send to its own owner wallet')
    await shot('tg-12b-consolidate-review')
    await review.getByRole('button', { name: 'Cancel' }).click()
    if ((await signed()) !== before) throw new Error('the browser wallet was asked to sign for NEARKITS wallets')
    await page.setViewportSize({ width: 375, height: 812 })
    await page.getByRole('button', { name: 'Token: GATHER' }).waitFor()
    await fits('Consolidate at 375px')
    await shot('tg-12c-consolidate-375')
    await page.setViewportSize({ width: 1280, height: 900 })

    // ── Split: the source wallet's own balance, not the wallets' together ──
    await page.goto(WEB + '/split', { waitUntil: 'networkidle' })
    await page.getByLabel('Source wallet', { exact: true }).selectOption(mainAddress)
    await page.getByRole('button', { name: /^Token: / }).click()
    const split = page.getByRole('listbox', { name: 'Token' })
    await split.getByRole('option', { name: /GATHER/ }).waitFor({ timeout: 15000 })
    const order = await options(split)
    const at = (symbol) => order.findIndex((t) => isToken(t, symbol))
    const gather = order[at('GATHER')] ?? ''
    if (!/5,000|5K/.test(gather) || /12,000|12K/.test(gather)) throw new Error(`Split shows GATHER as ${gather}: Main alone holds 5,000`)
    // NEARKITS' one order: the selected token first, then NEAR, then what Main holds (by its own
    // balance), then what it doesn't hold (USDT).
    if (!isToken(order[0], 'wNEAR') || !/Selected/.test(order[0] ?? '') || !(at('NEAR') < at('GATHER') && at('GATHER') < at('USDT')))
      throw new Error(`Split's picker: ${order.join(' | ')}`)
    await page.getByRole('textbox', { name: 'Search tokens' }).fill('wnear')
    if (!isToken((await options(split))[0], 'wNEAR')) throw new Error('search no longer finds a token Main doesn’t hold')
    await page.keyboard.press('Escape')
    await shot('tg-12d-split-held-first')
    await page.setViewportSize({ width: 375, height: 812 })
    await fits('Split at 375px')
    await shot('tg-12e-split-375')
    await page.setViewportSize({ width: 1280, height: 900 })
  },
)

await step(
  'the Volume Bot console: configured on the web from NEARKITS wallets only, saved stopped, started with a review and a Telegram notice, paused and emergency-stopped',
  async () => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(WEB + '/volume-bot/console', { waitUntil: 'networkidle' })
    const setup = page.locator('section', { hasText: 'New Volume Bot' }).first()
    await setup.waitFor({ timeout: 15000 })
    // The checkbox is custom-drawn over a visually hidden input.
    await setup.getByRole('checkbox', { name: /Main/ }).check({ force: true })
    // The pool in this fake network reports no liquidity: the floor goes to 0 so the guardian has nothing to say about it.
    await setup.getByLabel('Least pool liquidity', { exact: true }).fill('0')
    await setup.getByRole('button', { name: 'Save bot' }).click()
    await page.getByText('Volume Bot saved').waitFor({ timeout: 10000 })
    await page.getByRole('heading', { name: /USDT · Market maker/ }).waitFor()
    await page.getByText('Not started', { exact: true }).first().waitFor()
    await shot('tg-13-volume-bot-saved')

    // A watch account, someone else's wallet or a made-up id is refused by the server, whatever the page sends.
    const saved = (await webApi('/api/web/bots', {})).json.bots[0]
    const config = (await webApi('/api/web/bots/detail', { botId: saved.id })).json.config
    for (const walletId of [USER, 'made-up-id']) {
      const r = await webApi('/api/web/bots/save', { config: { ...config, walletIds: [walletId] } })
      if (r.status !== 403) throw new Error(`a bot from ${walletId} got ${r.status}, not 403`)
    }

    const from = tg.sent.length
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    const review = page.getByRole('dialog', { name: 'Start the USDT bot?' })
    await review.getByText('Largest trade').waitFor()
    await shot('tg-13b-volume-bot-start-review')
    await review.getByRole('button', { name: 'Start bot' }).click()
    await page.getByText('Running', { exact: true }).first().waitFor({ timeout: 10000 })
    await tg.waitFor(TG_USER.id, (x) => x.text.includes('Volume Bot started on NEARKITS web'), { from })
    await shot('tg-13c-volume-bot-running')

    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await page.getByText('Paused', { exact: true }).first().waitFor({ timeout: 10000 })
    const stopping = tg.sent.length
    await page.getByRole('button', { name: 'Emergency stop', exact: true }).click()
    const stop = page.getByRole('dialog', { name: 'Emergency stop?' })
    await stop.getByRole('button', { name: 'Emergency stop' }).click()
    await page
      .getByText(/^(Stopping|Stopped)$/)
      .first()
      .waitFor({ timeout: 10000 })
    // The worker settles the stop on its next step and tells the owner; the console shows it stopped.
    await tg.waitFor(TG_USER.id, (x) => x.text.includes('stopped. Nothing more is sent'), { from: stopping, timeoutMs: 30000 })
    await page.getByText('Stopped', { exact: true }).first().waitFor({ timeout: 15000 })

    // Telegram's /volume shows the same bot.
    const at = tg.sent.length
    say(TG_USER, '/volume')
    const card = await tg.waitFor(TG_USER.id, (x) => x.text.includes('Volume Bot · USDT'), { from: at })
    if (/ed25519:|seed phrase|private key/i.test(card.text)) throw new Error('/volume shows a key')

    await page.setViewportSize({ width: 360, height: 780 })
    await page.goto(WEB + '/volume-bot/console', { waitUntil: 'networkidle' })
    await page.getByRole('heading', { name: /USDT · Market maker/ }).waitFor()
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    if (wide > 1) throw new Error(`the console scrolls sideways by ${wide}px at 360px`)
    await shot('tg-13d-volume-bot-360')
    await page.setViewportSize({ width: 1280, height: 900 })
  },
)

await step('a forged client gets nothing: a watch account, a made-up id or an address is refused before any quote', async () => {
  const sentBefore = tg.sent.length
  for (const walletId of [USER, 'bottest.testnet', 'made-up-id', mainAddress]) {
    const r = await webApi('/api/web/trade/quote', { side: 'buy', token: USDT, slippagePct: 1, legs: [{ walletId, amountIn: '0.1' }] })
    if (r.status !== 403 || r.json?.error?.code !== 'not-executable') throw new Error(`${walletId}: ${r.status} ${JSON.stringify(r.json)}`)
  }
  const send = await webApi('/api/web/send/review', { walletId: USER, token: 'near', amount: '0.1', to: 'x.testnet' })
  if (send.status !== 403) throw new Error(`send from a watch account: ${send.status}`)
  const anonymous = await webApi('/api/web/wallets', {}, false)
  if (anonymous.status !== 400) throw new Error(`no session: ${anonymous.status}`)
  await new Promise((r) => setTimeout(r, 300))
  if (tg.sent.length !== sentBefore) throw new Error('a refused request reached Telegram')
})

await step('Sign out everywhere, from Telegram, ends the web session', async () => {
  const from = tg.sent.length
  press(TG_USER, 'web:out')
  await tg.waitFor(TG_USER.id, (x) => x.text.includes('Signed out of NEARKITS web'), { from })
  await page.goto(WEB + '/wallets', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Sign in with Telegram' }).first().waitFor({ timeout: 10000 })
  const list = await webApi('/api/web/wallets', {})
  if (list.status !== 400 && list.status !== 401) throw new Error(`a revoked session still works: ${list.status}`)
})

await step('unlinking from Telegram removes the account', async () => {
  let from = tg.sent.length
  say(TG_USER, '/unlink')
  const list = await tg.waitFor(TG_USER.id, (x) => x.buttons.some((b) => b.callback_data?.startsWith('acct:ask:')), { from })
  from = tg.sent.length
  press(TG_USER, list.buttons.find((b) => b.callback_data?.startsWith('acct:ask:')).callback_data)
  const ask = await tg.waitFor(TG_USER.id, (x) => x.buttons.some((b) => b.callback_data?.startsWith('acct:do:')), { from })
  from = tg.sent.length
  press(TG_USER, ask.buttons.find((b) => b.callback_data?.startsWith('acct:do:')).callback_data)
  await tg.waitFor(TG_USER.id, (x) => x.text.includes('Unlinked'), { from })
  from = tg.sent.length
  say(TG_USER, '/accounts')
  await tg.waitFor(TG_USER.id, (x) => x.text.includes('No NEAR account is linked'), { from })
})

await step('the Mini App: a direct open from Telegram is a plain landing, outside Telegram it says where to open it, and an approval link reads its request', async () => {
  const tg = await newPage({ accounts: [USER] })
  // Telegram's script, which the page loads inside Telegram: a stand-in that records close().
  await tg.route('https://telegram.org/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.Telegram={WebApp:{ready(){},expand(){},close(){window.__nearkitClosed=true}}}' }),
  )
  const address = (data) => WEB + '/tg#' + new URLSearchParams({ tgWebAppData: data, tgWebAppVersion: '8.0', tgWebAppPlatform: 'ios' }).toString()
  const plain = new URLSearchParams({ auth_date: '1790000000', user: '{"id":101}', signature: 'x', hash: 'y' }).toString()
  // Direct open (the bot's Open button): signed launch data, nothing to approve.
  await tg.goto(address(plain), { waitUntil: 'networkidle' })
  await tg.getByRole('heading', { name: 'Telegram Mini App' }).waitFor()
  await tg
    .getByText(/secure NEARKITS wallet actions and approvals/)
    .first()
    .waitFor()
  if ((await tg.getByRole('alert').count()) !== 0) throw new Error('a direct open showed an error')
  await tg.getByRole('button', { name: 'Back to NEARKITS bot' }).click()
  if ((await tg.evaluate(() => window.__nearkitClosed)) !== true) throw new Error('Back to NEARKITS bot did not close the Mini App')
  // Outside Telegram: no launch data at all.
  await tg.goto(WEB + '/tg', { waitUntil: 'networkidle' })
  await tg
    .getByText(/Open it from NEARKITS’ bot in Telegram/)
    .first()
    .waitFor()
  await tg.getByRole('link', { name: 'Open NEARKITS in Telegram' }).waitFor()
  if ((await tg.getByRole('alert').count()) !== 0) throw new Error('outside Telegram showed an error')
  if ((await tg.getByRole('button', { name: 'Approve' }).count()) !== 0) throw new Error('outside Telegram offered Approve')
  // An approval link: the digest Telegram signed is looked up with the server; an unknown one is refused and nothing is offered.
  const digest = 'vVmfsy7_EOvYV1bUzufrNWV66n0fl92XVUcTOHa02CY'
  const signed = new URLSearchParams({ auth_date: '1790000000', start_param: digest, user: '{"id":101}', signature: 'x', hash: 'y' }).toString()
  // Telegram loads the Mini App fresh; from the same page a changed fragment alone would not.
  await tg.goto(address(signed))
  await tg.reload({ waitUntil: 'networkidle' })
  // The approval path refuses what the signer can't vouch for (an unknown request, or approvals not set up on this server): a refusal, never the landing, never Approve.
  const refusal = tg.getByRole('alert')
  await refusal.waitFor({ timeout: 10000 })
  const reason = (await refusal.innerText()).trim()
  if (/Open it from NEARKITS’ bot/.test(reason) || !/request|approval|Telegram/i.test(reason)) throw new Error(`Unexpected refusal: ${reason}`)
  if ((await tg.getByRole('heading', { name: 'Telegram Mini App' }).count()) !== 0) throw new Error('an approval link showed the landing')
  if ((await tg.getByRole('button', { name: 'Approve' }).count()) !== 0) throw new Error('an unknown request offered Approve')
  await tg.close()
})

await step('no request left for a live network, and no token in the server log', async () => {
  if (near.state.external.length) throw new Error(`external requests: ${near.state.external.slice(0, 3).join(', ')}`)
  if (serverLog.join('').includes(TOKEN)) throw new Error('the bot token reached the server log')
  if (serverLog.join('').includes(KEK)) throw new Error('the wallet key-encryption key reached the server log')
})

console.log(results.join('\n'))
console.log(`\n${passed} passed, 0 failed`)
if (errors.length) {
  console.log('console/page errors:\n  ' + errors.join('\n  '))
  await finish(1)
}
await finish(0)
