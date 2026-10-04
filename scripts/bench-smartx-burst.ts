/**
 * Read-only check of the reason Rhea quotes are spaced 3 s apart (smartx.ts: "quotes fired in
 * bursts came back with stale no-fee amounts under a signed fee"). Bursts of fee-bearing quotes
 * for different wallets are compared with spaced fee and no-fee references taken around them:
 * NearKit's fee is 0.5%, far more than a few seconds of price drift, so an answer carrying the
 * no-fee amount stands out. Nothing is signed or sent.
 *
 *   npx vite-node --config vite.server.config.ts scripts/bench-smartx-burst.ts [trials] [burst]
 */
import { NETWORKS } from '@/config/networks'
import { NEARKIT_FEE_BPS } from '@/lib/fees'
import { decodeSmartxMsg, parseSmartxResponse, smartxQuoteUrl, type SmartxParams } from '@/services/rhea/smartx'

const [trialsArg = '4', burstArg = '8'] = process.argv.slice(2)
const trials = Number(trialsArg)
const burst = Number(burstArg)
const base = NETWORKS.mainnet.rhea.aggregator?.quoteUrl
if (!base) throw new Error('no aggregator on mainnet config')
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
const users = Array.from({ length: burst + 1 }, (_, i) => `${(i + 1).toString(16).padStart(2, '0')}${'ab'.repeat(31)}`)

const pairs: { name: string; tokenIn: string; tokenOut: string; amountIn: bigint; skipUnwrapNativeToken: boolean }[] = [
  { name: 'NEAR→USDt 0.05', tokenIn: 'wrap.near', tokenOut: 'usdt.tether-token.near', amountIn: 5n * 10n ** 22n, skipUnwrapNativeToken: true },
  { name: 'USDt→NEAR 0.25', tokenIn: 'usdt.tether-token.near', tokenOut: 'wrap.near', amountIn: 250_000n, skipUnwrapNativeToken: false },
]

async function ask(p: (typeof pairs)[number], user: string, fee: boolean) {
  const params: SmartxParams = {
    tokenIn: p.tokenIn,
    tokenOut: p.tokenOut,
    amountIn: p.amountIn,
    slippage: 0.01,
    user,
    skipUnwrapNativeToken: p.skipUnwrapNativeToken,
    appFeeRate: fee ? NEARKIT_FEE_BPS : null,
    appFeeRecipient: fee ? 'nearkitfee.near' : null,
  }
  const res = await fetch(smartxQuoteUrl(base as string, params), { headers: { accept: 'application/json' } })
  if (res.status !== 200) return { status: res.status, amountOut: null, feeInMsg: null }
  const q = parseSmartxResponse(await res.json())
  const msg = JSON.stringify(decodeSmartxMsg(q.msg))
  return { status: 200, amountOut: q.amountOut, feeInMsg: msg.includes('nearkitfee.near') }
}

const rel = (a: bigint, b: bigint) => Number(((a - b) * 1_000_000n) / b) / 10_000 // percent
let stale = 0
let total = 0
for (const p of pairs) {
  for (let t = 0; t < trials; t++) {
    const before = await ask(p, users[0] as string, true)
    await pause(3500)
    const noFee = await ask(p, users[0] as string, false)
    await pause(3500)
    const answers = await Promise.all(users.slice(1).map((u) => ask(p, u, true)))
    await pause(3500)
    const after = await ask(p, users[0] as string, true)
    await pause(3500)
    if (!before.amountOut || !after.amountOut || !noFee.amountOut) {
      console.log(`${p.name} trial ${t + 1}: a reference failed (${before.status}/${noFee.status}/${after.status})`)
      continue
    }
    const lo = before.amountOut < after.amountOut ? before.amountOut : after.amountOut
    const hi = before.amountOut < after.amountOut ? after.amountOut : before.amountOut
    const line = answers.map((a) => {
      total++
      if (a.amountOut === null) return `HTTP ${a.status}`
      // Within the fee references (allowing a little drift) or at the no-fee amount.
      const nearNoFee = Math.abs(rel(a.amountOut, noFee.amountOut)) < Math.abs(rel(a.amountOut, lo)) && a.amountOut > hi
      if (nearNoFee) stale++
      return `${nearNoFee ? 'STALE' : 'ok'}(${rel(a.amountOut, lo).toFixed(3)}%${a.feeInMsg ? '' : ',no-fee-msg'})`
    })
    console.log(
      `${p.name} trial ${t + 1}: fee refs ${lo}…${hi} · no-fee ${noFee.amountOut} (${rel(noFee.amountOut, lo).toFixed(3)}%) · burst of ${answers.length}: ${line.join(' ')}`,
    )
  }
}
console.log(`stale no-fee answers in bursts: ${stale}/${total}`)
