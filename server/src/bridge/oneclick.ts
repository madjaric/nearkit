import type { Logger } from '../log'

/**
 * NEAR Intents' 1Click API (https://1click.chaindefuser.com, OpenAPI v0 at /docs/v0/openapi.yaml):
 * the cross-chain infrastructure under Bridge & Buy. NEARKITS' server is its only caller: an API key,
 * when configured, never leaves the server, and every answer is checked here before anything uses it.
 *
 * - `GET /v0/tokens`: the assets 1Click supports (assetId, blockchain, decimals, price).
 * - `POST /v0/quote`: a quote; `dry: true` prices it without a deposit address, `dry: false` returns
 *   the deposit address the user's wallet sends to. The answer echoes the request as 1Click will
 *   execute it (`quoteRequest`, with the app fees as really charged) and carries 1Click's signature.
 * - `GET /v0/status?depositAddress=`: where the swap stands (PENDING_DEPOSIT, KNOWN_DEPOSIT_TX,
 *   PROCESSING, SUCCESS, INCOMPLETE_DEPOSIT, REFUNDED, FAILED) and what it settled.
 * - `POST /v0/deposit/submit`: the user's deposit transaction, optionally, to speed it up.
 */

export const ONECLICK_URL = 'https://1click.chaindefuser.com'

