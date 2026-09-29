import { base58Decode } from '@/lib/encoding'
import { NearKitError } from '@/services/near/errors'

/**
 * Rhea's aggregator ("Smart Router V2 / Aggregated DEX") on mainnet. Its quote
 * server returns a signed, obfuscated route (`msg` + `signature`) that the
 * `aggregatedex.near` contract executes. NearKit never signs a route it hasn't
 * decoded and checked field by field against the request: signer, recipient,
 * fee rate and account, input amount, output token, DEX contracts and minimums.
 * Everything here was verified against live quotes and on-chain receipts
 * (PHASE2_IMPLEMENTATION.md §12).
 */

export interface SmartxParams {
  tokenIn: string
  tokenOut: string
  amountIn: bigint
  /** Fraction, e.g. 0.005 for 0.5%. */
  slippage: number
  /** The signer. The route is bound to it; null only for an indicative quote. */
  user: string | null
  /** false: deliver native NEAR when the output is wNEAR. */
  skipUnwrapNativeToken: boolean
  /** Integrator fee in bps; sent only together with its recipient. */
  appFeeRate: number | null
  appFeeRecipient: string | null
}

export interface SmartxQuote {
  amountIn: bigint
  amountOut: bigint
  minAmountOut: bigint
  dexs: string[]
  tokens: string[]
  /** Signed route as returned: the exact string that goes on chain. */
  msg: string
  signature: string
}

const unavailable = (message: string, detail?: string) => new NearKitError('QUOTE_UNAVAILABLE', message, detail ? { detail } : {})
const rejected = (message: string, detail?: string) => new NearKitError('QUOTE_REJECTED', `NearKit refused Rhea’s route: ${message}. Nothing was signed.`, detail ? { detail } : {})

const INT = /^\d+$/
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string')

export function smartxQuoteUrl(base: string, p: SmartxParams): string {
  const url = new URL(base)
  url.searchParams.set('amountIn', p.amountIn.toString())
  url.searchParams.set('tokenIn', p.tokenIn)
  url.searchParams.set('tokenOut', p.tokenOut)
  url.searchParams.set('slippage', String(p.slippage))
  url.searchParams.set('pathDeep', '3')
  if (p.user) url.searchParams.set('user', p.user)
  url.searchParams.set('skipUnwrapNativeToken', String(p.skipUnwrapNativeToken))
  if (p.appFeeRate !== null && p.appFeeRecipient) {
    url.searchParams.set('appFeeRate', String(p.appFeeRate))
    url.searchParams.set('appFeeRecipient', p.appFeeRecipient)
  }
  return url.toString()
}

export function parseSmartxResponse(json: unknown): SmartxQuote {
  if (!obj(json)) throw unavailable('Rhea’s quote service returned something that isn’t a quote')
  const data = json.result_data
  if (json.result_code !== 0 || !obj(data)) {
    const reason = typeof json.result_message === 'string' && json.result_message ? json.result_message : 'no route'
    throw unavailable(`Rhea found no route for this trade (${reason})`)
  }
  const { amount_in, amount_out, min_amount_out, msg, signature, tokens, dexs } = data
  // A pair Rhea cannot route still answers code 0, with zero amounts and a signed route that has no steps.
  if (amount_out === '0' && Array.isArray(dexs) && dexs.length === 0) throw unavailable('Rhea found no route for this trade')
  if (
    typeof amount_in !== 'string' ||
    !INT.test(amount_in) ||
    typeof amount_out !== 'string' ||
    !INT.test(amount_out) ||
    typeof min_amount_out !== 'string' ||
    !INT.test(min_amount_out)
  ) {
    throw unavailable('Rhea’s quote is missing its amounts', JSON.stringify(data).slice(0, 500))
  }
  if (typeof msg !== 'string' || !msg || typeof signature !== 'string' || !/^[0-9a-f]{128}$/i.test(signature) || !strings(tokens)) {
    throw unavailable('Rhea’s quote is missing its signed route', JSON.stringify(data).slice(0, 500))
  }
  return { amountIn: BigInt(amount_in), amountOut: BigInt(amount_out), minAmountOut: BigInt(min_amount_out), dexs: strings(dexs) ? dexs : [], tokens, msg, signature }
}

