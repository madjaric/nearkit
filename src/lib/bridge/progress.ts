import { bridgeChain } from '@/config/bridge'
import type { BridgeOrderStatus, BridgeOrderView } from './types'

/**
 * Bridge & Buy's progress, as the page lists it: the source transfer, NEAR Intents' cross-chain
 * leg, NEAR arriving, the $KITS purchase, done. A step is done only on what was seen: a transfer
 * NEAR Intents reported, NEAR checked on chain in the wallet, $KITS from the purchase's own record.
 */

export type StepState = 'done' | 'active' | 'todo' | 'error'

export interface BridgeStep {
  key: 'source' | 'bridge' | 'near' | 'kits' | 'complete'
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

/** One line for the order's state, in the page's words. */
export function bridgeHeadline(order: Pick<BridgeOrderView, 'status' | 'destination'>): string {
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
  }
}

/** Tone for the status tag. */
export function bridgeTone(status: BridgeOrderStatus): 'accent' | 'warn' | 'danger' | 'neutral' {
  if (status === 'complete') return 'accent'
  if (status === 'buy-needed' || status === 'incomplete-deposit' || status === 'refunded') return 'warn'
  if (status === 'failed') return 'danger'
  return 'neutral'
}
