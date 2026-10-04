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

await step('a NearKit wallet is created in Telegram: one address even on a double tap, and /health says wallets are on', async () => {
  const health = await fetch(`http://127.0.0.1:${API_PORT}/health`).then((r) => r.json())
  if (health.wallets !== 'on') throw new Error(`wallets: ${health.wallets}`)
  if (health.signer !== 'ok') throw new Error(`signer: ${health.signer}`)
  if (health.pauses?.trading !== false || health.pauses?.withdrawals !== false) throw new Error(`pauses: ${JSON.stringify(health.pauses)}`)
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

await step('NearKit web: /web sends a one-time sign-in link, and the site lists the NearKit wallets with no browser wallet', async () => {
  const from = tg.sent.length
  say(TG_USER, '/web')
  const m = await tg.waitFor(TG_USER.id, (x) => x.buttons.some((b) => b.url?.includes('/wallets#login=')), { from })
  if (!m.text.includes('one-time sign-in link')) throw new Error(`unexpected /web answer: ${m.text.slice(0, 200)}`)
  webLogin = m.buttons.find((b) => b.url?.includes('#login=')).url
  if (!webLogin.startsWith(`${WEB}/wallets#login=`)) throw new Error(`unexpected link ${webLogin}`)
  near.state.accounts.set(mainAddress, { amount: String(3n * ONE) })
  page = await newPage({ accounts: [USER], walletName: 'E2E Test Wallet' })
  await page.goto(webLogin, { waitUntil: 'networkidle' })
  await page.getByText('Signed in as Tess').waitFor()
  if (page.url().includes('#login=')) throw new Error('the sign-in code stayed in the address bar')
  const table = page.getByRole('table', { name: 'NearKit wallets' })
  await table.getByText('Main', { exact: true }).waitFor()
  await table.getByText('3.00').waitFor()
  if ((await page.getByRole('button', { name: 'Connect wallet' }).count()) === 0) throw new Error('the page claims a browser wallet is connected')
  await shot('tg-06-web-wallets')
})

await step('a used sign-in link signs nobody in', async () => {
  const other = await newPage({ accounts: [USER] })
  await other.goto(webLogin, { waitUntil: 'networkidle' })
  await other.getByText(/expired or was already used/).waitFor()
  await other.context().close()
})

await step('Create wallet on NearKit web: named, listed at once, announced in Telegram, no key on the page', async () => {
  const from = tg.sent.length
  await page.getByRole('button', { name: 'Create wallet' }).first().click()
  const modal = page.getByRole('dialog', { name: 'Create a NearKit wallet' })
  await modal.getByLabel('Name').fill('Degen 1')
  await modal.getByRole('button', { name: 'Create wallet' }).click()
  await page.getByText('Degen 1 created').waitFor()
  await page.getByRole('table', { name: 'NearKit wallets' }).getByText('Degen 1', { exact: true }).waitFor()
  await tg.waitFor(TG_USER.id, (x) => x.text.includes('NearKit wallet created on NearKit web') && x.text.includes('Degen 1'), { from })
  const list = await webApi('/api/web/wallets', {})
  const degen = list.json?.wallets?.find((w) => w.name === 'Degen 1')
  if (!degen || !/^[0-9a-f]{64}$/.test(degen.accountId)) throw new Error(`not listed: ${JSON.stringify(list.json)}`)
  degenAddress = degen.accountId
  // The notice shows the address shortened; its Copy address key carries the full id from the wallet record.
  const notice = tg.sent.slice(from).find((x) => x.chatId === TG_USER.id && x.text.includes('NearKit wallet created on NearKit web'))
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

await step('Rename on NearKit web changes the name only', async () => {
  await page.getByRole('button', { name: 'Rename Degen 1' }).first().click()
  const modal = page.getByRole('dialog', { name: 'Rename Degen 1' })
  await modal.getByLabel('Name').fill('Sniper A')
  await modal.getByRole('button', { name: 'Save name' }).click()
  await page.getByText('Renamed to Sniper A').waitFor()
  const list = await webApi('/api/web/wallets', {})
  const w = list.json?.wallets?.find((x) => x.name === 'Sniper A')
  if (!w || w.accountId !== degenAddress) throw new Error('the rename changed more than the name')
})

await step('Order and delete on NearKit web: the server keeps the order; an empty wallet is deleted the bot’s way and Telegram is told', async () => {
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
  await page.getByRole('table', { name: 'NearKit wallets' }).locator('tbody tr').first().getByText('Sniper A').waitFor()
  // An empty wallet, deleted through its confirmation.
  await webApi('/api/web/wallets/create', { name: 'Temp', createKey: 'e2e-manage-temp-0001' })
  await page.reload({ waitUntil: 'networkidle' })
  const from = tg.sent.length
  await page.getByRole('button', { name: 'Delete Temp' }).first().click()
  await page.getByRole('dialog', { name: 'Delete Temp?' }).getByRole('button', { name: 'Delete wallet' }).click()
  await page.getByText('Temp deleted').waitFor()
  await until('Sniper A,Main')
  await tg.waitFor(TG_USER.id, (x) => x.text.includes('NearKit wallet deleted on NearKit web') && x.text.includes('Temp'), { from })
  // Back to the order the steps after this one expect.
  await webApi('/api/web/wallets/order', { walletIds: [main.id, sniper.id] })
  await page.reload({ waitUntil: 'networkidle' })
  // The same keys on a phone (captured with --shots).
  if (SHOTS) {
    await page.setViewportSize({ width: 360, height: 800 })
    await page.getByRole('list', { name: 'NearKit wallets' }).waitFor()
    await shot('tg-11-wallets-360')
    await page.setViewportSize({ width: 1280, height: 900 })
  }
})

await step('Multi Buy across NearKit wallets runs from the web: the server quotes each wallet, Execute runs each one, and Telegram takes no part', async () => {
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
  await modal.getByText('NearKit fee', { exact: true }).first().waitFor()
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

await step('a single Buy from a NearKit wallet in the normal trade ticket: no browser wallet to connect, no Telegram; NearKit runs it', async () => {
  await page.goto(WEB + `/token/${USDT}`, { waitUntil: 'networkidle' })
  const from = tg.sent.length
  await page.locator('main').getByRole('button', { name: 'Buy USDT' }).click()
  const sheet = page.getByRole('dialog', { name: 'Trade ticket' })
  await sheet.getByLabel('Trade from wallet').waitFor()
  if (await sheet.getByRole('button', { name: 'Connect wallet' }).count()) throw new Error('the ticket asks to connect a wallet for a NearKit wallet')
  await sheet.getByText(/NearKit executes it from/).waitFor()
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

await step('Send from a NearKit wallet is reviewed and sent from the web; an unapproved address says how it gets approved; Telegram takes no part', async () => {
  near.state.accounts.set('friend.testnet', { amount: String(ONE) })
  await page.goto(WEB + '/wallets', { waitUntil: 'networkidle' })
  await page.getByRole('table', { name: 'NearKit wallets' }).getByRole('button', { name: 'Send' }).first().click()
  const modal = page.getByRole('dialog', { name: 'Send from Main' })
  const from = tg.sent.length
  // An address the owner wallet never approved: refused, with how it gets approved.
  await modal.getByLabel('Amount').fill('0.5')
  await modal.getByLabel('To').fill('friend.testnet')
  await modal.getByRole('button', { name: 'Review', exact: true }).click()
  await modal.getByText(/friend\.testnet isn’t approved for Main yet/).waitFor()
  await modal.getByRole('link', { name: /Approve it with/ }).waitFor()
  // The shortcut to one of the user's own NearKit wallets fills in its full account id, and that
  // address is reviewed like any other: here it isn't approved either, so nothing is sent.
  const sniper = (await webApi('/api/web/wallets', {})).json?.wallets?.find((x) => x.name === 'Sniper A')
  await modal.getByLabel('Pick one of my NearKit wallets as the destination').selectOption(sniper.accountId)
  if ((await modal.getByLabel('To').inputValue()) !== sniper.accountId) throw new Error('the shortcut did not fill in the full account id')
  await modal.getByRole('button', { name: 'Review', exact: true }).click()
  await modal.getByText(new RegExp(`${sniper.accountId.slice(0, 6)}.*isn’t approved for Main yet`)).waitFor()
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
  if (tg.sent.slice(from).some((m) => m.chatId === TG_USER.id)) throw new Error('Telegram took part in a web send')
  await page.keyboard.press('Escape')
})

await step(
  'Recover: Connect <owner> signs the wallet out first; another NEAR account or an EVM address is an error, never "Wallet connected"; on the owner the approval goes through',
  async () => {
    const EVM = '0x52908400098527886E0F7030069857D2E4169EE7'
    const rp = await newPage({ accounts: [USER], walletName: 'E2E Test Wallet', signingKey: { jwk, publicKey: PUBLIC_KEY } })
    const setAccounts = (accounts) => rp.evaluate((a) => (window.__NEARKIT_E2E_WALLET__.accounts = a), accounts)
    // The browser wallet is on the NearKit wallet's own account (its exported key imported there), not on its owner.
    await rp.goto(WEB + '/', { waitUntil: 'networkidle' })
    await rp.evaluate((a) => sessionStorage.setItem('nearkit:e2e:session', JSON.stringify([a])), mainAddress)
    await rp.goto(`${WEB}/recover#approve=${mainAddress}&to=friend.testnet`, { waitUntil: 'networkidle' })
    await rp.getByRole('button', { name: 'Prepare the approval' }).click()
    await rp.getByText(`Your wallet returned ${mainAddress}, not ${USER}.`).waitFor({ timeout: 15000 })
    await rp.getByRole('button', { name: `Connect ${USER}` }).click()
    const dialog = rp.getByRole('dialog', { name: `Connect ${USER}` })
    const pick = () => dialog.getByRole('button', { name: /E2E Test Wallet/ }).click()
    // Still the same account after the reconnect: an error naming it, and no "Wallet connected".
    await setAccounts([mainAddress])
    await pick()
    await dialog.getByRole('alert').getByText(`Your wallet returned ${mainAddress}, not ${USER}. Switch to ${USER} in your wallet, then try again.`).waitFor()
    if (SHOTS) await rp.screenshot({ path: join(SHOTS, 'tg-10a-recover-other-account.png') })
    // Only an EVM address: named as one, never as the connected account.
    await setAccounts([EVM])
    await pick()
    await dialog
      .getByRole('alert')
      .getByText(`Your wallet returned an EVM address (${EVM}), not a NEAR account. Switch to the NEAR account ${USER} in your wallet, then try again.`)
      .waitFor()
    if ((await rp.getByText('Wallet connected').count()) !== 0) throw new Error('"Wallet connected" was shown for an account that is not the owner')
    if (SHOTS) await rp.screenshot({ path: join(SHOTS, 'tg-10b-recover-evm-only.png') })
    // The wallet switched to the owner: connected, and its signature approves the destination.
    await setAccounts([USER])
    await pick()
    await dialog.waitFor({ state: 'hidden' })
    await rp.getByText('Wallet connected').first().waitFor()
    await rp.getByRole('button', { name: 'Sign to approve friend.testnet' }).click()
    await rp.getByText(/^Approved\./).waitFor({ timeout: 15000 })
    const signers = await rp.evaluate(() => (window.__NEARKIT_E2E_MESSAGES__ ?? []).map((m) => m.signerId))
    if (signers.join() !== USER) throw new Error(`the wallet was asked to sign as: ${signers.join() || 'nobody'}`)
    await rp.context().close()
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
  await tg.waitFor(TG_USER.id, (x) => x.text.includes('Signed out of NearKit web'), { from })
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
    .getByText(/secure NearKit wallet actions and approvals/)
    .first()
    .waitFor()
  if ((await tg.getByRole('alert').count()) !== 0) throw new Error('a direct open showed an error')
  await tg.getByRole('button', { name: 'Back to NearKit bot' }).click()
  if ((await tg.evaluate(() => window.__nearkitClosed)) !== true) throw new Error('Back to NearKit bot did not close the Mini App')
  // Outside Telegram: no launch data at all.
  await tg.goto(WEB + '/tg', { waitUntil: 'networkidle' })
  await tg
    .getByText(/Open it from NearKit’s bot in Telegram/)
    .first()
    .waitFor()
  await tg.getByRole('link', { name: 'Open NearKit in Telegram' }).waitFor()
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
  if (/Open it from NearKit’s bot/.test(reason) || !/request|approval|Telegram/i.test(reason)) throw new Error(`Unexpected refusal: ${reason}`)
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
