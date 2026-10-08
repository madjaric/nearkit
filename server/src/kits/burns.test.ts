import { describe, expect, it } from 'vitest'
import { KIT_LAUNCHPAD, KITS_CONTRACT } from '@/config/kit'
import { NETWORKS } from '@/config/networks'
import { fromFastnear } from '@/services/near/flows'
import fastnear from './fixtures/fastnear-burn-txs.json'
import nearblocks from './fixtures/nearblocks-burn-txns.json'
import { createKitsBurnTracker, nearblocksBurns, verifyBurn, type BurnCandidate } from './burns'

/**
 * $KITS' Buyback & Burn, read from NEAR mainnet. The fixtures are the chain as it was at block
 * ~219,011,700 (2026-10-08): NearBlocks' list of the token's six `burn` calls and FastNEAR's record
 * of those six transactions (receipts with logs only). The views below answered then:
 * the launchpad's get_tax for launch 2699 said 3,233,515.614392412283134581 KITS burned, and the
 * token's supply was 1,000,000,000 minus exactly that.
 */

const BURNED = '3233515614392412283134581'
const SUPPLY = '996766484385607587716865419'
const LAUNCH_SUPPLY = '1000000000000000000000000000'
const ids = { token: KITS_CONTRACT, launchpad: KIT_LAUNCHPAD, launchId: '2699' }

const MAINNET_VIEWS: Record<string, unknown> = {
  [`${KITS_CONTRACT}|get_tax`]: {
    tax: { buy_bps: 200, sell_bps: 200, pairs: ['dclv2.ref-labs.near'], admin: KIT_LAUNCHPAD, exempt: ['lock_8.nearlytrade.near', 'feeswap.near'] },
    pending: '244168395117898736962291',
  },
  [`${KITS_CONTRACT}|ft_total_supply`]: SUPPLY,
  [`${KITS_CONTRACT}|ft_metadata`]: { spec: 'ft-1.0.0', name: 'Near Kits', symbol: 'KITS', decimals: 18 },
  [`${KIT_LAUNCHPAD}|get_launch_by_token`]: { id: 2699, token: KITS_CONTRACT, name: 'Near Kits', symbol: 'KITS', total_supply: LAUNCH_SUPPLY },
  [`${KIT_LAUNCHPAD}|get_tax`]: {
    buy_bps: 200,
    sell_bps: 200,
    creator_bps: 0,
    burn_bps: 5000,
    holders_bps: 5000,
    platform_bps: 3000,
    pending: '0',
    holders_bucket: '182760158242382912431356',
    burned: BURNED,
    paid_creator: '0',
    paid_holders: '4177682594855589825795558',
    paid_platform: '3737522359798262347051638',
    selling: '0',
    floor: '0',
  },
}

