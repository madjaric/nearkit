import { describe, expect, it } from 'vitest'
import { KIT_LAUNCHPAD, KITS_CONTRACT } from '@/config/kit'
import { NETWORKS } from '@/config/networks'
import { createRpcClient } from '@/services/near/rpc'
import { createKitsRewardsTracker } from './rewards'

/**
 * Live, read-only: $KITS' holder rewards as mainnet has them now. The launchpad's accounting and the
 * payout transactions must agree once the scan reached the launch (it walks back a few pages a time,
 * so this steps it until it does, with NearBlocks' pace in mind).
 */
describe('$KITS holder rewards on NEAR mainnet (live)', () => {
  it('reads what the launchpad paid and allocated to holders, finds every payout back to the launch, and they reconcile', async () => {
    const rpc = createRpcClient({ urls: NETWORKS.mainnet.rpcUrls, fetch })
    const kept = new Map<string, string>()
    const tracker = createKitsRewardsTracker({
      rpc,
      fetch,
      network: NETWORKS.mainnet,
      kv: { get: async (k) => kept.get(k) ?? null, set: async (k, v) => void kept.set(k, v) },
      historyTtlMs: 0,
    })
    let v = await tracker.view()
    for (let i = 0; i < 150 && !v.historyComplete; i++) {
      await tracker.settle()
      await new Promise((r) => setTimeout(r, 4_000))
      v = await tracker.view()
    }
    await tracker.settle()
    v = await tracker.view()
    console.log(JSON.stringify({ ...v, payouts: v.payouts.map((p) => `${new Date(p.at).toISOString()} ${p.amount} ×${p.payments} ${p.tx}`) }, null, 1))
    expect(v).toMatchObject({ token: KITS_CONTRACT, launchpad: KIT_LAUNCHPAD, launchId: '2699', asset: 'near', decimals: 24 })
    expect(BigInt(v.allocated)).toBe(BigInt(v.paid) + BigInt(v.waiting))
    expect(v.historyComplete).toBe(true)
    expect(v.payouts.reduce((s, p) => s + BigInt(p.amount), 0n)).toBe(BigInt(v.paid))
    expect(v.payoutCount).toBeGreaterThanOrEqual(7)
  }, 900_000)
})
