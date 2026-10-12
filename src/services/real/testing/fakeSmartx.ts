import { dclPoolId } from '@/services/dcl/pools'

/**
 * A quote from Rhea's aggregator (`swapMultiDexPath`), built for tests: one exchange call, signed
 * with a placeholder (indicative quotes skip the signature; smartx.test.ts covers real signed
 * routes). The route is encoded the way Rhea's is (smartx.ts `decodeSmartxMsg`), so NEARKITS'
 * checks of every field run on it. Only tests import it.
 */

export interface FakeSmartxRoute {
  user: string
  tokenIn: string
  tokenOut: string
  amountIn: bigint
  amountOut: bigint
  minOut: bigint
  /** The exchange the step goes to: the DCL contract (through the pair's pool at `fee`) or Rhea's classic exchange. */
  dex: string
  appFeePpm: number
  feeRecipient: string
  /** True unless the output is native NEAR. */
  skipUnwrapNear: boolean
  deadline: number
  /** DCL pool fee tier for a DCL step (default 1%). */
  fee?: number
}

/** The aggregator's encoding: UTF-8 JSON, every byte plus 7, base64. */
export function encodeSmartxMsg(route: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(route))
  return btoa(String.fromCharCode(...bytes.map((b) => (b + 7) & 0xff)))
}

export function fakeSmartxQuote(r: FakeSmartxRoute): unknown {
  const inner = r.dex.startsWith('dclv2')
    ? { Swap: { pool_ids: [dclPoolId(r.tokenIn, r.tokenOut, r.fee ?? 10000)], output_token: r.tokenOut, min_output_amount: r.minOut.toString() } }
    : { actions: [{ pool_id: 7, token_in: r.tokenIn, token_out: r.tokenOut, amount_in: r.amountIn.toString(), min_amount_out: r.minOut.toString() }] }
  const route = {
    user: r.user,
    receive_user: r.user,
    contracts: [r.tokenIn],
    methods: ['ft_transfer_call'],
    msgs: [JSON.stringify({ receiver_id: r.dex, amount: r.amountIn.toString(), msg: JSON.stringify(inner) })],
    near_amounts: ['1'],
    skip_unwrap_near: r.skipUnwrapNear,
    app_fee_rate: r.appFeePpm,
    app_fee_recipient: r.feeRecipient,
    deadline: r.deadline,
  }
  return {
    result_code: 0,
    result_message: '',
    result_data: {
      amount_in: r.amountIn.toString(),
      amount_out: r.amountOut.toString(),
      min_amount_out: r.minOut.toString(),
      dexs: [r.dex.startsWith('dclv2') ? 'RheaDCL' : 'RheaAMM'],
      msg: encodeSmartxMsg(route),
      signature: '0'.repeat(128),
      tokens: [r.tokenIn, r.tokenOut],
    },
  }
}
