// End-to-end pass over Bridge & Buy $KITS in a mainnet build, with nothing live:
//   npm run dev:bridge-e2e     (vite --mode bridge-e2e: mainnet, NEARKITS server = https://api.bridge-e2e.test)
//   node scripts/e2e-bridge.mjs [--base http://localhost:5234] [--shots <dir>]
// The test answers NEARKITS' Bridge & Buy API itself (a scripted order that moves one step per read),
// injects a fake EVM wallet (EIP-6963) and a fake Solana wallet (Wallet Standard) that record what
// they are asked to sign, and aborts every other external request: no quote is live, no funds move.
import { chromium } from 'playwright-core'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const BASE = opt('base', 'http://localhost:5234')
const SHOTS = opt('shots', null)
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
const API = 'https://api.bridge-e2e.test'

const pw = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
const dir = existsSync(pw)
  ? readdirSync(pw)
      .filter((d) => d.startsWith('chromium-'))
      .sort()
      .pop()
  : null
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? (dir ? join(pw, dir, 'chrome-win64', 'chrome.exe') : undefined) })

// ─── base58 (Solana addresses) ─────────────────────────────────────────────
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const b58 = (bytes) => {
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  let out = ''
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out
    n /= 58n
  }
  for (const b of bytes) {
    if (b !== 0) break
    out = '1' + out
  }
  return out
}
const SOL_ADDRESS = b58(Array.from({ length: 32 }, (_, i) => i + 1))
const EVM_ADDRESS = '0x1111111111111111111111111111111111111111'
const DEPOSIT = { sol: b58(Array.from({ length: 32 }, (_, i) => 200 - i)), eth: '0x' + 'de'.repeat(20), bsc: '0x' + 'bd'.repeat(20) }
const ONE_NEAR = 10n ** 24n
const CHAINS = {
  sol: { decimals: 9, symbol: 'SOL', name: 'Solana', nearPerUnit: 21n * ONE_NEAR, min: 1_000_000n },
  eth: { decimals: 18, symbol: 'ETH', name: 'Ethereum', nearPerUnit: 476n * ONE_NEAR, min: 10n ** 15n },
  bsc: { decimals: 18, symbol: 'BNB', name: 'BNB Chain', nearPerUnit: 142n * ONE_NEAR, min: 10n ** 16n },
}
const KITS_PER_NEAR = 6_000n * 10n ** 18n
const parseUnits = (text, decimals) => {
  const [w, f = ''] = text.split('.')
  return BigInt(w || '0') * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0')
}

