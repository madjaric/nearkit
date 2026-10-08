import { describe, expect, it } from 'vitest'
import { KIT_LAUNCHPAD, KITS_CONTRACT } from '@/config/kit'
import { NETWORKS } from '@/config/networks'
import { createRpcClient } from '@/services/near/rpc'
import { createKitsBurnTracker } from './burns'

/** Live, read-only: $KITS' burns as mainnet has them now. The three sources must agree. */
describe('$KITS Buyback & Burn on NEAR mainnet (live)', () => {
  it('reads the launchpad’s tax burns, the token’s supply and every burn transaction, and they reconcile', async () => {
    const rpc = createRpcClient({ urls: NETWORKS.mainnet.rpcUrls, fetch })
    const v = await createKitsBurnTracker({ rpc, fetch, network: NETWORKS.mainnet }).view()
    console.log(JSON.stringify({ ...v, burns: v.burns.map((b) => `${new Date(b.at).toISOString()} ${b.kind} ${b.amount} ${b.tx}`) }, null, 1))
    expect(v).toMatchObject({ token: KITS_CONTRACT, launchpad: KIT_LAUNCHPAD, launchId: '2699', decimals: 18, launchSupply: '1000000000000000000000000000' })
    expect(BigInt(v.burnedTotal)).toBe(BigInt(v.launchSupply) - BigInt(v.supply))
    expect(BigInt(v.burnedByTax)).toBeLessThanOrEqual(BigInt(v.burnedTotal))
    expect(v.burnCount).toBeGreaterThanOrEqual(6)
    expect(v.burns.reduce((s, b) => s + BigInt(b.amount), 0n) === BigInt(v.burnedTotal)).toBe(v.historyComplete)
  })
})
