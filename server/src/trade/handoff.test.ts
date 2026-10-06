import { beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../config'
import directBuy from '@/services/near/fixtures/flows/direct-buy-wrap-dcl.rpc.json'
import aggSell from '@/services/near/fixtures/flows/aggregator-sell.rpc.json'
import aggBuy from '@/services/near/fixtures/flows/aggregator-buy-with-rhea.rpc.json'
import legacyBuy from '@/services/near/fixtures/flows/legacy-log-buy-blackdragon.rpc.json'
import type { RpcTxResult } from '@/services/near/rpc'
import { createFakeChain, type FakeChain } from '@/services/real/testing/fakeChain'
import { migrate } from '../db/schema'
import { SqliteDatabase } from '../db/sqlite'
import { Store } from '../db/store'
import { createServerNear } from '../near'
import { createHandoffs, handoffUrl, HANDOFF_TTL_MS, type Handoffs } from './handoff'

// Real mainnet transactions: mort1705.tg bought SINGULARTY; pulamica.near's sell was refunded.
const BUY = directBuy as unknown as RpcTxResult
const REFUNDED = aggSell as unknown as RpcTxResult
const SING = 'singularty.nearlytrade.near'
// blackdragonmeme.near bought BLACKDRAGON, a token whose contract logs transfers as text lines (no events).
const BD_BUY = legacyBuy as unknown as RpcTxResult
const BLACKDRAGON = 'blackdragon.tkn.near'

let now = 1_000_000
let db: SqliteDatabase
let chain: FakeChain
let handoffs: Handoffs
let sent: { userId: number; html: string }[]
let traded: Parameters<NonNullable<Parameters<typeof createHandoffs>[0]['onTraded']>>[0][]

beforeEach(async () => {
  now = 1_000_000
  db = await SqliteDatabase.open(null)
  await migrate(db)
  const store = new Store(db, () => now)
  await store.upsertUser({ userId: 7, username: 'm', firstName: 'M', languageCode: null })
  chain = createFakeChain({
    tokens: {
      [SING]: { symbol: 'SINGULARTY', decimals: 18, boundsMin: 1n },
      'token.rhealab.near': { symbol: 'RHEA', decimals: 18, boundsMin: 1n },
      [BLACKDRAGON]: { symbol: 'BLACKDRAGON', decimals: 24, boundsMin: 1n },
    },
  })
  chain.settle(BD_BUY.transaction.hash, BD_BUY)
  chain.settle(BUY.transaction.hash, BUY)
  chain.settle(REFUNDED.transaction.hash, REFUNDED)
  chain.settle((aggBuy as unknown as RpcTxResult).transaction.hash, aggBuy as unknown as RpcTxResult)
  const { config } = loadConfig({ NEAR_NETWORK: 'mainnet', NEARKIT_WEB_URL: 'http://localhost:5199' })
  const near = createServerNear(config, chain.fetch, () => now)
  sent = []
  handoffs = createHandoffs({
    db,
    network: config.network,
    rpc: near.ctx.rpc,
    webUrl: config.webUrl,
    now: () => now,
    describeToken: async (id) => {
      const m = await near.ctx.reader.metadata(id)
      return { symbol: m.symbol, decimals: m.decimals }
    },
    notify: async (userId, html) => void sent.push({ userId, html }),
    onTraded: async (t) => void traded.push(t),
  })
  traded = []
})

const prepare = (accountId: string, side: 'buy' | 'sell' = 'buy') =>
  handoffs.create({ userId: 7, chatId: 7, accountId, side, tokenIn: side === 'buy' ? 'near' : SING, tokenOut: side === 'buy' ? SING : 'near', amountIn: '1', slippagePct: 1 })

describe('trade handoffs', () => {
  it('puts the prepared trade in a swap link with a random ID', async () => {
    const { handoff, url } = await prepare('mort1705.tg')
    expect(url).toBe(`http://localhost:5199/swap?from=near&to=${SING}&amount=1&slippage=1&tg=${handoff.id}`)
    expect(handoff.id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(handoff.expiresAt).toBe(now + HANDOFF_TTL_MS)
    expect(handoffUrl('https://x.app', { ...handoff, amountIn: '0.5' })).toContain('amount=0.5')
  })

  it('confirms from the chain: what the linked account received and paid, and tells the user once', async () => {
    const { handoff } = await prepare('mort1705.tg')
    const r = await handoffs.report(handoff.id, [BUY.transaction.hash])
    expect(r).toEqual({ status: 'confirmed', outcome: 'traded' })
    expect((await handoffs.get(handoff.id))?.result?.trade).toMatchObject({ amount: '69099416000669574619652', paid: [{ asset: 'near', amount: '1000000000000000000000000' }] })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.html).toContain('Bought 69,099.416 SINGULARTY')
    expect(sent[0]?.html).toContain('for 1 NEAR')
    expect(sent[0]?.html).toContain(`https://nearblocks.io/txns/${BUY.transaction.hash}`)
    // A second report changes nothing and sends nothing.
    expect(await handoffs.report(handoff.id, [BUY.transaction.hash])).toEqual({ status: 'confirmed', outcome: 'traded' })
    expect(sent).toHaveLength(1)
  })

  it('a token whose contract logs its transfers as text lines (BLACKDRAGON): the trade is confirmed too, never reported as failed', async () => {
    const { handoff } = await handoffs.create({
      userId: 7,
      chatId: 7,
      accountId: 'blackdragonmeme.near',
      side: 'buy',
      tokenIn: 'near',
      tokenOut: BLACKDRAGON,
      amountIn: '134',
      slippagePct: 1,
    })
    expect(await handoffs.report(handoff.id, [BD_BUY.transaction.hash])).toEqual({ status: 'confirmed', outcome: 'traded' })
    expect((await handoffs.get(handoff.id))?.result?.trade).toMatchObject({
      amount: '32826022038988341595633215922069281',
      paid: [{ asset: 'near', amount: '134000000000000000000000000' }],
    })
  })

  it('passes on the app fee the chain reports for a traded handoff (referral accounting), with the account it went to', async () => {
    const tx = aggBuy as unknown as RpcTxResult
    const { handoff } = await handoffs.create({
      userId: 7,
      chatId: 7,
      accountId: 'alijay3637.tg',
      side: 'buy',
      tokenIn: 'near',
      tokenOut: 'token.rhealab.near',
      amountIn: '1',
      slippagePct: 1,
    })
    expect(await handoffs.report(handoff.id, [tx.transaction.hash])).toEqual({ status: 'confirmed', outcome: 'traded' })
    // This real mainnet trade paid its app fee to another app (intents.tg): 80% of it, Rhea kept 20%.
    expect(traded).toEqual([
      { handoff: expect.objectContaining({ id: handoff.id }), fee: { token: 'wrap.near', raw: '3051167925170260218148', recipient: 'intents.tg' }, txHash: tx.transaction.hash },
    ])
    // A handoff that didn't trade reports nothing.
    const { handoff: refunded } = await prepare('pulamica.near', 'sell')
    await handoffs.report(refunded.id, [REFUNDED.transaction.hash])
    expect(traded).toHaveLength(1)
  })

  it('one transaction confirms one handoff: reported again for another, it is refused and earns nothing more', async () => {
    const tx = aggBuy as unknown as RpcTxResult
    const make = () =>
      handoffs.create({ userId: 7, chatId: 7, accountId: 'alijay3637.tg', side: 'buy', tokenIn: 'near', tokenOut: 'token.rhealab.near', amountIn: '1', slippagePct: 1 })
    const first = (await make()).handoff
    const second = (await make()).handoff
    expect(await handoffs.report(first.id, [tx.transaction.hash])).toEqual({ status: 'confirmed', outcome: 'traded' })
    await expect(handoffs.report(second.id, [tx.transaction.hash])).rejects.toMatchObject({ status: 409, code: 'used' })
    expect(traded).toHaveLength(1)
    expect(sent).toHaveLength(1)
    // The second handoff stays open for its own trade.
    expect((await handoffs.describe(second.id)).status).toBe('open')
  })

  it('refuses a transaction signed by someone else', async () => {
    const { handoff } = await prepare('alice.near')
    // The RPC finds transactions by hash and signer: someone else's hash is unknown for alice.near.
    chain.settle(BUY.transaction.hash, { ...BUY, transaction: { ...BUY.transaction, signer_id: 'mort1705.tg' } })
    await expect(handoffs.report(handoff.id, [BUY.transaction.hash])).rejects.toMatchObject({ status: 403, code: 'signer' })
    expect((await handoffs.get(handoff.id))?.status).toBe('open')
    expect(sent).toEqual([])
  })

  it('says plainly when the swap was refunded instead of traded', async () => {
    const { handoff } = await prepare('pulamica.near', 'sell')
    expect(await handoffs.report(handoff.id, [REFUNDED.transaction.hash])).toEqual({ status: 'failed', outcome: 'no-trade' })
    expect(sent[0]?.html).toContain('no swap went through')
  })

  it('rejects malformed input and unknown transactions without settling', async () => {
    const { handoff } = await prepare('mort1705.tg')
    await expect(handoffs.report(handoff.id, [])).rejects.toMatchObject({ status: 400 })
    await expect(handoffs.report(handoff.id, ['not a hash'])).rejects.toMatchObject({ status: 400 })
    await expect(handoffs.report(handoff.id, ['1'.repeat(44)])).rejects.toMatchObject({ status: 409, code: 'unknown-tx' })
    await expect(handoffs.report('nope', [BUY.transaction.hash])).rejects.toMatchObject({ status: 404 })
    expect((await handoffs.get(handoff.id))?.status).toBe('open')
  })

  it('stops accepting reports a day later', async () => {
    const { handoff } = await prepare('mort1705.tg')
    now += 25 * 3_600_000
    await expect(handoffs.report(handoff.id, [BUY.transaction.hash])).rejects.toMatchObject({ status: 410 })
  })
})