/** NEARKITS' Bridge & Buy API, scripted: quotes from fixed rates, orders that move one step per read. */
function fakeServer() {
  const orders = new Map()
  const log = { quotes: [], starts: [], deposits: [] }
  const quoteOf = (req) => {
    const c = CHAINS[req.chain]
    const amountIn = parseUnits(req.amount, c.decimals)
    if (amountIn < c.min) return { status: 400, body: { error: { code: 'minimum', message: 'The amount is below the minimum for this route.' } } }
    const nearOut = (amountIn * c.nearPerUnit * 9950n) / (10n ** BigInt(c.decimals) * 10_000n)
    const kitsOut = (nearOut * KITS_PER_NEAR * 9_800n) / (ONE_NEAR * 10_000n)
    return {
      status: 200,
      body: {
        chain: req.chain,
        amountIn: amountIn.toString(),
        amountInUsd: 115,
        nearOut: nearOut.toString(),
        nearMinOut: ((nearOut * 99n) / 100n).toString(),
        nearOutUsd: 114,
        fee: { nearkitsBps: 25, intentsBps: 25, nearkitsRaw: ((amountIn * 25n) / 10_000n).toString(), intentsRaw: ((amountIn * 25n) / 10_000n).toString() },
        timeEstimateSec: 20,
        refundFee: null,
        kits: {
          amountOut: kitsOut.toString(),
          minOut: ((kitsOut * 99n) / 100n).toString(),
          tradingFeeBps: 50,
          nearIn: nearOut.toString(),
          slippagePct: req.kitsSlippagePct,
          priceImpactPct: null,
        },
        kitsUnavailable: null,
        quotedAt: Date.now(),
      },
    }
  }
  /** The path an order takes, by amount: 0.5 is refunded, 0.7 stops before the purchase, anything else completes. */
  const pathOf = (amount) =>
    amount === '0.5'
      ? ['awaiting-deposit', 'deposit-seen', 'bridging', 'refunded']
      : amount === '0.7'
        ? ['awaiting-deposit', 'deposit-seen', 'bridging', 'delivered', 'buying', 'buy-needed']
        : ['awaiting-deposit', 'deposit-seen', 'bridging', 'delivered', 'buying', 'complete']
  const view = (o) => {
    const status = o.path[o.step]
    const q = o.quote
    const reached = (s) => o.path.indexOf(s) >= 0 && o.step >= o.path.indexOf(s)
    return {
      id: o.id,
      status,
      chain: o.chain,
      sourceAddress: o.sourceAddress,
      depositAddress: DEPOSIT[o.chain],
      depositDeadline: o.createdAt + 20 * 60_000,
      signBy: o.createdAt + 5 * 60_000,
      quote: q,
      destination: { kind: 'nearkits', accountId: o.accountId, walletId: o.walletId, name: o.walletName },
      depositTx: o.depositTx ? { hash: o.depositTx, url: `https://explorer.test/tx/${o.depositTx}` } : null,
      delivered: reached('delivered')
        ? { amount: q.nearOut, asset: 'near', txs: [{ hash: 'Dlv1111111111111111111111111111111111111111', url: 'https://nearblocks.io/txns/Dlv' }] }
        : null,
      kits: status === 'complete' ? { amount: q.kits.amountOut, txs: [{ hash: 'Kts1111111111111111111111111111111111111111', url: 'https://nearblocks.io/txns/Kts' }] } : null,
      refund: status === 'refunded' ? { amount: q.amountIn, reason: 'Deposit deadline passed', txs: [] } : null,
      message:
        status === 'buy-needed'
          ? 'The $KITS price moved beyond your slippage while the NEAR was bridging, so nothing was bought. Your NEAR is in the wallet.'
          : status === 'refunded'
            ? 'NEAR Intents couldn’t complete it and refunded your address on the source chain.'
            : null,
      createdAt: o.createdAt,
      updatedAt: Date.now(),
    }
  }
  const wallets = [
    { id: 'w1', accountId: 'a'.repeat(64), name: 'Main', slot: 1, owner: null, frozen: false, createdAt: 1 },
    { id: 'w2', accountId: 'b'.repeat(64), name: 'Degen 1', slot: 2, owner: null, frozen: false, createdAt: 2 },
  ]
  return {
    log,
    orders,
    handle(path, body) {
      if (path === '/api/web/wallets') return { status: 200, body: { wallets, limit: 10, canCreate: true } }
      if (path === '/api/bridge/assets')
        return {
          status: 200,
          body: {
            chains: Object.entries(CHAINS).map(([id, c]) => ({ id, name: c.name, symbol: c.symbol, decimals: c.decimals, priceUsd: 1 })),
            destination: { token: 'kits.nearlytrade.near', symbol: 'KITS', name: 'Near Kits', decimals: 18 },
            feeBps: 25,
            tradingFeeBps: 50,
            custody: true,
          },
        }
      if (path === '/api/bridge/quote') {
        log.quotes.push(body)
        return quoteOf(body)
      }
      if (path === '/api/bridge/start') {
        log.starts.push(body)
        const q = quoteOf(body)
        if (q.status !== 200) return q
        const w = wallets.find((x) => x.id === body.destination.walletId)
        const id = `ord${orders.size + 1}xxxxxxxx`
        orders.set(id, {
          id,
          chain: body.chain,
          sourceAddress: body.sourceAddress,
          quote: q.body,
          path: pathOf(body.amount),
          step: 0,
          depositTx: null,
          createdAt: Date.now(),
          accountId: w.accountId,
          walletId: w.id,
          walletName: w.name,
        })
        return { status: 200, body: view(orders.get(id)) }
      }
      const o = orders.get(body.orderId)
      if (path === '/api/bridge/deposit') {
        log.deposits.push(body)
        o.depositTx = body.txHash
        return { status: 200, body: view(o) }
      }
      if (path === '/api/bridge/order') {
        if (!o) return { status: 404, body: { error: { code: 'not-found', message: 'That Bridge & Buy order isn’t yours, or it’s gone.' } } }
        // Once the transfer is recorded, each read moves the order one step on.
        if (o.depositTx && o.step < o.path.length - 1) o.step += 1
        return { status: 200, body: view(o) }
      }
      if (path === '/api/bridge/orders') return { status: 200, body: { orders: [...orders.values()].map(view) } }
      if (path === '/api/bridge/solana')
        return {
          status: 200,
          body: body.method === 'blockhash' ? { blockhash: b58(Array.from({ length: 32 }, () => 9)), lastValidBlockHeight: 1 } : { lamports: String(5n * 10n ** 9n) },
        }
      return { status: 503, body: { error: { code: 'unavailable', message: 'not in this test' } } }
    },
  }
}