/** base64 → every byte minus 7 (mod 256) → UTF-8 JSON. Verified on 9 fresh quotes and 355 on-chain routes. */
export function decodeSmartxMsg(msg: string): unknown {
  try {
    const bytes = Uint8Array.from(atob(msg), (c) => (c.charCodeAt(0) + 249) & 0xff)
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw rejected('its route could not be decoded')
  }
}

// ─── signature ──────────────────────────────────────────────────────────────

const hexBytes = (hex: string): Uint8Array<ArrayBuffer> => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16))

/**
 * ed25519 over the ASCII hex of SHA-256 of the route string, with the key the
 * aggregator contract checks. The contract verifies it again on chain; NearKit
 * checks first so a bad route never reaches the wallet.
 */
export async function verifySmartxSignature(msg: string, signatureHex: string, publicKey: string): Promise<boolean> {
  const raw = base58Decode(publicKey.replace(/^ed25519:/, ''))
  if (!raw || raw.length !== 32 || !/^[0-9a-f]{128}$/i.test(signatureHex)) return false
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg)))
  const payload = new TextEncoder().encode([...digest].map((b) => b.toString(16).padStart(2, '0')).join(''))
  let key: CryptoKey
  try {
    key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify'])
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotSupportedError') {
      throw new NearKitError('QUOTE_REJECTED', 'This browser can’t verify Rhea’s route signature (Ed25519). Update the browser to trade. Nothing was signed.')
    }
    return false
  }
  try {
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, hexBytes(signatureHex), payload)
  } catch {
    return false
  }
}

// ─── route checks ───────────────────────────────────────────────────────────

export interface RouteExpectation {
  user: string
  tokenIn: string
  tokenOut: string
  amountIn: bigint
  /** The user's slippage limit as a fraction; the signed minimum must honour it. */
  slippage: number
  skipUnwrapNear: boolean
  /** Expected `app_fee_rate` in parts per million (bps × 100), or null for no app fee. */
  appFeePpm: number | null
  appFeeRecipient: string | null
  dexReceivers: readonly string[]
  referrals: readonly string[]
}

export interface RouteStep {
  /** Token contract the aggregator calls `ft_transfer_call` on. */
  contract: string
  /** DEX that receives it. */
  receiver: string
  amount: bigint
  output: string
  /** Tokens this step touches, in order. */
  tokens: string[]
  /** Signed minimum of each route that ends in this step. */
  finalMins: bigint[]
}

export interface VerifiedRoute {
  steps: RouteStep[]
  /** Every token on the route in order, input first and output last. */
  routeTokens: string[]
  multiDex: boolean
  deadline: number
  appFeePpm: number | null
}

/** Signed routes must leave at least this long to sign and land. */
export const MIN_DEADLINE_MARGIN_MS = 60_000

// Every level of a signed route may hold only these fields; anything else (an output
// recipient, a client echo, a new referral) is refused rather than trusted.
const TOP_KEYS = new Set([
  'user',
  'receive_user',
  'gas',
  'contracts',
  'methods',
  'msgs',
  'gas_list',
  'near_amounts',
  'skip_unwrap_near',
  'collected_fee',
  'referral',
  'app_fee_rate',
  'app_fee_recipient',
  'uuid',
  'deadline',
])
const STEP_KEYS = new Set(['amount', 'msg', 'receiver_id'])
const CLASSIC_KEYS = new Set(['force', 'actions', 'skip_degen_price_sync', 'skip_unwrap_near', 'referral_id'])
const CLASSIC_ACTION_KEYS = new Set(['pool_id', 'token_in', 'token_out', 'amount_in', 'min_amount_out'])
const DCL_KEYS = new Set(['pool_ids', 'output_token', 'min_output_amount', 'skip_unwrap_near', 'input_token', 'input_amount'])
/** Tolerance for rounding across split routes when checking the minimum against slippage (0.1 point). */
const SLIPPAGE_TOLERANCE_PPM = 1_000n

function onlyKeys(o: Record<string, unknown>, allowed: ReadonlySet<string>, where: string): void {
  const extra = Object.keys(o).filter((k) => !allowed.has(k))
  if (extra.length) throw rejected(`${where} carries fields NearKit doesn't recognize (${extra.join(', ')})`)
}

