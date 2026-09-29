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
  },
  tokens: {
    'wrap.testnet': { symbol: 'wNEAR', name: 'Wrapped NEAR', decimals: 24, balances: {}, registered: ['ref-finance-101.testnet'], boundsMin: MIN },
    [USDT]: { symbol: 'USDT', name: 'Tether USD', decimals: 24, balances: {}, registered: [USER, 'ref-finance-101.testnet'], boundsMin: MIN },
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
  const m = await tg.waitFor(TG_USER.id, (x) => x.text.includes('<b>NearKit</b> · NEAR trading'), { from })
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

await step('a buy prepared in Telegram is signed in NearKit, checked on chain and reported back', async () => {
  let from = tg.sent.length
  say(TG_USER, `/buy ${USDT} 1`)
  const quote = await tg.waitFor(TG_USER.id, (x) => x.buttons.some((b) => b.url?.includes('/swap?')), { from })
  if (!quote.text.includes('NearKit fee none on testnet') || !quote.text.includes('Route NEAR')) throw new Error(`unexpected quote: ${quote.text.slice(0, 200)}`)
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
  await modal.getByText('NEAR → USDT', { exact: true }).first().waitFor({ timeout: 10000 })
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

await step('a NearKit wallet is created in Telegram: one address even on a double tap, and /health says wallets are on', async () => {
  const health = await fetch(`http://127.0.0.1:${API_PORT}/health`).then((r) => r.json())
  if (health.wallets !== 'on') throw new Error(`wallets: ${health.wallets}`)
  let from = tg.sent.length
  say(TG_USER, '/wallet')
  const offer = await tg.waitFor(TG_USER.id, (x) => x.text.includes('not created yet'), { from })
  const create = offer.buttons.find((b) => b.text.includes('Create NearKit wallet'))?.callback_data
  if (!create?.startsWith('cw:new:')) throw new Error(`no one-time Create button: ${create}`)
  from = tg.sent.length
  press(TG_USER, create)
  press(TG_USER, create)
  const made = await tg.waitFor(TG_USER.id, (x) => /[0-9a-f]{64}/.test(x.text), { from })
  const address = made.text.match(/[0-9a-f]{64}/)[0]
  await new Promise((r) => setTimeout(r, 300))
  const shown = new Set(tg.sent.slice(from).flatMap((x) => x.text.match(/[0-9a-f]{64}/g) ?? []))
  if (shown.size !== 1) throw new Error(`more than one wallet address: ${[...shown].join(', ')}`)
  from = tg.sent.length
  press(TG_USER, 'cw:dep')
  const dep = await tg.waitFor(TG_USER.id, (x) => x.text.includes('Deposit'), { from })
  if (!dep.text.includes(address) || !dep.text.includes('NEAR Testnet')) throw new Error(`unexpected deposit screen: ${dep.text.slice(0, 200)}`)
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
