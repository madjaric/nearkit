import { describe, expect, it } from 'vitest'
import { NETWORKS } from '@/config/networks'
import { NEARKIT_FEE_BPS } from '@/lib/fees'
import partial from './fixtures/smartx-blackdragon-partial.json'
import noRoute from './fixtures/smartx-near-to-singularty-noroute.json'
import nofee from './fixtures/smartx-near-to-usdt-nofee.json'
import withFee from './fixtures/smartx-usdt-to-near-fee200.json'
import nearkitFee from './fixtures/smartx-usdt-to-near-fee50.json'
import { checkSmartxRoute, createSmartxClient, decodeSmartxMsg, parseSmartxResponse, smartxQuoteUrl, verifySmartxSignature, type RouteExpectation } from './smartx'

// Real responses from smartx.rhea.finance, saved during research (2026-09-28).
const agg = NETWORKS.mainnet.rhea.aggregator!
const USDT = 'usdt.tether-token.near'
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'

const feeQuote = parseSmartxResponse(withFee)
const feeDecoded = decodeSmartxMsg(feeQuote.msg) as { deadline: number }

// The research route (two exchanges) was quoted at an app fee of 2.00%. The checks
// below test the route checker against that route's own terms. NearKit's own fee
// is covered in "NearKit’s fee on Rhea routes", which refuses this route.
const expectFee: RouteExpectation = {
  user: 'example.near',
  tokenIn: USDT,
  tokenOut: 'wrap.near',
  amountIn: 5000013n,
  slippage: 0.005,
  skipUnwrapNear: false,
  appFeePpm: 20000,
  appFeeRecipient: 'fees.example.near',
  dexReceivers: agg.dexReceivers,
  referrals: agg.referrals,
}

const before = (ms: number) => feeDecoded.deadline - ms

describe('smartx response and msg', () => {
  it('parses amounts as exact integers', () => {
    expect(feeQuote.amountIn).toBe(5000013n)
    expect(feeQuote.amountOut).toBe(955257561200075821649570n)
    expect(feeQuote.minAmountOut).toBe(950481273394075442541322n)
    expect(feeQuote.tokens).toEqual([USDT, USDC, 'wrap.near'])
  })

  it('rejects a response without a route', () => {
    expect(() => parseSmartxResponse({ result_code: 1, result_message: 'no path', result_data: null })).toThrow(expect.objectContaining({ code: 'QUOTE_UNAVAILABLE' }))
    expect(() => parseSmartxResponse({ result_code: 0, result_data: { amount_in: '1' } })).toThrow(expect.objectContaining({ code: 'QUOTE_UNAVAILABLE' }))
  })

  it('reports Rhea’s empty route (zero amounts, no steps) as no route', () => {
    // Real answer for wNEAR → singularty.nearlytrade.near (2026-09-29): code 0 and a signed route with no steps.
    expect(() => parseSmartxResponse(noRoute)).toThrow(expect.objectContaining({ code: 'QUOTE_UNAVAILABLE', message: 'Rhea found no route for this trade' }))
  })

  it('decodes the signed msg (base64, every byte minus 7)', () => {
    const d = decodeSmartxMsg(feeQuote.msg) as Record<string, unknown>
    expect(d.user).toBe('example.near')
    expect(d.app_fee_rate).toBe(20000)
    expect(d.app_fee_recipient).toBe('fees.example.near')
    expect(d.contracts).toEqual([USDT, USDC])
  })

  it('verifies Rhea’s ed25519 signature and rejects a tampered msg', async () => {
    expect(await verifySmartxSignature(feeQuote.msg, feeQuote.signature, agg.signerKey)).toBe(true)
    const tampered = feeQuote.msg.slice(0, 40) + (feeQuote.msg[40] === 'A' ? 'B' : 'A') + feeQuote.msg.slice(41)
    expect(await verifySmartxSignature(tampered, feeQuote.signature, agg.signerKey)).toBe(false)
    expect(await verifySmartxSignature(feeQuote.msg, feeQuote.signature, 'ed25519:11111111111111111111111111111111')).toBe(false)
  })
})

