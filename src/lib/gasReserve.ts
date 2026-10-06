/**
 * The gas reserve: the NEAR the protocol holds for a transaction's attached gas while it runs
 * (NEP-642: 0.001 NEAR per TGas), refunded automatically as its receipts settle, all but the gas
 * actually burnt. It is not a fee: the actual network fee is a small part of it, and NearKit's fee
 * is separate. The web and Telegram name and explain it with these words only.
 */

export const GAS_RESERVE_LABEL = 'Gas reserve (refunded)'

/** Shown right under the reserve. */
export const GAS_RESERVE_NOTE = 'Temporarily held while the transaction runs. Unused gas is refunded automatically.'

export const GAS_RESERVE_NOT_FEE = 'This is not an additional NEARKITS fee.'

export const GAS_RESERVE_TOOLTIP = `NEAR temporarily holds the attached gas amount while the transaction runs. Unused gas is automatically refunded to your wallet. ${GAS_RESERVE_NOT_FEE}`

/** The gas NEAR actually burns, estimated: the line next to the reserve. */
export const ACTUAL_NETWORK_FEE_LABEL = 'Actual network fee (est.)'

/**
 * The gas reserve within a plan's need: what it requires available beyond the NEAR it moves and its
 * registrations. Arithmetic on the planner's own figures (peakNeedYocto); it computes nothing new.
 */
export function gasReserveYocto(need: bigint, nearIn: bigint, registration: bigint): bigint {
  const reserve = need - nearIn - registration
  return reserve > 0n ? reserve : 0n
}
