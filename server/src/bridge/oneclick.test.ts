import { describe, expect, it } from 'vitest'
import { classifyQuoteError, parseQuote, parseStatus, parseTokens, type OneClickQuoteRequest } from './oneclick'

/** NEAR Intents' 1Click answers, checked before NEARKITS uses any of them. */

const SENT: OneClickQuoteRequest = {
  dry: false,
  swapType: 'EXACT_INPUT',
  slippageTolerance: 100,
  originAsset: 'nep141:sol.omft.near',
  depositType: 'ORIGIN_CHAIN',
  destinationAsset: 'nep141:wrap.near',
  amount: '1000000000',
  refundTo: 'FDHEVP16btz5HCjFjMkQWzwGDqYpMpgDk6i7taVdK442',
  refundType: 'ORIGIN_CHAIN',
  recipient: 'alice.near',
  recipientType: 'DESTINATION_CHAIN',
  deadline: '2026-10-08T09:00:00.000Z',
  referral: 'nearkits',
  quoteWaitingTimeMs: 3000,
  appFees: [{ recipient: 'nearkitfee.near', fee: 50 }],
}

/** A real answer's shape (dry quote of 2026-10-08, made a real one). */
const answer = (quote: Record<string, unknown> = {}, echo: Record<string, unknown> = {}) => ({
  correlationId: 'f855feca',
  timestamp: '2026-10-08T08:25:06.107Z',
  signature: 'ed25519:sig',
  quoteRequest: {
    ...SENT,
    depositMode: 'SIMPLE',
    appFees: [
      { recipient: 'nearkitfee.near', fee: 25 },
      { recipient: '5880ad2b', fee: 25 },
    ],
    ...echo,
  },
  quote: {
    depositAddress: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
    amountIn: '1000000000',
    amountInFormatted: '1.0',
    amountInUsd: '114.98',
    minAmountIn: '1000000000',
    amountOut: '21320806377889227634464897',
    amountOutFormatted: '21.32',
    amountOutUsd: '114.70',
    minAmountOut: '21107598314110335358120248',
    deadline: '2026-10-08T08:45:06.000Z',
    timeWhenInactive: '2026-10-08T08:40:06.000Z',
    timeEstimate: 20,
    refundFee: '89920',
    ...quote,
  },
})

describe('a 1Click quote', () => {
  it('is read with its figures, deposit address, deadline and the fees as 1Click will charge them', () => {
    const q = parseQuote(answer(), SENT)
    expect(q).toMatchObject({
      amountIn: 1_000_000_000n,
      amountOut: 21320806377889227634464897n,
      minAmountOut: 21107598314110335358120248n,
      amountInUsd: 114.98,
      timeEstimateSec: 20,
      depositAddress: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
      deadline: Date.parse('2026-10-08T08:45:06.000Z'),
      refundFee: 89920n,
      signature: 'ed25519:sig',
    })
    expect(q.appFees).toEqual([
      { recipient: 'nearkitfee.near', fee: 25 },
      { recipient: '5880ad2b', fee: 25 },
    ])
  })

  it('is refused when it isn’t the swap that was asked: another asset, amount, recipient or refund address', () => {
    for (const echo of [{ destinationAsset: 'nep141:evil.near' }, { amount: '1' }, { recipient: 'mallory.near' }, { refundTo: 'other' }, { dry: true }])
      expect(() => parseQuote(answer({}, echo), SENT)).toThrow(/changed/)
    expect(() => parseQuote(answer({ amountIn: '999' }), SENT)).toThrow(/different input/)
  })

  it('is refused with figures out of order, without a deposit address or deadline, or needing a memo', () => {
    expect(() => parseQuote(answer({ minAmountOut: '99999999999999999999999999999' }), SENT)).toThrow(/minimum/)
    expect(() => parseQuote(answer({ minAmountOut: '0' }), SENT)).toThrow(/minimum/)
    expect(() => parseQuote(answer({ amountOut: 'NaN' }), SENT)).toThrow(/amounts/)
    expect(() => parseQuote(answer({ depositAddress: undefined }), SENT)).toThrow(/deposit address/)
    expect(() => parseQuote(answer({ deadline: 'soon' }), SENT)).toThrow(/deadline/)
    expect(() => parseQuote(answer({ depositMemo: '123' }), SENT)).toThrow(/memo/)
    expect(() => parseQuote({ message: 'hi' }, SENT)).toThrow(/no quote/)
  })

  it('a dry quote has no deposit address and needs none', () => {
    const dry = { ...SENT, dry: true }
    expect(parseQuote(answer({ depositAddress: undefined, deadline: undefined }, { dry: true }), dry).depositAddress).toBeNull()
  })
})

describe('1Click’s refusals, classified for the page', () => {
  it('a raw minimum, a USD minimum, no route, an address it rejects, and being down', () => {
    expect(classifyQuoteError(400, 'Amount is too low for bridge, try at least 981687')).toMatchObject({ kind: 'below-minimum', minimum: 981687n })
    expect(classifyQuoteError(400, 'Temporary swap limits: minimum swap amount is $1,000')).toMatchObject({ kind: 'below-minimum', minimumUsd: 1000 })
    expect(classifyQuoteError(400, 'tokenOut is not valid')).toMatchObject({ kind: 'no-route' })
    expect(classifyQuoteError(400, 'refundTo is not valid')).toMatchObject({ kind: 'invalid' })
    expect(classifyQuoteError(401, '')).toMatchObject({ kind: 'unavailable' })
    expect(classifyQuoteError(502, '')).toMatchObject({ kind: 'unavailable' })
  })
})

describe('1Click’s status and token list', () => {
  it('reads a status and what settled, and refuses an unknown status', () => {
    const s = parseStatus({
      status: 'SUCCESS',
      updatedAt: '2026-10-08T08:30:00.000Z',
      swapDetails: {
        amountOut: '21300000000000000000000000',
        destinationChainTxHashes: [{ hash: 'AbC', explorerUrl: 'https://nearblocks.io/txns/AbC' }, { hash: 7 }],
        originChainTxHashes: [{ hash: 'sig', explorerUrl: 'javascript:alert(1)' }],
        nearTxHashes: ['h1', 5],
      },
    })
    expect(s).toMatchObject({ status: 'SUCCESS', amountOut: 21300000000000000000000000n, nearTxHashes: ['h1'] })
    expect(s.destinationTxs).toEqual([{ hash: 'AbC', url: 'https://nearblocks.io/txns/AbC' }])
    // Only an https explorer link is kept.
    expect(s.originTxs).toEqual([{ hash: 'sig', url: '' }])
    expect(() => parseStatus({ status: 'DONE' })).toThrow()
  })

  it('keeps well-formed tokens only', () => {
    expect(
      parseTokens([
        { assetId: 'nep141:sol.omft.near', blockchain: 'sol', symbol: 'SOL', decimals: 9, price: 114.98 },
        { assetId: 1 },
        { assetId: 'x', blockchain: 'y', symbol: 'Z', decimals: -1 },
      ]),
    ).toEqual([{ assetId: 'nep141:sol.omft.near', blockchain: 'sol', symbol: 'SOL', decimals: 9, priceUsd: 114.98 }])
    expect(() => parseTokens({})).toThrow()
  })
})