describe('checkSmartxRoute', () => {
  it('accepts a route that matches the request exactly', () => {
    const route = checkSmartxRoute(feeQuote, decodeSmartxMsg(feeQuote.msg), expectFee, before(120_000))
    expect(route.steps.map((s) => s.receiver)).toEqual(['v2.ref-finance.near', 'dclv2.ref-labs.near'])
    expect(route.routeTokens).toEqual([USDT, USDC, 'wrap.near'])
    expect(route.multiDex).toBe(true)
    expect(route.appFeePpm).toBe(20000)
  })

  it.each([
    ['another signer', { user: 'mallory.near' }],
    ['another fee account', { appFeeRecipient: 'someone-else.near' }],
    ['another fee rate', { appFeePpm: 25000 }],
    ['another output token', { tokenOut: USDC }],
    ['another input amount', { amountIn: 5000014n }],
    ['native NEAR out not requested', { skipUnwrapNear: true }],
  ])('refuses a route signed for %s', (_, patch) => {
    expect(() => checkSmartxRoute(feeQuote, decodeSmartxMsg(feeQuote.msg), { ...expectFee, ...patch }, before(120_000))).toThrow(
      expect.objectContaining({ code: 'QUOTE_REJECTED' }),
    )
  })

  it('refuses a route that expires within a minute', () => {
    expect(() => checkSmartxRoute(feeQuote, decodeSmartxMsg(feeQuote.msg), expectFee, before(30_000))).toThrow(expect.objectContaining({ code: 'QUOTE_EXPIRED' }))
  })

  it('refuses a route that hands tokens to an unknown contract', () => {
    const decoded = decodeSmartxMsg(feeQuote.msg) as { msgs: string[] }
    decoded.msgs = decoded.msgs.map((m) => m.replace('dclv2.ref-labs.near', 'drain.near'))
    expect(() => checkSmartxRoute(feeQuote, decoded, expectFee, before(120_000))).toThrow(expect.objectContaining({ code: 'QUOTE_REJECTED' }))
  })

  it('refuses when the signed minimums do not add up to the quoted minimum', () => {
    expect(() => checkSmartxRoute({ ...feeQuote, minAmountOut: feeQuote.minAmountOut - 1n }, decodeSmartxMsg(feeQuote.msg), expectFee, before(120_000))).toThrow(
      expect.objectContaining({ code: 'QUOTE_REJECTED' }),
    )
  })

  it('refuses a split route that covers only part of the input', () => {
    const q = parseSmartxResponse(partial)
    const d = decodeSmartxMsg(q.msg) as { deadline: number }
    const expectation: RouteExpectation = { ...expectFee, tokenIn: 'blackdragon.tkn.near', amountIn: q.amountIn }
    expect(() => checkSmartxRoute(q, d, expectation, d.deadline - 120_000)).toThrow(/part of/)
  })

  it('accepts a single-DEX split that covers the input and whose route minimums sum to the quote', () => {
    const inner = JSON.stringify({
      force: 0,
      actions: [
        { pool_id: 1, token_in: 'bd.near', token_out: 'wrap.near', amount_in: '60', min_amount_out: '5' },
        { pool_id: 2, token_in: 'bd.near', token_out: 'x.near', amount_in: '40', min_amount_out: '0' },
        { pool_id: 3, token_in: 'x.near', token_out: 'wrap.near', min_amount_out: '3' },
      ],
    })
    const decoded = {
      user: 'example.near',
      receive_user: null,
      contracts: ['bd.near'],
      methods: ['ft_transfer_call'],
      msgs: [JSON.stringify({ amount: '100', msg: inner, receiver_id: 'v2.ref-finance.near' })],
      gas_list: [85000000000000],
      near_amounts: ['1'],
      skip_unwrap_near: false,
      app_fee_rate: 20000,
      app_fee_recipient: 'fees.example.near',
      deadline: 1_000_000,
    }
    const quote = { ...feeQuote, amountIn: 100n, minAmountOut: 8n }
    const route = checkSmartxRoute({ ...quote, amountOut: 8n }, decoded, { ...expectFee, tokenIn: 'bd.near', amountIn: 100n }, 1_000_000 - 120_000)
    expect(route.multiDex).toBe(false)
    expect(route.routeTokens).toEqual(['bd.near', 'x.near', 'wrap.near'])
    expect(() => checkSmartxRoute({ ...quote, amountOut: 8n, minAmountOut: 5n }, decoded, { ...expectFee, tokenIn: 'bd.near', amountIn: 100n }, 1_000_000 - 120_000)).toThrow(
      /minimums/,
    )
  })

  // What a compromised signer could add: every level must hold only known fields with expected values.
  const mutate = (fn: (d: Record<string, unknown>) => void) => {
    const d = decodeSmartxMsg(feeQuote.msg) as Record<string, unknown>
    fn(d)
    return d
  }
  const innerMsg = (d: Record<string, unknown>, i: number, fn: (inner: Record<string, unknown>) => void) => {
    const msgs = d.msgs as string[]
    const outer = JSON.parse(msgs[i] ?? '{}') as { msg: string }
    const inner = JSON.parse(outer.msg) as Record<string, unknown>
    fn(inner)
    msgs[i] = JSON.stringify({ ...outer, msg: JSON.stringify(inner) })
  }

  it.each([
    ['an unknown top-level field', (d: Record<string, unknown>) => (d.extra_receiver = 'mallory.near')],
    ['a referral NearKit does not know', (d: Record<string, unknown>) => (d.referral = 'mallory.near')],
    ['a fee marked as already collected', (d: Record<string, unknown>) => (d.collected_fee = true)],
    ['a deposit other than 1 yocto on a step', (d: Record<string, unknown>) => (d.near_amounts = ['1', '1000000000000000000000000'])],
    ['an output recipient inside a classic step', (d: Record<string, unknown>) => innerMsg(d, 0, (m) => (m.swap_out_recipient = 'mallory.near'))],
    ['a client echo inside a DCL step', (d: Record<string, unknown>) => innerMsg(d, 1, (m) => ((m.Swap as Record<string, unknown>).client_echo = 'x'))],
    ['a step that unwraps NEAR inside the exchange', (d: Record<string, unknown>) => innerMsg(d, 0, (m) => (m.skip_unwrap_near = false))],
    ['an unknown key on a classic action', (d: Record<string, unknown>) => innerMsg(d, 0, (m) => ((m.actions as Record<string, unknown>[])[0]!.recipient = 'mallory.near'))],
  ])('refuses a route with %s', (_, fn) => {
    expect(() => checkSmartxRoute(feeQuote, mutate(fn), expectFee, before(120_000))).toThrow(expect.objectContaining({ code: 'QUOTE_REJECTED' }))
  })

  it('refuses a minimum below the slippage limit the user chose', () => {
    expect(() => checkSmartxRoute(feeQuote, decodeSmartxMsg(feeQuote.msg), { ...expectFee, slippage: 0.001 }, before(120_000))).toThrow(/slippage/)
  })

  it('refuses a quote whose expected output is below its own minimum', () => {
    expect(() => checkSmartxRoute({ ...feeQuote, amountOut: feeQuote.minAmountOut - 1n }, decodeSmartxMsg(feeQuote.msg), expectFee, before(120_000))).toThrow(/expected output/)
  })

  it('accepts a no-fee route only when no fee was requested', () => {
    const q = parseSmartxResponse(nofee)
    const d = decodeSmartxMsg(q.msg) as { deadline: number }
    const noFee: RouteExpectation = {
      user: 'example.near',
      tokenIn: 'wrap.near',
      tokenOut: USDT,
      amountIn: q.amountIn,
      slippage: 0.005,
      skipUnwrapNear: true,
      appFeePpm: null,
      appFeeRecipient: null,
      dexReceivers: agg.dexReceivers,
      referrals: agg.referrals,
    }
    expect(checkSmartxRoute(q, d, noFee, d.deadline - 120_000).appFeePpm).toBeNull()
    expect(() => checkSmartxRoute(q, d, { ...noFee, appFeePpm: NEARKIT_FEE_BPS * 100, appFeeRecipient: 'fees.example.near' }, d.deadline - 120_000)).toThrow(
      expect.objectContaining({ code: 'QUOTE_REJECTED' }),
    )
  })
})

