import { bridgeChain } from '@/config/bridge'
import type { BridgeOrderStatus, BridgeOrderView } from './types'

/**
 * A bridge order's progress, as the page lists it. Bridge & Buy: the source transfer, NEAR Intents'
 * cross-chain leg, NEAR arriving, the $KITS purchase, done. Bridge: the source transfer, NEAR
 * Intents' leg, the NEAR arriving (as wNEAR), the unwrap to native NEAR where one applies, done. A
 * step is done only on what was seen: a transfer NEAR Intents reported, NEAR checked on chain in the
 * wallet, $KITS or the unwrap from its own record.
 */

export type StepState = 'done' | 'active' | 'todo' | 'error'

export interface BridgeStep {
  key: 'source' | 'bridge' | 'near' | 'kits' | 'unwrap' | 'complete'
  label: string
  state: StepState
}

const RANK: Record<BridgeOrderStatus, number> = {
  'awaiting-deposit': 0,
  'deposit-seen': 1,
  bridging: 1,
  'incomplete-deposit': 1,
  delivered: 2,
  buying: 3,
  'buy-needed': 3,
  unwrapping: 3,
  'unwrap-needed': 3,
  complete: 4,
  refunded: 1,
  failed: 1,
  expired: 0,
}

export function bridgeSteps(order: Pick<BridgeOrderView, 'status' | 'chain' | 'depositTx' | 'destination'>, signing = false): BridgeStep[] {
  const chain = bridgeChain(order.chain)
  const symbol = chain?.symbol ?? 'Source'
  const s = order.status
  const rank = RANK[s]
  const state = (i: number): StepState => (i < rank ? 'done' : i === rank ? 'active' : 'todo')
  const steps: BridgeStep[] = [
    { key: 'source', label: `${symbol} transfer`, state: s === 'awaiting-deposit' ? (order.depositTx || signing ? 'active' : 'todo') : 'done' },
    { key: 'bridge', label: `${symbol} → NEAR via NEAR Intents`, state: state(1) },
    { key: 'near', label: 'NEAR received', state: state(2) },
    { key: 'kits', label: order.destination.kind === 'connected' ? 'Buy $KITS (your wallet signs)' : 'Buy $KITS', state: state(3) },
    { key: 'complete', label: 'Complete', state: s === 'complete' ? 'done' : 'todo' },
  ]
  // What stopped it: the step it stopped at turns red, nothing after it runs.
  if (s === 'refunded' || s === 'failed' || s === 'incomplete-deposit') (steps[1] as BridgeStep).state = 'error'
  if (s === 'expired') (steps[0] as BridgeStep).state = 'error'
  if (s === 'buy-needed') (steps[3] as BridgeStep).state = 'error'
  // The transfer was seen, so the source step is done even while NEAR Intents waits for the rest.
  if (s === 'incomplete-deposit') (steps[0] as BridgeStep).state = 'done'
  return steps
}

/**
 * The plain Bridge's steps: Awaiting the transfer, NEAR Intents bridging, the assets received on NEAR
 * (wNEAR, as NEAR Intents delivers NEAR), the unwrap to native NEAR (NEARKITS' for a NEARKITS
 * wallet, the owner's signature for a connected one; none for an external address, or when native
 * NEAR arrived), complete.
 */
