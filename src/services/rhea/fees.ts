/**
 * Fee arithmetic for swaps through Rhea's aggregator, from verified on-chain
 * behavior (PHASE2_IMPLEMENTATION.md §13):
 * - the app fee (NearKit's 0.10%) is `app_fee_rate` parts per million of the fee token;
 * - Rhea keeps 20% of it (`earn_app_protocol_fee`), the recipient gets 80% (`earn_app_fee`);
 * - Rhea also charges its own protocol fee on every swap (`query_protocol_fee_rate`, 1000 ppm);
 * - the fee comes out of the first whitelisted token the aggregator holds: the input,
 *   a token between DEX steps, or else the output.
 * All shares round down.
 */

const PPM = 1_000_000n

export type FeeStage = 'input' | 'intermediate' | 'output'

/**
 * @param routeTokens every token on the route, input first, output last
 * @param stepContracts the token each DEX step starts from (what the aggregator holds between steps)
 */
export function feeTokenFor(routeTokens: readonly string[], stepContracts: readonly string[], whitelist: ReadonlySet<string>): { token: string; stage: FeeStage } {
  const input = routeTokens[0] ?? ''
  if (whitelist.has(input)) return { token: input, stage: 'input' }
  const between = stepContracts.slice(1).find((t) => whitelist.has(t))
  if (between) return { token: between, stage: 'intermediate' }
  return { token: routeTokens.at(-1) ?? '', stage: 'output' }
}

export interface FeeSplit {
  /** What the user pays as the app fee. */
  app: bigint
  /** The recipient's share (NearKit). */
  nearkit: bigint
  /** Rhea's share of the app fee. */
  router: bigint
  /** Rhea's own protocol fee, charged on every swap. */
  protocol: bigint
}

export function aggregatorFee({ base, appFeePpm, protocolFeePpm, routerShareBps }: { base: bigint; appFeePpm: number; protocolFeePpm: number; routerShareBps: number }): FeeSplit {
  const app = (base * BigInt(appFeePpm)) / PPM
  const router = (app * BigInt(routerShareBps)) / 10_000n
  return { app, nearkit: app - router, router, protocol: (base * BigInt(protocolFeePpm)) / PPM }
}

/**
 * The lowest amount the user can actually receive. When the fees come off the
 * output, the DEX checks the signed minimum before they are deducted, so the
 * floor is lower by the app and protocol fees.
 */
export function trueMinimum(signedMin: bigint, stage: FeeStage, appFeePpm: number, protocolFeePpm: number): bigint {
  if (stage !== 'output') return signedMin
  return (signedMin * (PPM - BigInt(appFeePpm) - BigInt(protocolFeePpm))) / PPM
}

/** Gross output before fees, from a quoted net output (for estimating an output-side fee). */
export function grossOf(netOut: bigint, appFeePpm: number, protocolFeePpm: number): bigint {
  const keep = PPM - BigInt(appFeePpm) - BigInt(protocolFeePpm)
  return keep > 0n ? (netOut * PPM) / keep : netOut
}