describe('NearKit’s fee on Rhea routes', () => {
  // A real route Rhea signed for the same request at appFeeRate=50 (2026-09-29, read-only).
  const ours = parseSmartxResponse(nearkitFee)
  const oursDecoded = decodeSmartxMsg(ours.msg) as { deadline: number; app_fee_rate: number }
  const ourTerms: RouteExpectation = { ...expectFee, appFeePpm: NEARKIT_FEE_BPS * 100 }

  it('passes a route Rhea signed at NearKit’s rate: app_fee_rate 5000 ppm', async () => {
    expect(await verifySmartxSignature(ours.msg, ours.signature, agg.signerKey)).toBe(true)
    expect(oursDecoded.app_fee_rate).toBe(5000)
    const route = checkSmartxRoute(ours, decodeSmartxMsg(ours.msg), ourTerms, oursDecoded.deadline - 120_000)
    expect(route.appFeePpm).toBe(5000)
    expect(route.routeTokens).toEqual([USDT, 'wrap.near'])
  })

  it('refuses a route that still carries the old 2.00% app fee', () => {
    expect(() => checkSmartxRoute(feeQuote, decodeSmartxMsg(feeQuote.msg), ourTerms, before(120_000))).toThrow(/fee rate differs from the NearKit fee/)
  })
})

