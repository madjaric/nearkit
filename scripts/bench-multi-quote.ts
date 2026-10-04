/**
 * Read-only benchmark of NearKit web's Multi Buy review on mainnet: the server's own quote
 * (custody/swap.ts: Rhea's aggregator and DCL routes, registrations, funds, price impact)
 * for several NearKit wallets at once, at different concurrency levels. Nothing is signed or
 * sent; the wallets are only named in the quotes (their accounts are public).
 *
 *   npx vite-node --config vite.server.config.ts scripts/bench-multi-quote.ts [token] [amount] [rounds]
 */
import { NETWORKS } from '@/config/networks'
import { parseEnv } from '@/config/env'
import { mapLimit } from '@/lib/async'
import { createSwapService, type SwapParams } from '../server/src/custody/swap'
import type { TradingWallet } from '../server/src/custody/store'
import { createServerNear } from '../server/src/near'

const [token = 'usdt.tether-token.near', amount = '0.05', roundsArg = '2'] = process.argv.slice(2)
const rounds = Number(roundsArg)

// Ten production NearKit wallets of one owner (public mainnet accounts).
const ACCOUNTS = [
  '45f498b9d5afd557acc9465e3df39220a3bfff67bc129bf78d3f975ae8332810',
  '197aaa83c5517c1501a20136c99fcee5a4008bbd40115711562d192d9bba2caf',
  '2b1a221b6af4adf322cbdc07a8f7d1089f49b02bafac47d8fed17e6547f2c63f',
  '167ac417a161f81b79e1fb135d10fd739446d560a719c706cc8a2401334b6c64',
  '9ab618313889ed1b0b9fe4a32ed2e1f4c147f51afaf98bc48310ea31989bc44f',
  '74218fdc0d78f31e8284a381670ade04526d6eb1aa04c7c5e823d3f07140fcac',
  'f1ea4da45b1e047a2a38a36a43a462b96940f43ac54571636d9740ca253aa4a8',
  '893d7226f652209b272af8350ffaab3a57b12617190c0651bd99d070952ea4e4',
  'db96962b0ecf1e52752e837db9117bd64d51fc663e54c61612f234cf07e1ba56',
  'eb2f3770f5da2d8de058988bcd3fef1a24a4262b0b3823fdb1045e0a8ca95672',
]

const { env, issues } = parseEnv({ VITE_NEARKIT_SERVICES: 'near', VITE_NEAR_NETWORK: 'mainnet', VITE_NEARKIT_FEE_RECIPIENT: 'nearkitfee.near' })
if (issues.length) throw new Error(JSON.stringify(issues))
// Every request the quote makes, timed: host, what it asked (RPC method / path) and how long it took.
const requests: { at: number; host: string; what: string; ms: number; status: number | string }[] = []
const timedFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  let what = url.pathname
  try {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { method?: string; params?: { request_type?: string; method_name?: string } }) : null
    if (body?.method) what = [body.method, body.params?.request_type, body.params?.method_name].filter(Boolean).join(' ')
  } catch {
    // not JSON
  }
  const t = performance.now()
  try {
    const r = await fetch(input, init)
    requests.push({ at: t, host: url.host, what, ms: performance.now() - t, status: r.status })
    return r
  } catch (e) {
    requests.push({ at: t, host: url.host, what, ms: performance.now() - t, status: e instanceof Error ? e.name : 'error' })
    throw e
  }
}
const near = createServerNear({ env, network: NETWORKS.mainnet }, timedFetch)
const swaps = createSwapService(near)
const wallets = ACCOUNTS.map((accountId, i) => ({ id: `bench-${i}`, accountId }) as unknown as TradingWallet)