export function nearBridgeSteps(order: Pick<BridgeOrderView, 'status' | 'chain' | 'depositTx' | 'destination' | 'delivered'>, signing = false): BridgeStep[] {
  const chain = bridgeChain(order.chain)
  const symbol = chain?.symbol ?? 'Source'
  const s = order.status
  const rank = RANK[s]
  const state = (i: number): StepState => (i < rank ? 'done' : i === rank ? 'active' : 'todo')
  const native = order.delivered?.asset === 'near'
  const kind = order.destination.kind
  const received = order.delivered ? `${order.delivered.asset === 'wnear' ? 'wNEAR' : 'NEAR'} received on NEAR` : 'Assets received on NEAR'
  const unwrapLabel = native
    ? 'Unwrap: not needed, native NEAR arrived'
    : kind === 'nearkits'
      ? 'Unwrapping to NEAR (NEARKITS)'
      : kind === 'connected'
        ? 'Unwrap to NEAR (your wallet signs)'
        : 'No unwrap here: it arrives as wNEAR'
  const steps: BridgeStep[] = [
    { key: 'source', label: `Awaiting ${symbol} transfer`, state: s === 'awaiting-deposit' ? (order.depositTx || signing ? 'active' : 'todo') : 'done' },
    { key: 'bridge', label: 'Bridge processing (NEAR Intents)', state: state(1) },
    { key: 'near', label: received, state: s === 'complete' || s === 'unwrapping' || s === 'unwrap-needed' ? 'done' : state(2) },
    { key: 'unwrap', label: unwrapLabel, state: s === 'complete' ? 'done' : s === 'unwrapping' || (s === 'delivered' && kind === 'connected') ? 'active' : 'todo' },
    { key: 'complete', label: 'Complete', state: s === 'complete' ? 'done' : 'todo' },
  ]
  if (s === 'refunded' || s === 'failed' || s === 'incomplete-deposit') (steps[1] as BridgeStep).state = 'error'
  if (s === 'expired') (steps[0] as BridgeStep).state = 'error'
  if (s === 'unwrap-needed') (steps[3] as BridgeStep).state = 'error'
  if (s === 'incomplete-deposit') (steps[0] as BridgeStep).state = 'done'
  return steps
}

/** One line for the order's state, in the page's words. */
export function bridgeHeadline(order: Pick<BridgeOrderView, 'status' | 'destination'> & Partial<Pick<BridgeOrderView, 'product' | 'delivered'>>): string {
  if (order.product === 'bridge') return nearBridgeHeadline(order)
  switch (order.status) {
    case 'awaiting-deposit':
      return 'Waiting for your transfer'
    case 'deposit-seen':
      return 'Transfer detected'
    case 'bridging':
      return 'Bringing it to NEAR'
    case 'incomplete-deposit':
      return 'Less arrived than the quote needs'
    case 'delivered':
      return order.destination.kind === 'connected' ? 'NEAR arrived: buy $KITS' : 'NEAR arrived: buying $KITS'
    case 'buying':
      return 'Buying $KITS'
    case 'complete':
      return '$KITS purchase complete'
    case 'buy-needed':
      return 'Bridge completed, $KITS not bought'
    case 'refunded':
      return 'Refunded'
    case 'failed':
      return 'The bridge failed'
    case 'expired':
      return 'Expired: nothing was sent'
    // A Bridge's own statuses (never a Bridge & Buy's).
    case 'unwrapping':
      return 'Unwrapping to NEAR'
    case 'unwrap-needed':
      return 'Bridged, not unwrapped'
  }
}

function nearBridgeHeadline(order: Pick<BridgeOrderView, 'status' | 'destination'> & Partial<Pick<BridgeOrderView, 'delivered'>>): string {
  switch (order.status) {
    case 'delivered':
      return 'wNEAR arrived: unwrap to NEAR'
    case 'unwrapping':
      return 'Unwrapping to NEAR'
    case 'unwrap-needed':
      return 'Bridged, not unwrapped'
    case 'complete':
      return order.delivered?.asset === 'wnear' && order.destination.kind === 'external' ? 'Delivered as wNEAR' : 'Completed'
    case 'buying':
    case 'buy-needed':
      return 'Bridged'
    default:
      return bridgeHeadline({ status: order.status, destination: order.destination })
  }
}

/** Tone for the status tag. */
export function bridgeTone(status: BridgeOrderStatus): 'accent' | 'warn' | 'danger' | 'neutral' {
  if (status === 'complete') return 'accent'
  if (status === 'buy-needed' || status === 'unwrap-needed' || status === 'incomplete-deposit' || status === 'refunded') return 'warn'
  if (status === 'failed') return 'danger'
  return 'neutral'
}