describe('smartx client', () => {
  const params = {
    tokenIn: 'wrap.near',
    tokenOut: USDT,
    amountIn: 10n ** 24n,
    slippage: 0.005,
    user: 'alice.near',
    skipUnwrapNativeToken: true,
    appFeeRate: NEARKIT_FEE_BPS,
    appFeeRecipient: 'fees.nearkit.near',
  }

  it('asks for the NearKit app fee explicitly: appFeeRate=50 and the configured recipient', () => {
    const url = new URL(smartxQuoteUrl(agg.quoteUrl, params))
    expect(url.searchParams.get('appFeeRate')).toBe('50')
    expect(url.searchParams.get('appFeeRecipient')).toBe('fees.nearkit.near')
    expect(url.searchParams.get('user')).toBe('alice.near')
    expect(url.searchParams.get('amountIn')).toBe('1000000000000000000000000')
    expect(url.searchParams.get('skipUnwrapNativeToken')).toBe('true')
    expect(url.searchParams.get('pathDeep')).toBe('3')
  })

  it('never sends a fee rate without a recipient', () => {
    const url = new URL(smartxQuoteUrl(agg.quoteUrl, { ...params, appFeeRate: null, appFeeRecipient: null }))
    expect(url.searchParams.has('appFeeRate')).toBe(false)
    expect(url.searchParams.has('appFeeRecipient')).toBe(false)
  })

  it('serializes requests and spaces them apart, because burst quotes come back stale', async () => {
    let clock = 0
    const starts: number[] = []
    const client = createSmartxClient({
      baseUrl: agg.quoteUrl,
      spacingMs: 3000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
      fetch: async () => {
        starts.push(clock)
        return new Response(JSON.stringify(withFee), { status: 200 })
      },
    })
    await Promise.all([client.quote(params), client.quote(params), client.quote(params)])
    expect(starts).toEqual([0, 3000, 6000])
  })

  it('treats a rate-limit page as “quote unavailable”, not as a route', async () => {
    const client = createSmartxClient({ baseUrl: agg.quoteUrl, spacingMs: 0, fetch: async () => new Response('<html>429 Too Many Requests</html>', { status: 429 }) })
    await expect(client.quote(params)).rejects.toMatchObject({ code: 'QUOTE_UNAVAILABLE' })
  })
})
