import type { WrapDirection } from '@/services/near/wrap'

/** What wrapping does, in the same words wherever NEARKITS shows it (the Swap ticket, the reviews). */
export function wrapExplainer(direction: WrapDirection): string {
  return direction === 'unwrap'
    ? 'Unwrapping calls the wrap contract’s near_withdraw: your wNEAR becomes exactly the same amount of native NEAR. No exchange and no Rhea quote, so no price impact and nothing to slip.'
    : 'Wrapping calls the wrap contract’s near_deposit: your NEAR becomes exactly the same amount of wNEAR (the first time, the account registers with the wrap contract). No exchange and no Rhea quote, so no price impact and nothing to slip.'
}

/** The NEARKITS fee line for a wrap or unwrap. */
export const WRAP_FEE_TEXT = 'None: wrapping isn’t a trade'
