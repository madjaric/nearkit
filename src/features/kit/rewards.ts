import { useQuery } from '@tanstack/react-query'
import { ENV } from '@/config/env'
import { KIT } from '@/config/kit'
import { formatUnits } from '@/lib/amounts'
import { fetchKitsRewards, type KitsRewardsView } from '@/services/kitsRewards'
import { useCapabilities } from '@/services/queries'
import { burnTrackerState, type BurnTrackerState } from './buyback'

/**
 * $KITS' holder rewards on its page, from NEARKITS' server's reading of NEAR mainnet
 * (services/kitsRewards.ts, server/src/kits/rewards.ts): which state the section is in, and the
 * figures it prints. Holders are paid in NEAR. "Paid" is only what the launchpad paid out; what it
 * holds for holders and hasn't paid is "allocated", never "paid". A figure nobody read is "—".
 */

/** The section's state: the burn tracker's states, the reading a rewards one. */
export type RewardsState = Exclude<BurnTrackerState, { state: 'live' }> | { state: 'live'; view: KitsRewardsView; refreshFailed: boolean }

export function rewardsState(
  input: Omit<Parameters<typeof burnTrackerState>[0], 'query'> & { query: { data: KitsRewardsView | undefined; isPending: boolean; isError: boolean } },
): RewardsState {
  // The same rules as the burns: mainnet only, nothing read in the demo or without the server.
  const s = burnTrackerState({ ...input, query: { data: undefined, isPending: input.query.isPending, isError: input.query.isError } })
  if (s.state === 'not-on-network' || s.state === 'no-source') return s
  const { data, isError } = input.query
  if (data) return { state: 'live', view: data, refreshFailed: isError }
  return s.state === 'loading' ? s : { state: 'unavailable' }
}

const near = (yocto: string | bigint) => formatUnits(typeof yocto === 'bigint' ? yocto : BigInt(yocto), 24, { maxFraction: 4, group: true })

export interface RewardFigures {
  /** NEAR, four decimals. */
  paid: string
  waiting: string
  allocated: string
  /** The holders' share of the tax, as the launchpad configures it. */
  sharePct: string
  payoutCount: number
  paymentCount: number
  latest: { at: number; amount: string; payments: number; tx: string } | null
  /** Paid, at today's NEAR price, when one is known. */
  paidUsd: number | null
}

export function rewardFigures(view: KitsRewardsView, nearUsd: number | null): RewardFigures {
  const latest = view.payouts[0]
  const paidNear = Number(formatUnits(BigInt(view.paid), 24))
  return {
    paid: near(view.paid),
    waiting: near(view.waiting),
    allocated: near(view.allocated),
    sharePct: `${view.holdersBps / 100}%`,
    payoutCount: view.payoutCount,
    paymentCount: view.paymentCount,
    latest: latest ? { at: latest.at, amount: near(latest.amount), payments: latest.payments, tx: latest.tx } : null,
    paidUsd: nearUsd !== null && Number.isFinite(nearUsd) && nearUsd > 0 ? paidNear * nearUsd : null,
  }
}

export const nearOf = near

/** How often an open $KITS page asks again; NEARKITS' server reads the chain at most once a minute for everyone. */
export const REWARDS_REFRESH_MS = 60_000

/** $KITS' holder rewards from NEARKITS' server: read when the page opens, then every minute while it stays open. */
export function useHolderRewards(): RewardsState {
  const caps = useCapabilities()
  const enabled = KIT.contract !== null && caps.mode === 'near' && caps.network === 'mainnet' && ENV.apiUrl !== null
  const query = useQuery({
    queryKey: ['kits', 'rewards'],
    queryFn: () => fetchKitsRewards(ENV.apiUrl as string),
    enabled,
    refetchInterval: REWARDS_REFRESH_MS,
    staleTime: REWARDS_REFRESH_MS / 2,
    retry: 1,
  })
  return rewardsState({
    contract: KIT.contract,
    mode: caps.mode,
    network: caps.network,
    apiUrl: ENV.apiUrl,
    query: { data: query.data, isPending: query.isPending, isError: query.isError },
  })
}