export type OneClickStatus = 'PENDING_DEPOSIT' | 'KNOWN_DEPOSIT_TX' | 'PROCESSING' | 'SUCCESS' | 'INCOMPLETE_DEPOSIT' | 'REFUNDED' | 'FAILED'
const STATUSES: readonly OneClickStatus[] = ['PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'PROCESSING', 'SUCCESS', 'INCOMPLETE_DEPOSIT', 'REFUNDED', 'FAILED']

export interface OneClickToken {
  assetId: string
  blockchain: string
  symbol: string
  decimals: number
  priceUsd: number | null
}

export interface OneClickQuoteRequest {
  dry: boolean
  swapType: 'EXACT_INPUT'
  slippageTolerance: number
  originAsset: string
  depositType: 'ORIGIN_CHAIN'
  destinationAsset: string
  amount: string
  refundTo: string
  refundType: 'ORIGIN_CHAIN'
  recipient: string
  recipientType: 'DESTINATION_CHAIN'
  deadline: string
  referral: string
  quoteWaitingTimeMs: number
  appFees: { recipient: string; fee: number }[]
}

/** A quote, checked against what was asked. */
export interface OneClickQuote {
  amountIn: bigint
  amountOut: bigint
  minAmountOut: bigint
  amountInUsd: number | null
  amountOutUsd: number | null
  timeEstimateSec: number
  /** Non-dry only. */
  depositAddress: string | null
  /** Deposits are taken until then (ms); non-dry only. */
  deadline: number | null
  refundFee: bigint | null
  /** The fees as 1Click will charge them (its echo of the request). */
  appFees: unknown
  signature: string
  timestamp: string
  correlationId: string
  /** 1Click's whole answer: kept with the order (its signature settles disputes). */
  raw: Record<string, unknown>
}

export interface OneClickSwapStatus {
  status: OneClickStatus
  updatedAt: number | null
  amountOut: bigint | null
  depositedAmount: bigint | null
  refundedAmount: bigint | null
  refundReason: string | null
  originTxs: { hash: string; url: string }[]
  destinationTxs: { hash: string; url: string }[]
  nearTxHashes: string[]
}

/** What went wrong, in a class the page can act on; `message` is plain words for the user. */
export class OneClickError extends Error {
  constructor(
    readonly kind: 'below-minimum' | 'no-route' | 'invalid' | 'unavailable' | 'not-found',
    message: string,
    /** The raw minimum 1Click named (base units of the input), when it named one. */
    readonly minimum: bigint | null = null,
    /** A USD minimum 1Click named, when it named one. */
    readonly minimumUsd: number | null = null,
  ) {
    super(message)
    this.name = 'OneClickError'
  }
}

const DIGITS = /^\d{1,60}$/
const big = (v: unknown): bigint | null => (typeof v === 'string' && DIGITS.test(v) ? BigInt(v) : null)
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
const obj = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const time = (v: unknown): number | null => {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

/** 1Click's refusal of a quote, classified. Its own words stay in the log; the user gets ours. */
export function classifyQuoteError(status: number, message: string): OneClickError {
  if (status === 401 || status === 403) return new OneClickError('unavailable', 'NEAR Intents refused NEARKITS’ request. Try again later.')
  if (status === 429 || status >= 500) return new OneClickError('unavailable', 'NEAR Intents isn’t answering right now. Try again in a moment.')
  const raw = /try at least (\d{1,60})/i.exec(message)
  if (raw) return new OneClickError('below-minimum', 'The amount is below the minimum for this route.', BigInt(raw[1] as string))
  const usd = /minimum swap amount is \$([\d,]+(?:\.\d+)?)/i.exec(message)
  if (usd) return new OneClickError('below-minimum', 'The amount is below the minimum for this route.', null, Number((usd[1] as string).replace(/,/g, '')))
  if (/too low|minimum|at least/i.test(message)) return new OneClickError('below-minimum', 'The amount is below the minimum for this route.')
  if (/token(in|out) is not valid|not supported|no quote|failed to get quote|no route|liquidity/i.test(message))
    return new OneClickError('no-route', 'No route is available for this amount right now.')
  if (/refundTo|recipient/i.test(message)) return new OneClickError('invalid', 'NEAR Intents didn’t accept that address.')
  return new OneClickError('no-route', 'Route temporarily unavailable. Try again in a moment.')
}

/**
 * 1Click's quote, checked: it echoes exactly the swap asked for (assets, amount, addresses, types),
 * its figures are whole numbers in order (0 < minimum ≤ expected), the input is the amount asked,
 * and a real quote has a deposit address and a deadline. Throws OneClickError('invalid') otherwise.
 */
export function parseQuote(json: unknown, sent: OneClickQuoteRequest): OneClickQuote {
  const bad = (why: string) => new OneClickError('invalid', `NEAR Intents returned a quote NEARKITS can’t use (${why}).`)
  const top = obj(json)
  const q = obj(top?.quote)
  const echo = obj(top?.quoteRequest)
  if (!top || !q || !echo) throw bad('no quote')
  const same = (k: keyof OneClickQuoteRequest, fold = false) => {
    const a = echo[k]
    const b = sent[k]
    return typeof a === 'string' && typeof b === 'string' ? (fold ? a.toLowerCase() === b.toLowerCase() : a === b) : a === b
  }
  for (const k of ['originAsset', 'destinationAsset', 'amount', 'recipient', 'swapType', 'depositType', 'recipientType', 'refundType', 'dry'] as const)
    if (!same(k)) throw bad(`it changed ${k}`)
  if (!same('refundTo', sent.refundTo.startsWith('0x'))) throw bad('it changed the refund address')
  const amountIn = big(q.amountIn)
  const amountOut = big(q.amountOut)
  const minAmountOut = big(q.minAmountOut)
  if (amountIn === null || amountOut === null || minAmountOut === null) throw bad('amounts')
  if (amountIn !== BigInt(sent.amount)) throw bad('a different input')
  if (minAmountOut <= 0n || minAmountOut > amountOut) throw bad('its minimum')
  const timeEstimateSec = num(q.timeEstimate)
  if (timeEstimateSec === null || timeEstimateSec < 0) throw bad('its time estimate')
  const signature = typeof top.signature === 'string' ? top.signature : ''
  const timestamp = typeof top.timestamp === 'string' ? top.timestamp : ''
  const correlationId = typeof top.correlationId === 'string' ? top.correlationId : ''
  let depositAddress: string | null = null
  let deadline: number | null = null
  if (!sent.dry) {
    depositAddress = typeof q.depositAddress === 'string' && q.depositAddress.length >= 20 && q.depositAddress.length <= 128 ? q.depositAddress : null
    deadline = time(q.deadline)
    if (!depositAddress) throw bad('no deposit address')
    // A deposit address that needs a memo can't be paid from an ordinary wallet transfer.
    if (typeof q.depositMemo === 'string' && q.depositMemo) throw bad('a deposit memo')
    if (deadline === null) throw bad('no deadline')
    if (!signature) throw bad('no signature')
  }
  return {
    amountIn,
    amountOut,
    minAmountOut,
    amountInUsd: num(q.amountInUsd),
    amountOutUsd: num(q.amountOutUsd),
    timeEstimateSec,
    depositAddress,
    deadline,
    refundFee: big(q.refundFee),
    appFees: echo.appFees,
    signature,
    timestamp,
    correlationId,
    raw: top,
  }
}

const txList = (v: unknown): { hash: string; url: string }[] =>
  Array.isArray(v)
    ? v.flatMap((t) => {
        const o = obj(t)
        const hash = typeof o?.hash === 'string' ? o.hash : null
        if (!hash || hash.length > 128) return []
        const url = typeof o?.explorerUrl === 'string' && /^https:\/\//.test(o.explorerUrl) ? o.explorerUrl : ''
        return [{ hash, url }]
      })
    : []

export function parseStatus(json: unknown): OneClickSwapStatus {
  const top = obj(json)
  const status = top?.status
  if (!top || typeof status !== 'string' || !STATUSES.includes(status as OneClickStatus)) throw new OneClickError('invalid', 'NEAR Intents returned a status NEARKITS can’t read.')
  const d = obj(top.swapDetails) ?? {}
  return {
    status: status as OneClickStatus,
    updatedAt: time(top.updatedAt),
    amountOut: big(d.amountOut),
    depositedAmount: big(d.depositedAmount),
    refundedAmount: big(d.refundedAmount),
    refundReason: typeof d.refundReason === 'string' ? d.refundReason.slice(0, 200) : null,
    originTxs: txList(d.originChainTxHashes),
    destinationTxs: txList(d.destinationChainTxHashes),
    nearTxHashes: Array.isArray(d.nearTxHashes) ? d.nearTxHashes.filter((h): h is string => typeof h === 'string' && h.length <= 64) : [],
  }
}

export function parseTokens(json: unknown): OneClickToken[] {
  if (!Array.isArray(json)) throw new OneClickError('invalid', 'NEAR Intents returned no token list.')
  return json.flatMap((t) => {
    const o = obj(t)
    if (!o || typeof o.assetId !== 'string' || typeof o.blockchain !== 'string' || typeof o.symbol !== 'string') return []
    const decimals = num(o.decimals)
    if (decimals === null || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return []
    return [{ assetId: o.assetId, blockchain: o.blockchain, symbol: o.symbol, decimals, priceUsd: num(o.price) }]
  })
}

export interface OneClickDeps {
  fetch: typeof fetch
  baseUrl?: string
  /** Partner JWT (ONECLICK_API_KEY): secret, sent only to 1Click, never logged. */
  apiKey?: string | null
  now?: () => number
  log: Logger
}

export interface OneClick {
  tokens(): Promise<OneClickToken[]>
  quote(req: OneClickQuoteRequest): Promise<OneClickQuote>
  status(depositAddress: string): Promise<OneClickSwapStatus>
  submitDeposit(depositAddress: string, txHash: string): Promise<void>
}

/** Token list kept this long: it changes rarely, and every quote checks its assets against it. */
const TOKENS_TTL_MS = 10 * 60_000

export function createOneClick(deps: OneClickDeps): OneClick {
  const base = (deps.baseUrl ?? ONECLICK_URL).replace(/\/+$/, '')
  const now = deps.now ?? Date.now
  const headers = (json: boolean): Record<string, string> => ({
    accept: 'application/json',
    ...(json ? { 'content-type': 'application/json' } : {}),
    ...(deps.apiKey ? { authorization: `Bearer ${deps.apiKey}` } : {}),
  })
  let tokens: { at: number; list: OneClickToken[] } | null = null
  let tokensFlight: Promise<OneClickToken[]> | null = null

  async function call(path: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; json: unknown }> {
    const started = now()
    let res: Response
    try {
      res = await deps.fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) {
      deps.log.warn('1Click unreachable', { path: path.split('?')[0], error: e, ms: now() - started })
      throw new OneClickError('unavailable', 'NEAR Intents isn’t answering right now. Try again in a moment.')
    }
    const json = await res.json().catch(() => null)
    deps.log.debug('1Click answered', { path: path.split('?')[0], status: res.status, ms: now() - started })
    return { status: res.status, json }
  }

  return {
    async tokens() {
      if (tokens && now() - tokens.at < TOKENS_TTL_MS) return tokens.list
      tokensFlight ??= (async () => {
        try {
          const r = await call('/v0/tokens', { method: 'GET', headers: headers(false) }, 15_000)
          if (r.status !== 200) throw new OneClickError('unavailable', 'NEAR Intents isn’t answering right now. Try again in a moment.')
          const list = parseTokens(r.json)
          tokens = { at: now(), list }
          return list
        } catch (e) {
          // The last list is still right for a while longer than its freshness: serve it rather than nothing.
          if (tokens && now() - tokens.at < 6 * TOKENS_TTL_MS) return tokens.list
          throw e
        } finally {
          tokensFlight = null
        }
      })()
      return tokensFlight
    },

    async quote(req) {
      const r = await call('/v0/quote', { method: 'POST', headers: headers(true), body: JSON.stringify(req) }, 20_000)
      if (r.status !== 200 && r.status !== 201) {
        const message = typeof obj(r.json)?.message === 'string' ? (obj(r.json)?.message as string) : ''
        // 1Click's own words go to the log (no secrets in them), classified for the user.
        deps.log.info('1Click refused a quote', { status: r.status, message: message.slice(0, 200), dry: req.dry, origin: req.originAsset })
        throw classifyQuoteError(r.status, message)
      }
      return parseQuote(r.json, req)
    },

    async status(depositAddress) {
      const r = await call(`/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`, { method: 'GET', headers: headers(false) }, 12_000)
      if (r.status === 404) throw new OneClickError('not-found', 'NEAR Intents doesn’t know this deposit address.')
      if (r.status !== 200) throw new OneClickError('unavailable', 'NEAR Intents isn’t answering right now.')
      return parseStatus(r.json)
    },

    async submitDeposit(depositAddress, txHash) {
      const r = await call('/v0/deposit/submit', { method: 'POST', headers: headers(true), body: JSON.stringify({ depositAddress, txHash }) }, 12_000)
      if (r.status !== 200 && r.status !== 201) throw new OneClickError('unavailable', 'NEAR Intents didn’t take the transaction hash.')
    },
  }
}