function big(value: unknown, what: string): bigint {
  if (typeof value === 'string' && INT.test(value)) return BigInt(value)
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  throw rejected(`${what} is not a whole number`)
}

function parseJson(text: unknown, what: string): Record<string, unknown> {
  if (typeof text !== 'string') throw rejected(`${what} is missing`)
  try {
    const value: unknown = JSON.parse(text)
    if (obj(value)) return value
  } catch {
    // fall through
  }
  throw rejected(`${what} is not valid JSON`)
}

/** DCL `{"Swap":{pool_ids:["a|b|fee"], output_token, min_output_amount}}`. */
function dclStep(contract: string, swap: Record<string, unknown>): Pick<RouteStep, 'output' | 'tokens' | 'finalMins'> {
  onlyKeys(swap, DCL_KEYS, 'a DCL step')
  if (swap.skip_unwrap_near !== undefined && swap.skip_unwrap_near !== true) throw rejected('a DCL step would unwrap NEAR inside the exchange')
  if ((swap.input_token !== undefined && swap.input_token !== '') || (swap.input_amount !== undefined && swap.input_amount !== '0'))
    throw rejected('a DCL step names its own input')
  const pools = swap.pool_ids
  const output = swap.output_token
  if (!strings(pools) || pools.length === 0 || typeof output !== 'string') throw rejected('a DCL step is malformed')
  const tokens = [contract]
  let current = contract
  for (const pool of pools) {
    const [a, b] = pool.split('|')
    if (current === a && b) current = b
    else if (current === b && a) current = a
    else throw rejected('a DCL step does not connect its tokens')
    tokens.push(current)
  }
  if (current !== output) throw rejected('a DCL step ends in a different token than it claims')
  return { output, tokens, finalMins: [big(swap.min_output_amount, 'a DCL minimum')] }
}

/** Classic `{"actions":[{pool_id, token_in, token_out, amount_in?, min_amount_out}]}`; a new route starts at each `amount_in`. */
function classicStep(
  contract: string,
  amount: bigint,
  first: boolean,
  body: Record<string, unknown>,
  referrals: readonly string[],
): Pick<RouteStep, 'output' | 'tokens' | 'finalMins'> {
  onlyKeys(body, CLASSIC_KEYS, 'a classic step')
  if (body.force !== undefined && body.force !== 0) throw rejected('a classic step forces execution')
  if (body.skip_unwrap_near !== undefined && body.skip_unwrap_near !== true) throw rejected('a classic step would unwrap NEAR inside the exchange')
  if (body.skip_degen_price_sync !== undefined && typeof body.skip_degen_price_sync !== 'boolean') throw rejected('a classic step is malformed')
  if (body.referral_id !== undefined && !referrals.includes(String(body.referral_id))) throw rejected('a classic step names an unknown referral')
  const actions = body.actions
  if (!Array.isArray(actions) || actions.length === 0) throw rejected('a classic step has no actions')
  const routes: Record<string, unknown>[][] = []
  for (const [i, a] of actions.entries()) {
    if (!obj(a) || typeof a.token_in !== 'string' || typeof a.token_out !== 'string') throw rejected('a classic action is malformed')
    onlyKeys(a, CLASSIC_ACTION_KEYS, 'a classic action')
    if (typeof a.pool_id !== 'number' || !Number.isSafeInteger(a.pool_id) || a.pool_id < 0) throw rejected('a classic action names an invalid pool')
    if (i === 0 || a.amount_in !== undefined) routes.push([a])
    else routes.at(-1)?.push(a)
  }
  const tokens: string[] = [contract]
  const outputs = new Set<string>()
  const finalMins: bigint[] = []
  let covered = 0n
  for (const route of routes) {
    let current = contract
    for (const a of route) {
      if (a.token_in !== current) throw rejected('a classic route does not connect its tokens')
      current = String(a.token_out)
      if (!tokens.includes(current)) tokens.push(current)
    }
    outputs.add(current)
    const head = route[0]
    if (head?.amount_in !== undefined) covered += big(head.amount_in, 'a route amount')
    finalMins.push(big(route.at(-1)?.min_amount_out, 'a route minimum'))
  }
  if (outputs.size !== 1) throw rejected('parallel routes end in different tokens')
  if (first) {
    if (covered !== amount) throw rejected('the routes cover only part of the input amount')
  } else if (covered !== 0n) {
    throw rejected('a chained step carries its own amount')
  }
  return { output: [...outputs][0] ?? '', tokens, finalMins }
}