/** The fake wallets, injected before the app loads: they record what they are asked to sign. */
function injectWallets({ solAddress, evmAddress }) {
  const log = (window.__bb = { evm: [], sol: [] })
  let chainId = '0x1'
  let bscKnown = false
  const listeners = {}
  const provider = {
    async request({ method, params }) {
      log.evm.push({ method, params })
      if (method === 'eth_requestAccounts') return [evmAddress]
      if (method === 'eth_chainId') return chainId
      if (method === 'wallet_switchEthereumChain') {
        const id = params[0].chainId
        if (id === '0x38' && !bscKnown) throw Object.assign(new Error('Unrecognized chain ID'), { code: 4902 })
        chainId = id
        return null
      }
      if (method === 'wallet_addEthereumChain') {
        bscKnown = true
        chainId = params[0].chainId
        return null
      }
      if (method === 'eth_getBalance') return '0x' + (5n * 10n ** 18n).toString(16)
      if (method === 'eth_sendTransaction') return '0x' + 'ab'.repeat(32)
      throw Object.assign(new Error(`unsupported ${method}`), { code: 4200 })
    },
    on(e, cb) {
      ;(listeners[e] ??= []).push(cb)
    },
    removeListener() {},
  }
  const icon = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4='
  window.addEventListener('eip6963:requestProvider', () =>
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'e2e-evm', name: 'E2E EVM', icon, rdns: 'test.e2e' }, provider }) })),
  )
  const account = { address: solAddress, publicKey: new Uint8Array(32), chains: ['solana:mainnet'], features: [] }
  const wallet = {
    version: '1.0.0',
    name: 'E2E Solana',
    icon,
    chains: ['solana:mainnet'],
    accounts: [],
    features: {
      'standard:connect': {
        version: '1.0.0',
        connect: async () => {
          wallet.accounts = [account]
          return { accounts: wallet.accounts }
        },
      },
      'solana:signAndSendTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy'],
        signAndSendTransaction: async (...inputs) => {
          log.sol.push(Array.from(inputs[0].transaction))
          return [{ signature: new Uint8Array(64).fill(7) }]
        },
      },
    },
  }
  const register = (api) => api.register(wallet)
  window.addEventListener('wallet-standard:app-ready', (e) => register(e.detail))
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }))
  localStorage.setItem(
    'nearkit:web-session:mainnet',
    JSON.stringify({ token: 'e2e-session-token-000000000000000000', expiresAt: Date.now() + 3_600_000, userName: 'E2E', userHandle: null }),
  )
}