const meta = await near.tokens.lookupToken(token)
const params: SwapParams = { side: 'buy', token, symbol: meta?.symbol ?? token, decimals: meta?.decimals ?? 24, amountIn: amount, slippagePct: 1 }
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function run(concurrency: number) {
  const started = performance.now()
  const each = await mapLimit(wallets, concurrency, async (w) => {
    const t = performance.now()
    try {
      const q = await swaps.quote(params, w)
      if (process.env.TRACE)
        console.log(`  quote ${w.accountId.slice(0, 6)}: start +${((t - started) / 1000).toFixed(2)} s, end +${((performance.now() - started) / 1000).toFixed(2)} s`)
      return { ms: performance.now() - t, ok: true, source: q.source }
    } catch (e) {
      return { ms: performance.now() - t, ok: false, error: e instanceof Error ? e.message.slice(0, 90) : String(e) }
    }
  })
  return { concurrency, wall: performance.now() - started, each }
}

// Warm the caches every run shares (token metadata, fee config, storage bounds), as a live server has them.
await run(2)
if (process.env.PROFILE) {
  // One quote alone, request by request.
  requests.length = 0
  // Event-loop lag: a tick every 20 ms; anything later means synchronous work held the loop.
  let last = performance.now()
  let blocked = 0
  let worst = 0
  const ticker = setInterval(() => {
    const lag = performance.now() - last - 20
    if (lag > 30) blocked += lag
    worst = Math.max(worst, lag)
    last = performance.now()
  }, 20)
  const t0 = performance.now()
  const one = await run(Number(process.env.PROFILE) || 1).then((r) => r.each[0])
  console.log(`one quote: ${((performance.now() - t0) / 1000 / wallets.length).toFixed(2)} s average over ${wallets.length} (first: ${((one?.ms ?? 0) / 1000).toFixed(2)} s)`)
  clearInterval(ticker)
  if (process.env.TIMELINE)
    for (const r of requests.filter((x) => x.at >= t0).sort((a, b) => a.at - b.at))
      console.log(`  +${((r.at - t0) / 1000).toFixed(2)} s ${(r.ms / 1000).toFixed(2)} s ${r.status} ${r.host} ${r.what}`)
  console.log(`event loop blocked ${(blocked / 1000).toFixed(2)} s in total, worst stall ${(worst / 1000).toFixed(2)} s`)
  const by = new Map<string, { n: number; total: number; max: number; statuses: Set<string> }>()
  for (const r of requests) {
    const k = `${r.host} ${r.what}`
    const e = by.get(k) ?? { n: 0, total: 0, max: 0, statuses: new Set<string>() }
    e.n++
    e.total += r.ms
    e.max = Math.max(e.max, r.ms)
    e.statuses.add(String(r.status))
    by.set(k, e)
  }
  for (const [k, e] of [...by.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 25))
    console.log(`${(e.total / 1000).toFixed(2).padStart(7)} s total · ${String(e.n).padStart(3)}× · max ${(e.max / 1000).toFixed(2)} s · ${[...e.statuses].join(',')} · ${k}`)
  process.exit(0)
}
const order = [3, 10, 5, 1, 10, 3, 5, 1].slice(0, 4 * rounds)
const results: Awaited<ReturnType<typeof run>>[] = []
for (const c of order) {
  results.push(await run(c))
  await pause(3000)
}
const fmt = (ms: number) => (ms / 1000).toFixed(2)
console.log(`token ${token} · ${amount} NEAR · ${wallets.length} wallets · ${rounds} rounds`)
for (const c of [1, 3, 5, 10]) {
  const rs = results.filter((r) => r.concurrency === c)
  if (!rs.length) continue
  const quotes = rs.flatMap((r) => r.each)
  const sorted = quotes.map((q) => q.ms).sort((a, b) => a - b)
  const failed = quotes.filter((q) => !q.ok)
  console.log(
    `concurrency ${String(c).padStart(2)}: review wall ${rs.map((r) => fmt(r.wall)).join(' / ')} s · per quote median ${fmt(sorted[Math.floor(sorted.length / 2)] ?? 0)} s, max ${fmt(sorted.at(-1) ?? 0)} s · failed ${failed.length}/${quotes.length}${failed.length ? ` (${[...new Set(failed.map((f) => f.error))].join(' | ')})` : ''}`,
  )
}