function fakeChain(views: Record<string, unknown> = MAINNET_VIEWS, opts: { fastnearDown?: boolean; nearblocks?: unknown } = {}) {
  const calls = { views: [] as string[], nearblocks: 0, fastnear: [] as string[][] }
  const rpc = {
    async viewFunction<T>(contract: string, method: string, args: Record<string, unknown> = {}): Promise<T | null> {
      calls.views.push(`${contract}|${method}`)
      if (method === 'get_launch_by_token' && args.token !== KITS_CONTRACT) return null
      if (contract === KIT_LAUNCHPAD && method === 'get_tax' && args.launch_id !== '2699') throw new Error('unknown launch')
      const key = `${contract}|${method}`
      if (!(key in views)) throw new Error(`no view ${key}`)
      return views[key] as T
    },
  }
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('https://api.nearblocks.io/v1/account/kits.nearlytrade.near/txns?')) {
      calls.nearblocks++
      return new Response(JSON.stringify(opts.nearblocks ?? nearblocks), { status: 200 })
    }
    if (url === 'https://tx.main.fastnear.com/v0/transactions') {
      if (opts.fastnearDown) return new Response('down', { status: 503 })
      const hashes = (JSON.parse(String(init?.body)) as { tx_hashes: string[] }).tx_hashes
      calls.fastnear.push(hashes)
      return new Response(JSON.stringify({ transactions: fastnear.transactions.filter((t) => hashes.includes(t.transaction.hash)) }), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return { rpc, fetchImpl, calls }
}

const candidates = () => nearblocksBurns(nearblocks, KITS_CONTRACT)
const txOf = (hash: string) => fromFastnear(fastnear.transactions.find((t) => t.transaction.hash === hash))

describe('the burn transactions NearBlocks lists for kits.nearlytrade.near', () => {
  it('are the six burn calls made by Nearly’s launchpad, each with its amount and time', () => {
    const list = candidates()
    expect(list).toHaveLength(6)
    expect(list.every((c) => c.by === KIT_LAUNCHPAD)).toBe(true)
    expect(list[0]).toEqual({ tx: '8SzmYJDy4fnKkrZmuYPYkBtzPBZYrFt9frofsWVDjcg6', at: 1791418038627, amount: '78155059288019410500855', by: KIT_LAUNCHPAD })
    expect(list.reduce((s, c) => s + BigInt(c.amount), 0n).toString()).toBe(BURNED)
  })

  it('skips calls that failed, went to another contract or weren’t a burn, and refuses a page that isn’t a list', () => {
    const [first] = nearblocks.txns
    const failed = { ...first, transaction_hash: 'FaiLed1111111111111111111111111111111111111', outcomes: { status: false } }
    const elsewhere = { ...first, transaction_hash: 'E1sewhere11111111111111111111111111111111111', receiver_account_id: 'kits.fake.near' }
    const transfer = { ...first, transaction_hash: 'Transfer11111111111111111111111111111111111', actions: [{ ...first!.actions[0], method: 'ft_transfer' }] }
    expect(nearblocksBurns({ txns: [failed, elsewhere, transfer, first] }, KITS_CONTRACT).map((c) => c.tx)).toEqual([first!.transaction_hash])
    expect(() => nearblocksBurns({ data: null }, KITS_CONTRACT)).toThrow()
  })
})

describe('a burn, verified on its transaction', () => {
  it('is the ft_burn event the token contract itself emitted, of the listed amount, recorded by the launchpad as the tax’s Buyback & Burn share', () => {
    for (const c of candidates()) expect(verifyBurn(txOf(c.tx), c, ids)).toEqual({ tx: c.tx, at: c.at, amount: c.amount, kind: 'tax' })
  })

  it('is refused when the event didn’t come from the token contract, its receipt failed, or the amount differs from the listed one', () => {
    const c = candidates()[0] as BurnCandidate
    const tx = txOf(c.tx)
    const forged = { ...tx, receipts: tx.receipts.map((r) => (r.executorId === KITS_CONTRACT ? { ...r, executorId: 'kits.fake.near', receiverId: 'kits.fake.near' } : r)) }
    expect(verifyBurn(forged, c, ids)).toBeNull()
    const failed = { ...tx, receipts: tx.receipts.map((r) => (r.executorId === KITS_CONTRACT ? { ...r, success: false } : r)) }
    expect(verifyBurn(failed, c, ids)).toBeNull()
    expect(verifyBurn(tx, { ...c, amount: '1' }, ids)).toBeNull()
    expect(verifyBurn(txOf(candidates()[1]?.tx ?? ''), c, ids)).toBeNull()
  })

  it('is a burn the launchpad didn’t record as tax when its event names another launch or none', () => {
    const c = candidates()[0] as BurnCandidate
    expect(verifyBurn(txOf(c.tx), c, { ...ids, launchId: '1' })).toMatchObject({ kind: 'other' })
  })
})

describe('the tracker NEARKITS’ server serves ($KITS on mainnet only)', () => {
  it('reads the totals from chain state and every burn from its transaction: all of them, adding up to the supply burned', async () => {
    const { rpc, fetchImpl } = fakeChain()
    const tracker = createKitsBurnTracker({ rpc, fetch: fetchImpl, network: NETWORKS.mainnet, now: () => 1_791_420_000_000 })
    const v = await tracker.view()
    expect(v).toMatchObject({
      network: 'mainnet',
      token: KITS_CONTRACT,
      launchpad: KIT_LAUNCHPAD,
      launchId: '2699',
      decimals: 18,
      launchSupply: LAUNCH_SUPPLY,
      supply: SUPPLY,
      burnedTotal: BURNED,
      burnedByTax: BURNED,
      burnCount: 6,
      historyComplete: true,
      readAt: 1_791_420_000_000,
      historyReadAt: 1_791_420_000_000,
    })
    expect(v.burns.map((b) => b.at)).toEqual([...v.burns.map((b) => b.at)].sort((a, b) => b - a))
    expect(v.burns.every((b) => b.kind === 'tax')).toBe(true)
  })

  it('asks the chain again only after its interval, and checks each burn transaction once', async () => {
    let now = 1_791_420_000_000
    const { rpc, fetchImpl, calls } = fakeChain()
    const tracker = createKitsBurnTracker({ rpc, fetch: fetchImpl, network: NETWORKS.mainnet, now: () => now })
    await Promise.all([tracker.view(), tracker.view(), tracker.view()])
    const views = calls.views.length
    await tracker.view()
    expect(calls.views.length).toBe(views)
    expect(calls.nearblocks).toBe(1)
    now += 61_000
    await tracker.view()
    expect(calls.views.length).toBeGreaterThan(views)
    now += 121_000
    const v = await tracker.view()
    expect(calls.nearblocks).toBe(2)
    expect(calls.fastnear.flat()).toHaveLength(6)
    expect(v.burnCount).toBe(6)
  })

  it('refuses a launchpad that isn’t the token’s tax admin, or a launch that isn’t kits.nearlytrade.near', async () => {
    const notAdmin = fakeChain({
      ...MAINNET_VIEWS,
      [`${KITS_CONTRACT}|get_tax`]: { tax: { buy_bps: 200, sell_bps: 200, pairs: [], admin: 'someone.near', exempt: [] }, pending: '0' },
    })
    await expect(createKitsBurnTracker({ rpc: notAdmin.rpc, fetch: notAdmin.fetchImpl, network: NETWORKS.mainnet }).view()).rejects.toThrow(/tax admin/)
    const other = fakeChain({ ...MAINNET_VIEWS, [`${KIT_LAUNCHPAD}|get_launch_by_token`]: { id: 1, token: 'other.nearlytrade.near', total_supply: LAUNCH_SUPPLY } })
    await expect(createKitsBurnTracker({ rpc: other.rpc, fetch: other.fetchImpl, network: NETWORKS.mainnet }).view()).rejects.toThrow(/launch/)
    const inflated = fakeChain({ ...MAINNET_VIEWS, [`${KIT_LAUNCHPAD}|get_tax`]: { ...(MAINNET_VIEWS[`${KIT_LAUNCHPAD}|get_tax`] as object), burned: LAUNCH_SUPPLY } })
    await expect(createKitsBurnTracker({ rpc: inflated.rpc, fetch: inflated.fetchImpl, network: NETWORKS.mainnet }).view()).rejects.toThrow(/more burned than the supply lost/)
  })

  it('exists for mainnet only: testnet has no $KITS', () => {
    const { rpc, fetchImpl } = fakeChain()
    expect(() => createKitsBurnTracker({ rpc, fetch: fetchImpl, network: NETWORKS.testnet })).toThrow(/mainnet/)
  })

  it('keeps serving the totals when the history can’t be verified, and says the history is not complete', async () => {
    const { rpc, fetchImpl } = fakeChain(MAINNET_VIEWS, { fastnearDown: true })
    const v = await createKitsBurnTracker({ rpc, fetch: fetchImpl, network: NETWORKS.mainnet, now: () => 1_791_420_000_000 }).view()
    expect(v).toMatchObject({ burnedTotal: BURNED, burnedByTax: BURNED, burns: [], burnCount: 0, historyComplete: false, historyReadAt: null })
  })

  it('serves its last good reading when the chain doesn’t answer, and fails only when it never read one', async () => {
    let now = 1_791_420_000_000
    let down = false
    const chain = fakeChain()
    const rpc = { viewFunction: <T>(c: string, m: string, a?: Record<string, unknown>) => (down ? Promise.reject(new Error('rpc down')) : chain.rpc.viewFunction<T>(c, m, a)) }
    const tracker = createKitsBurnTracker({ rpc, fetch: chain.fetchImpl, network: NETWORKS.mainnet, now: () => now })
    const first = await tracker.view()
    down = true
    now += 61_000
    expect(await tracker.view()).toEqual(first)
    const cold = createKitsBurnTracker({ rpc, fetch: chain.fetchImpl, network: NETWORKS.mainnet, now: () => now })
    await expect(cold.view()).rejects.toThrow(/rpc down/)
  })
})

describe('the public route', () => {
  it('serves the tracker’s reading, and a plain 503 when the chain was never read', async () => {
    const { kitsRoutes } = await import('./routes')
    const { rpc, fetchImpl } = fakeChain()
    const ok = kitsRoutes({ burns: createKitsBurnTracker({ rpc, fetch: fetchImpl, network: NETWORKS.mainnet }) })['/api/kits/burns']
    expect(await ok?.({}, {} as never)).toMatchObject({ token: KITS_CONTRACT, burnedTotal: BURNED })
    const down = { viewFunction: () => Promise.reject(new Error('rpc down')) }
    const failing = kitsRoutes({ burns: createKitsBurnTracker({ rpc: down, fetch: fetchImpl, network: NETWORKS.mainnet }) })['/api/kits/burns']
    await expect(failing?.({}, {} as never)).rejects.toMatchObject({ status: 503, code: 'chain' })
  })
})