const results = []
const step = async (name, fn) => {
  const started = Date.now()
  try {
    await fn()
    results.push({ name, ok: true, ms: Date.now() - started })
    console.log(`  ✓ ${name}`)
  } catch (e) {
    results.push({ name, ok: false, error: e.message })
    console.log(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`)
  }
}

async function openPage(width = 1440) {
  const server = fakeServer()
  const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 900 } })
  await context.addInitScript(injectWallets, { solAddress: SOL_ADDRESS, evmAddress: EVM_ADDRESS })
  const external = []
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin === new URL(BASE).origin || url.protocol === 'data:') return route.continue()
    if (url.origin === API) {
      const body = route.request().postData() ? JSON.parse(route.request().postData()) : {}
      const r = server.handle(url.pathname, body)
      return route.fulfill({ status: r.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(r.body) })
    }
    external.push(url.origin)
    return route.abort()
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|net::ERR|ERR_FAILED|status of 50\d|status of 40\d/.test(m.text())) errors.push(m.text())
  })
  return { context, page, server, errors, external }
}

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
const wallet = (page) => page.evaluate(() => window.__bb)

async function fillAndQuote(page, { chain, amount, walletButton, destination = 'Degen 1' }) {
  await page.goto(BASE + '/bridge', { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { level: 1, name: 'Bridge & Buy' }).waitFor()
  await page.getByRole('radio', { name: new RegExp(`^${chain}`) }).click()
  const connect = page.getByRole('button', { name: `Connect ${walletButton}` })
  if (await connect.isVisible().catch(() => false)) await connect.click()
  await page.getByLabel('You send').fill(amount)
  await page.getByLabel('Receiving wallet (NEAR)').selectOption({ label: destination })
}

console.log(`Bridge & Buy e2e against ${BASE}`)

await step('SOL → $KITS: connect a Solana wallet, quote, review, the wallet sends exactly the quote to the deposit address, progress to complete', async () => {
  const { context, page, server, errors } = await openPage()
  await fillAndQuote(page, { chain: 'SOL', amount: '1', walletButton: 'E2E Solana' })
  const route = page.getByRole('region', { name: 'Route and quote' })
  await route.getByText('≈ 122,862.6 KITS').waitFor({ timeout: 15_000 })
  const text = await route.innerText()
  for (const want of ['NEARKITS fee (0.25%)', '0.0025 SOL', 'NEAR Intents fee (0.25%)', '≈ 20.895 NEAR', '$KITS trading fee (0.50%)'])
    if (!text.includes(want)) throw new Error(`route panel lacks “${want}”: ${text.replace(/\s+/g, ' ')}`)
  const quote = server.log.quotes.at(-1)
  if (quote.chain !== 'sol' || quote.amount !== '1' || quote.sourceAddress !== SOL_ADDRESS || quote.destination.walletId !== 'w2')
    throw new Error(`quote asked: ${JSON.stringify(quote)}`)
  await page.getByRole('button', { name: 'Bridge & Buy $KITS' }).click()
  const dialog = page.getByRole('dialog', { name: 'Review Bridge & Buy' })
  await dialog.waitFor()
  const review = await dialog.innerText()
  for (const want of ['Send within', '1 SOL', 'Degen 1', 'Two steps', 'Refunds go to']) if (!review.includes(want)) throw new Error(`review lacks “${want}”`)
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'bridge-review-1440.png') })
  await dialog.getByRole('button', { name: 'Confirm in E2E Solana' }).click()
  await page.waitForURL(/\?order=/)
  const tx = (await wallet(page)).sol[0]
  if (!tx) throw new Error('the Solana wallet was asked to sign nothing')
  const msg = tx.slice(65)
  const to = msg.slice(4 + 32, 4 + 64)
  const lamports = msg.slice(-8).reduce((n, b, i) => n | (BigInt(b) << BigInt(8 * i)), 0n)
  if (b58(to) !== DEPOSIT.sol) throw new Error(`sent to ${b58(to)}, not the deposit address`)
  if (lamports !== 1_000_000_000n) throw new Error(`sent ${lamports} lamports, not exactly 1 SOL`)
  if (b58(msg.slice(4, 36)) !== SOL_ADDRESS) throw new Error('sent from another address')
  if (server.log.deposits[0]?.txHash !== b58(new Array(64).fill(7))) throw new Error('the transfer wasn’t recorded with NEARKITS’ server')
  await page.getByText('$KITS purchase complete').first().waitFor({ timeout: 60_000 })
  const done = await page.getByRole('region', { name: 'Bridge & Buy progress' }).innerText()
  if (!/You received\s+122,862\.6 KITS/i.test(done)) throw new Error(`success screen: ${done.replace(/\s+/g, ' ').slice(0, 200)}`)
  for (const name of ['View $KITS', 'View activity']) if (!(await page.getByRole('link', { name }).isVisible())) throw new Error(`no ${name}`)
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'bridge-complete-1440.png'), fullPage: true })
  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`)
  await context.close()
})