/**
 * Check a decoded route against what the user asked for. Throws QUOTE_REJECTED
 * (or QUOTE_EXPIRED) on any mismatch; the caller must not sign in that case.
 */
export function checkSmartxRoute(quote: SmartxQuote, decoded: unknown, exp: RouteExpectation, now: number): VerifiedRoute {
  if (!obj(decoded)) throw rejected('its route is not an object')
  const d = decoded
  onlyKeys(d, TOP_KEYS, 'it')
  if (d.collected_fee !== undefined && d.collected_fee !== false) throw rejected('it marks the fee as already collected')
  if (d.referral !== undefined && d.referral !== null && !exp.referrals.includes(String(d.referral))) throw rejected('it names an unknown referral')
  if (d.uuid !== undefined && typeof d.uuid !== 'string') throw rejected('its request id is malformed')

  if (d.user !== exp.user) throw rejected('it was signed for another account', `route user ${String(d.user)}, expected ${exp.user}`)
  if (d.receive_user !== null && d.receive_user !== undefined && d.receive_user !== exp.user)
    throw rejected('it sends the output to another account', `receive_user ${String(d.receive_user)}`)
  if (d.skip_unwrap_near !== exp.skipUnwrapNear) throw rejected(exp.skipUnwrapNear ? 'it would unwrap NEAR you asked to keep wrapped' : 'it would not deliver native NEAR')

  const fee = d.app_fee_rate === undefined || d.app_fee_rate === null || d.app_fee_rate === 0 ? null : d.app_fee_rate
  if (exp.appFeePpm === null) {
    if (fee !== null || (d.app_fee_recipient !== undefined && d.app_fee_recipient !== null)) throw rejected('it carries a fee NearKit did not request')
  } else {
    if (fee !== exp.appFeePpm) throw rejected('its fee rate differs from the NearKit fee', `app_fee_rate ${String(fee)}, expected ${exp.appFeePpm}`)
    if (d.app_fee_recipient !== exp.appFeeRecipient) throw rejected('its fee goes to another account', `app_fee_recipient ${String(d.app_fee_recipient)}`)
  }

  if (typeof d.deadline !== 'number') throw rejected('it has no deadline')
  if (d.deadline - now < MIN_DEADLINE_MARGIN_MS) throw new NearKitError('QUOTE_EXPIRED', 'Rhea’s route expires too soon to sign safely. Refresh the quote.')

  if (quote.amountIn !== exp.amountIn) throw rejected('it quotes a different input amount')
  const { contracts, methods, msgs } = d
  if (!strings(contracts) || !strings(methods) || !strings(msgs) || contracts.length === 0 || contracts.length !== msgs.length || methods.length !== msgs.length) {
    throw rejected('its steps are malformed')
  }
  if (methods.some((m) => m !== 'ft_transfer_call')) throw rejected('it calls an unexpected method')
  if (!strings(d.near_amounts) || d.near_amounts.length !== msgs.length || d.near_amounts.some((n) => n !== '1')) throw rejected('a step attaches a deposit other than 1 yoctoNEAR')
  if (
    d.gas_list !== undefined &&
    (!Array.isArray(d.gas_list) || d.gas_list.length !== msgs.length || d.gas_list.some((g) => typeof g !== 'number' || !Number.isSafeInteger(g) || g <= 0))
  ) {
    throw rejected('its gas list is malformed')
  }

  const steps: RouteStep[] = msgs.map((text, i) => {
    const outer = parseJson(text, `step ${i + 1}`)
    onlyKeys(outer, STEP_KEYS, `step ${i + 1}`)
    const contract = contracts[i] ?? ''
    const receiver = outer.receiver_id
    if (typeof receiver !== 'string' || !exp.dexReceivers.includes(receiver)) throw rejected(`step ${i + 1} sends tokens to an unknown contract`, String(receiver))
    const amount = big(outer.amount, `step ${i + 1} amount`)
    const inner = parseJson(outer.msg, `step ${i + 1} DEX message`)
    if (obj(inner.Swap)) onlyKeys(inner, new Set(['Swap']), `step ${i + 1}`)
    const body = obj(inner.Swap) ? dclStep(contract, inner.Swap) : 'actions' in inner ? classicStep(contract, amount, i === 0, inner, exp.referrals) : null
    if (!body) throw rejected(`step ${i + 1} is neither a DCL nor a classic swap`)
    return { contract, receiver, amount, ...body }
  })

  const [head] = steps
  if (!head || head.contract !== exp.tokenIn) throw rejected('it starts from a different token')
  if (head.amount !== exp.amountIn) throw rejected('it covers only part of the input amount', `first step ${head.amount}, requested ${exp.amountIn}`)
  for (const [i, step] of steps.entries()) {
    if (i === 0) continue
    if (step.amount !== 0n) throw rejected('a later step carries its own amount')
    if (step.contract !== steps[i - 1]?.output) throw rejected('its steps do not connect')
  }
  const last = steps.at(-1)
  if (!last || last.output !== exp.tokenOut) throw rejected('it ends in a different token')
  const minSum = last.finalMins.reduce((a, b) => a + b, 0n)
  if (minSum !== quote.minAmountOut) throw rejected('its signed minimums do not match the quoted minimum', `signed ${minSum}, quoted ${quote.minAmountOut}`)
  if (quote.amountOut < quote.minAmountOut) throw rejected('its expected output is below its own minimum')
  const slippagePpm = BigInt(Math.round(exp.slippage * 1_000_000))
  const floor = (quote.amountOut * (1_000_000n - slippagePpm - SLIPPAGE_TOLERANCE_PPM)) / 1_000_000n
  if (quote.minAmountOut < floor) {
    throw rejected(`its minimum is looser than your ${(exp.slippage * 100).toFixed(2)}% slippage limit`, `minimum ${quote.minAmountOut}, expected ${quote.amountOut}`)
  }

  const routeTokens: string[] = []
  for (const t of [exp.tokenIn, ...steps.flatMap((s) => s.tokens), exp.tokenOut]) if (!routeTokens.includes(t)) routeTokens.push(t)
  // The output token goes last even if a parallel route touched it earlier.
  routeTokens.splice(routeTokens.indexOf(exp.tokenOut), 1)
  routeTokens.push(exp.tokenOut)

  return { steps, routeTokens, multiDex: steps.length > 1, deadline: d.deadline, appFeePpm: fee as number | null }
}

// ─── client ─────────────────────────────────────────────────────────────────

export interface SmartxClientOptions {
  baseUrl: string
  fetch?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /**
   * Minimum gap between requests. Quotes fired in bursts (< ~1 s apart) came back
   * with stale no-fee amounts under a signed fee; ≥ 3 s apart they were always right.
   */
  spacingMs?: number
  timeoutMs?: number
}

export function createSmartxClient(options: SmartxClientOptions) {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const spacing = options.spacingMs ?? 3000
  const timeoutMs = options.timeoutMs ?? 10_000
  let tail: Promise<unknown> = Promise.resolve()
  let lastStart = Number.NEGATIVE_INFINITY

  async function request(params: SmartxParams): Promise<SmartxQuote> {
    const wait = lastStart + spacing - now()
    if (wait > 0) await sleep(wait)
    lastStart = now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res: Response
    try {
      res = await fetchImpl(smartxQuoteUrl(options.baseUrl, params), { signal: controller.signal, headers: { accept: 'application/json' } })
    } catch (e) {
      throw unavailable('Rhea’s quote service did not answer. Try again in a moment.', e instanceof Error ? e.message : String(e))
    } finally {
      clearTimeout(timer)
    }
    if (res.status === 429) throw unavailable('Rhea is rate-limiting quotes. Try again in a few seconds.')
    if (!res.ok) throw unavailable(`Rhea’s quote service answered HTTP ${res.status}. Try again in a moment.`)
    const text = await res.text()
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      throw unavailable('Rhea’s quote service returned a page instead of a quote. Try again in a moment.', text.slice(0, 200))
    }
    return parseSmartxResponse(json)
  }

  return {
    /** One request at a time, spaced apart. */
    quote(params: SmartxParams): Promise<SmartxQuote> {
      const run = tail.then(
        () => request(params),
        () => request(params),
      )
      tail = run.catch(() => undefined)
      return run
    },
  }
}

export type SmartxClient = ReturnType<typeof createSmartxClient>