await step('ETH → $KITS: the EVM wallet is put on Ethereum and sends exactly the quoted wei to the deposit address', async () => {
  const { context, page, server, errors } = await openPage()
  await fillAndQuote(page, { chain: 'ETH', amount: '0.1', walletButton: 'E2E EVM', destination: 'Main' })
  await page.getByRole('region', { name: 'Route and quote' }).getByText('0.00025 ETH').first().waitFor({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Bridge & Buy $KITS' }).click()
  await page.getByRole('dialog', { name: 'Review Bridge & Buy' }).getByRole('button', { name: 'Confirm in E2E EVM' }).click()
  await page.waitForURL(/\?order=/)
  const sent = (await wallet(page)).evm.filter((r) => r.method === 'eth_sendTransaction')
  if (sent.length !== 1) throw new Error(`${sent.length} transactions sent`)
  const p = sent[0].params[0]
  if (p.to !== DEPOSIT.eth || BigInt(p.value) !== 10n ** 17n || p.from !== EVM_ADDRESS) throw new Error(`sent ${JSON.stringify(p)}`)
  if (server.log.starts[0].destination.walletId !== 'w1') throw new Error('wrong receiving wallet')
  await page.getByText('$KITS purchase complete').first().waitFor({ timeout: 60_000 })
  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`)
  await context.close()
})

await step('BNB → $KITS: a wallet without BNB Chain is asked to add it, then sends on chain 56', async () => {
  const { context, page, errors } = await openPage()
  await fillAndQuote(page, { chain: 'BNB', amount: '2', walletButton: 'E2E EVM' })
  await page.getByRole('region', { name: 'Route and quote' }).getByText('0.005 BNB').first().waitFor({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Bridge & Buy $KITS' }).click()
  await page.getByRole('dialog', { name: 'Review Bridge & Buy' }).getByRole('button', { name: 'Confirm in E2E EVM' }).click()
  await page.waitForURL(/\?order=/)
  const calls = (await wallet(page)).evm
  if (!calls.some((r) => r.method === 'wallet_addEthereumChain' && r.params[0].chainId === '0x38')) throw new Error('BNB Chain was never added')
  const sent = calls.find((r) => r.method === 'eth_sendTransaction')?.params[0]
  if (!sent || sent.to !== DEPOSIT.bsc || BigInt(sent.value) !== 2n * 10n ** 18n) throw new Error(`sent ${JSON.stringify(sent)}`)
  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`)
  await context.close()
})

await step('below the minimum: NEAR Intents’ refusal is said plainly, nothing can be started, no NaN anywhere', async () => {
  const { context, page } = await openPage()
  await fillAndQuote(page, { chain: 'SOL', amount: '0.0001', walletButton: 'E2E Solana' })
  await page.getByText('The amount is below the minimum for this route.').first().waitFor({ timeout: 15_000 })
  if (await page.getByRole('button', { name: 'Bridge & Buy $KITS' }).isEnabled()) throw new Error('the key is enabled below the minimum')
  if ((await page.locator('body').innerText()).includes('NaN')) throw new Error('NaN on the page')
  await context.close()
})

await step('refunded: says so, no $KITS claimed, a new Bridge & Buy offered', async () => {
  const { context, page } = await openPage()
  await fillAndQuote(page, { chain: 'SOL', amount: '0.5', walletButton: 'E2E Solana' })
  await page.getByRole('button', { name: 'Bridge & Buy $KITS' }).click({ timeout: 15_000 })
  await page.getByRole('dialog', { name: 'Review Bridge & Buy' }).getByRole('button', { name: 'Confirm in E2E Solana' }).click()
  // The order's own panel says it (the list below may learn it a moment earlier).
  const progress = page.getByRole('region', { name: 'Bridge & Buy progress' })
  await progress.getByRole('button', { name: 'New Bridge & Buy' }).waitFor({ timeout: 60_000 })
  const text = await progress.innerText()
  if (!/Refunded/i.test(text)) throw new Error('the refund isn’t said')
  if (/purchase complete/i.test(text)) throw new Error('a refund reads as complete')
  await context.close()
})

await step('bridged but not bought: “Bridge completed, $KITS not bought”, the NEAR said to be in the wallet, Swap offered (no automatic retry)', async () => {
  const { context, page, server } = await openPage()
  await fillAndQuote(page, { chain: 'SOL', amount: '0.7', walletButton: 'E2E Solana' })
  await page.getByRole('button', { name: 'Bridge & Buy $KITS' }).click({ timeout: 15_000 })
  await page.getByRole('dialog', { name: 'Review Bridge & Buy' }).getByRole('button', { name: 'Confirm in E2E Solana' }).click()
  await page.getByText('Bridge completed, $KITS not bought').first().waitFor({ timeout: 60_000 })
  const link = page.getByRole('link', { name: 'Buy $KITS on Swap' })
  if (!/\/swap\?from=near&token=kits\.nearlytrade\.near&amount=/.test((await link.getAttribute('href')) ?? '')) throw new Error(`Swap link: ${await link.getAttribute('href')}`)
  if (server.log.starts.length !== 1) throw new Error('a second order was started on its own')
  await context.close()
})

await step('Activity lists each Bridge & Buy, linked to its order; a reload of the order finds it again', async () => {
  const { context, page } = await openPage()
  await fillAndQuote(page, { chain: 'SOL', amount: '1', walletButton: 'E2E Solana' })
  await page.getByRole('button', { name: 'Bridge & Buy $KITS' }).click({ timeout: 15_000 })
  await page.getByRole('dialog', { name: 'Review Bridge & Buy' }).getByRole('button', { name: 'Confirm in E2E Solana' }).click()
  await page.waitForURL(/\?order=/)
  const url = page.url()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('region', { name: 'Bridge & Buy progress' }).waitFor()
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  const entry = page.getByRole('list', { name: 'Recent activity' }).getByRole('link', { name: 'Bridge & Buy' }).first()
  await entry.waitFor({ timeout: 20_000 })
  if (!url.endsWith(await entry.getAttribute('href'))) throw new Error(`activity links ${await entry.getAttribute('href')}, the order is ${url}`)
  await context.close()
})

await step('entry points: the sidebar’s Bridge & Buy, the $KITS page’s Bridge & Buy $KITS', async () => {
  const { context, page } = await openPage()
  await page.goto(BASE + '/kit', { waitUntil: 'domcontentloaded' })
  await page.getByRole('link', { name: 'Bridge & Buy $KITS' }).click()
  await page.waitForURL(/\/bridge$/)
  await page.getByRole('navigation').getByRole('link', { name: 'Bridge & Buy' }).first().waitFor()
  await context.close()
})

for (const width of [1920, 1440, 1280, 1024, 820, 768, 390, 375, 360]) {
  await step(`layout at ${width}px: the form with a quote and a finished order fit, no horizontal scroll, no page error`, async () => {
    const { context, page, errors } = await openPage(width)
    await fillAndQuote(page, { chain: 'SOL', amount: '1', walletButton: 'E2E Solana' })
    await page.getByRole('region', { name: 'Route and quote' }).getByText('≈ 122,862.6 KITS').waitFor({ timeout: 15_000 })
    const form = await overflow(page)
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `bridge-form-${width}.png`), fullPage: true })
    await page.getByRole('button', { name: 'Bridge & Buy $KITS' }).click()
    await page.getByRole('dialog', { name: 'Review Bridge & Buy' }).getByRole('button', { name: 'Confirm in E2E Solana' }).click()
    await page.getByText('$KITS purchase complete').first().waitFor({ timeout: 60_000 })
    const done = await overflow(page)
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `bridge-complete-${width}.png`), fullPage: true })
    if (form > 0 || done > 0) throw new Error(`horizontal overflow: form ${form}px, order ${done}px`)
    if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`)
    await context.close()
  })
}

await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
