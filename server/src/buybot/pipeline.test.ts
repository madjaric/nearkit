import { beforeEach, describe, expect, it } from 'vitest'
import type { MarketFigure, TokenMarket } from '@/types/domain'
import directBuy from '@/services/near/fixtures/flows/direct-buy-wrap-dcl.fastnear.json'
import directSell from '@/services/near/fixtures/flows/direct-sell-dcl.fastnear.json'
import { createFakeChain } from '@/services/real/testing/fakeChain'
import { loadConfig } from '../config'
import { migrate } from '../db/schema'
import { SqliteDatabase } from '../db/sqlite'
import { silentLogger } from '../log'
import { createServerNear } from '../near'
import { createTelegramApi } from '../telegram/api'
import { createFakeTelegram } from '../telegram/fake'
import { createFollower, MAX_BACKLOG, TRAIL, type IndexedTx, type TxIndex } from './follower'
import { createBuyMarket } from './market'
import { createDeliverer, createProcessor, FINAL_MARGIN, STALE_BLOCKS, STALE_MS } from './pipeline'
import { BuybotStore } from './store'

// Real mainnet transactions (2026-09-29) in the FastNEAR format the buybot reads.
const SING = 'singularty.nearlytrade.near'
const BUY = directBuy as unknown as { transaction: { hash: string }; block_height: number; receipts: unknown[] }
const SELL = directSell as unknown as { transaction: { hash: string }; block_height: number }

async function world() {
  let now = 50_000_000
  let head = BUY.block_height - 200
  const history: IndexedTx[] = []
  const full = new Map<string, unknown>()
  const indexCalls: string[] = []
  const index = {
    async recent(account: string) {
      indexCalls.push(`recent:${account}`)
      return { txs: account === SING ? [...history].sort((a, b) => b.blockHeight - a.blockHeight) : [], resumeToken: null }
    },
    async transactions(hashes: string[]) {
      indexCalls.push(`transactions:${hashes.length}`)
      return new Map(hashes.flatMap((h) => (full.has(h) ? [[h, full.get(h)] as [string, unknown]] : [])))
    },
  } as unknown as TxIndex

  const chain = createFakeChain({
    tokens: {
      [SING]: { symbol: 'SINGULARTY', name: 'Singularity is NEAR', decimals: 18, boundsMin: 1n, totalSupply: 10n ** 27n },
      'wrap.near': { symbol: 'wNEAR', name: 'Wrapped NEAR', decimals: 24, boundsMin: 1n },
    },
  })
  chain.route('https://api.exchange.coinbase.com/products/NEAR-USD/ticker', () => ({ price: '5.00' }))
  chain.route('https://api.exchange.coinbase.com/products/NEAR-USD/stats', () => ({ open: '5', last: '5' }))
  chain.route('https://api.rhea.finance/list-token-price', () => ({}))
  let holdersAnswer: unknown = { holders: [{ count: '286262' }] }
  chain.route(`https://api.nearblocks.io/v1/fts/${SING}/holders/count`, () => holdersAnswer)
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST' && init.body) {
      const body = JSON.parse(String(init.body)) as { id: unknown; method: string }
      if (body.method === 'block') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { header: { height: head } } }))
    }
    return chain.fetch(input, init)
  }) as typeof fetch

  const { config } = loadConfig({ NEAR_NETWORK: 'mainnet', NEARKIT_WEB_URL: 'http://localhost:5199' })
  const near = createServerNear(config, fetchImpl, () => now)
  const db = await SqliteDatabase.open(null)
  await migrate(db)
  const store = new BuybotStore(db, () => now)
  const market = createBuyMarket(near, () => now)
  const follower = createFollower({ network: 'mainnet', rpc: near.ctx.rpc, index, store, log: silentLogger })
  const process = createProcessor({ network: config.network, index, finalHeight: () => follower.finalHeight(), store, market, log: silentLogger })
  const tgFake = createFakeTelegram()
  const tg = createTelegramApi({ token: tgFake.token, fetch: tgFake.fetch, sleep: async () => {}, now: () => now })
  const deliver = createDeliverer({ tg, store, market, network: config.network, webUrl: config.webUrl, webNetwork: 'mainnet', log: silentLogger, now: () => now })
  return {
    store,
    near,
    now: () => now,
    follower,
    process,
    deliver,
    tgFake,
    indexCalls,
    /** The index starts showing this transaction (and can serve it in full). */
    publish(tx: { transaction: { hash: string }; block_height: number }, served: unknown = tx) {
      history.push({ hash: tx.transaction.hash, blockHeight: tx.block_height })
      full.set(tx.transaction.hash, served)
    },
    serve: (hash: string, served: unknown) => void full.set(hash, served),
    setHead: (h: number) => void (head = h),
    advance: (ms: number) => void (now += ms),
    /** What NearBlocks answers for the holder count (anything unreadable: no holders line). */
    setHolders: (v: unknown) => void (holdersAnswer = v),
    config: await store.addConfig({
      chatId: -100777,
      chatTitle: 'SINGULARTY fans',
      network: 'mainnet',
      token: SING,
      symbol: 'SINGULARTY',
      name: 'Singularity is NEAR',
      decimals: 18,
      createdBy: 1,
    }),
  }
}

/** Starts following (cursor below the buy), then lets the chain reach the buy and finalize it. */
async function reachBuy(w: Awaited<ReturnType<typeof world>>) {
  await w.follower.step()
  w.setHead(BUY.block_height + FINAL_MARGIN + TRAIL)
  await w.follower.step()
}

describe('buybot pipeline on the transaction index', () => {
  let w: Awaited<ReturnType<typeof world>>
  beforeEach(async () => {
    w = await world()
  })

  it('starts just below the head, never posting old buys', async () => {
    w.publish(BUY)
    w.setHead(BUY.block_height + 1000)
    expect(await w.follower.step()).toBe('caught-up')
    expect(await w.store.tokenCursor('mainnet', SING)).toBe(BUY.block_height + 1000 - TRAIL)
    expect(await w.process()).toBe(0)
  })

  it('finds the buy, reads it in full, and posts one alert with real figures', async () => {
    await w.follower.step()
    w.publish(BUY)
    w.publish(SELL)
    w.setHead(SELL.block_height + FINAL_MARGIN + TRAIL)
    await w.follower.step()
    expect(await w.process()).toBe(2)
    expect(await w.deliver()).toBe(1)
    const posts = w.tgFake.messages()
    expect(posts).toHaveLength(1)
    const text = posts[0]?.text ?? ''
    expect(posts[0]?.chatId).toBe(-100777)
    expect(text).toContain('<b>$SINGULARTY Buy!</b> · Singularity is NEAR')
    expect(text).toContain('1 NEAR')
    expect(text).toContain('($5.00)')
    expect(text).toContain('69,099 SINGULARTY')
    expect(text).toContain('mort1705.tg')
    expect(text).toContain(`https://nearblocks.io/txns/${BUY.transaction.hash}`)
    // No market source knows its circulating supply: FDV only (supply 1e9 × this buy's price), never called market cap.
    expect(text).toMatch(/🏦 FDV \$72\.\dK/)
    expect(text).not.toMatch(/market cap/i)
    expect(text).toContain('👥 Holders 286,262 (NearBlocks)')
    expect(text).toContain(`📄 CA <code>${SING}</code>`)
    expect(text).toContain('⚡ NEARKITS')
    // Paid in NEAR: the NEAR value is the amount itself, not repeated as an estimate.
    expect(text).not.toContain('≈')
    expect(posts[0]?.buttons).toEqual([
      { text: '🟢 Buy $SINGULARTY', url: `http://localhost:5199/swap?to=${SING}` },
      // NearKit's own Token Detail, at the canonical web URL: no DexScreener.
      { text: '📈 Chart', url: `http://localhost:5199/token/${SING}` },
      { text: '📋 Copy CA', copy: SING },
    ])
  })

  it('shows Market Cap only from the shared market service (a source that knows the circulating supply), with FDV beside it', async () => {
    const known = (value: number, source: string): MarketFigure => ({ state: 'known', value, source, at: 0 })
    const none: MarketFigure = { state: 'unavailable', reason: 'No source' }
    w.near.tokens.getMarketData = async (tokenId: string): Promise<TokenMarket> => ({
      tokenId,
      priceUsd: known(0.0047, 'DEX Screener'),
      priceNear: none,
      change24hPct: none,
      marketCapUsd: known(3_100_000, 'CoinGecko'),
      fdvUsd: known(4_700_000, 'DEX Screener'),
      liquidityUsd: none,
      volume24hUsd: none,
      supply: { circulating: 6.6e8, total: 1e9, source: 'CoinGecko' },
      pair: null,
      updatedAt: 0,
    })
    await w.follower.step()
    w.publish(BUY)
    w.setHead(BUY.block_height + FINAL_MARGIN + TRAIL)
    await w.follower.step()
    await w.process()
    await w.deliver()
    const text = w.tgFake.messages()[0]?.text ?? ''
    expect(text).toContain('🏦 Market Cap $3.1M · FDV $4.7M')
    expect(text).not.toContain('(FDV)')
  })

  it('waits for a transaction whose receipts are still executing', async () => {
    await w.follower.step()
    w.publish(BUY, { ...BUY, receipts: BUY.receipts.slice(0, -1) })
    w.setHead(BUY.block_height + FINAL_MARGIN + TRAIL)
    await w.follower.step()
    await w.process()
    await w.deliver()
    expect(w.tgFake.messages()).toHaveLength(0)
    w.serve(BUY.transaction.hash, BUY)
    w.advance(5_000)
    await w.process()
    await w.deliver()
    expect(w.tgFake.messages()).toHaveLength(1)
  })

  it('reads a transaction only once its block is final by a margin', async () => {
    await w.follower.step()
    w.publish(BUY)
    w.setHead(BUY.block_height + 1)
    await w.follower.step()
    await w.process()
    expect(w.indexCalls.filter((c) => c.startsWith('transactions'))).toEqual([])
  })

  it('is idempotent when the index shows the same transaction again', async () => {
    await w.follower.step()
    w.publish(BUY)
    // Head just far enough for the buy to be final: it sits inside the cursor's trailing window.
    w.setHead(BUY.block_height + FINAL_MARGIN)
    await w.follower.step()
    await w.process()
    await w.deliver()
    expect(await w.store.tokenCursor('mainnet', SING)).toBeLessThan(BUY.block_height)
    // The next passes see it again; nothing is re-read or re-posted.
    await w.follower.step()
    await w.follower.step()
    await w.process()
    await w.deliver()
    expect(w.tgFake.messages()).toHaveLength(1)
    expect(w.indexCalls.filter((c) => c.startsWith('transactions'))).toHaveLength(1)
  })

  it('respects the minimum buy size', async () => {
    await w.store.updateConfig(w.config.id, { minNear: 2n * 10n ** 24n })
    w.publish(BUY)
    await reachBuy(w)
    await w.process()
    await w.deliver()
    expect(w.tgFake.messages()).toHaveLength(0)
  })

  it('waits out a 429 and posts later; pauses a chat that removed the bot', async () => {
    await w.follower.step()
    w.publish(BUY)
    w.setHead(BUY.block_height + FINAL_MARGIN + TRAIL)
    await w.follower.step()
    await w.process()
    w.tgFake.failNext('sendMessage', { code: 429, description: 'Too Many Requests: retry after 90', retryAfter: 90 })
    await w.deliver()
    expect(w.tgFake.messages()).toHaveLength(0)
    w.advance(91_000)
    await w.deliver()
    expect(w.tgFake.messages()).toHaveLength(1)

    const other = await w.store.addConfig({ chatId: -100888, chatTitle: 'Gone', network: 'mainnet', token: SING, symbol: 'SINGULARTY', name: 'S', decimals: 18, createdBy: 1 })
    await w.store.recordBuy(
      { eventKey: 'x:y:z', network: 'mainnet', token: SING, side: 'buy', txHash: 'x', buyer: 'z.near', amount: 1n, paid: [{ asset: 'near', amount: 10n ** 24n }], blockHeight: 1 },
      [other.id],
    )
    w.tgFake.failNext('sendMessage', { code: 403, description: 'Forbidden: bot was kicked from the supergroup chat' })
    await w.deliver()
    expect((await w.store.config(other.id))?.pausedReason).toMatch(/kicked/)
    expect((await w.store.activeConfigsFor('mainnet', SING)).map((c) => c.id)).toEqual([w.config.id])
  })

  it('skips buys that became too old to post', async () => {
    await w.follower.step()
    w.publish(BUY)
    w.setHead(BUY.block_height + FINAL_MARGIN + TRAIL)
    await w.follower.step()
    await w.process()
    w.advance(STALE_MS + 1)
    await w.deliver()
    expect(w.tgFake.messages()).toHaveLength(0)
  })

  it('records but does not post a buy found far behind the chain head', async () => {
    await w.follower.step()
    w.publish(BUY)
    w.setHead(BUY.block_height + FINAL_MARGIN + TRAIL)
    await w.follower.step()
    w.setHead(BUY.block_height + STALE_BLOCKS + 1)
    await w.process()
    await w.deliver()
    expect(w.tgFake.messages()).toHaveLength(0)
  })

  it('skips ahead after a long outage instead of reading everything', async () => {
    await w.follower.step()
    const start = (await w.store.tokenCursor('mainnet', SING)) as number
    w.setHead(start + TRAIL + MAX_BACKLOG * 5)
    await w.follower.step()
    expect(await w.store.tokenCursor('mainnet', SING)).toBe(start + MAX_BACKLOG * 5)
  })
})

describe('buybot V2 in the pipeline', () => {
  let w: Awaited<ReturnType<typeof world>>
  beforeEach(async () => {
    w = await world()
  })

  async function bothTrades() {
    await w.follower.step()
    w.publish(BUY)
    w.publish(SELL)
    w.setHead(SELL.block_height + FINAL_MARGIN + TRAIL)
    await w.follower.step()
    await w.process()
    await w.deliver()
    return w.tgFake.messages()
  }

  it('posts sells only where sells are on, marked as sells with what the seller got', async () => {
    await w.store.updateConfig(w.config.id, { sells: true })
    const posts = await bothTrades()
    expect(posts).toHaveLength(2)
    const sell = posts.find((p) => p.text.includes('$SINGULARTY Sell'))?.text ?? ''
    expect(sell.startsWith('🔴')).toBe(true)
    expect(sell).toContain('NEAR')
    expect(sell).toContain('(this sale)')
  })

  it('a USD minimum compares the trade’s USD value; an unknown USD value passes only Any', async () => {
    // 1 NEAR at $5.00: below a $10 minimum, above $1.
    await w.store.updateConfig(w.config.id, { unit: 'USD', minUsd: 10 })
    expect(await bothTrades()).toHaveLength(0)
    const next = await world()
    await next.store.updateConfig(next.config.id, { unit: 'USD', minUsd: 1 })
    await next.follower.step()
    next.publish(BUY)
    next.setHead(BUY.block_height + FINAL_MARGIN + TRAIL)
    await next.follower.step()
    await next.process()
    await next.deliver()
    expect(next.tgFake.messages()).toHaveLength(1)
  })

  it('a holder count NearBlocks can’t give, or a price nobody has, is left out: never guessed', async () => {
    w.setHolders({ data: null, errors: [{ message: 'Server Error' }] })
    const [post] = await bothTrades()
    expect(post?.text).not.toContain('Holders')
    const next = await world()
    next.setHolders({ holders: [{ count: 'lots' }] })
    await next.follower.step()
    next.publish(BUY)
    next.setHead(BUY.block_height + FINAL_MARGIN + TRAIL)
    await next.follower.step()
    await next.process()
    await next.deliver()
    expect(next.tgFake.messages()[0]?.text).not.toContain('Holders')
  })

  it('a restart picks up where it left off: nothing is posted twice, nothing is lost', async () => {
    await w.follower.step()
    w.publish(BUY)
    w.setHead(BUY.block_height + FINAL_MARGIN + TRAIL)
    await w.follower.step()
    // "Crash" after detection, before delivery: a new processor and deliverer on the same database.
    expect(await w.process()).toBe(1)
    const restarted = createDeliverer({
      tg: createTelegramApi({ token: w.tgFake.token, fetch: w.tgFake.fetch, sleep: async () => {} }),
      store: w.store,
      market: createBuyMarket(w.near),
      network: w.near.ctx.network,
      webUrl: 'http://localhost:5199',
      webNetwork: 'mainnet',
      log: silentLogger,
      now: w.now,
    })
    expect(await restarted()).toBe(1)
    expect(await restarted()).toBe(0)
    expect(await w.deliver()).toBe(0)
    expect(w.tgFake.messages()).toHaveLength(1)
  })

  it('caps the emoji at the chat’s maximum', async () => {
    // 1 NEAR at 0.1 NEAR per emoji would be 10; the cap is 4.
    await w.store.updateConfig(w.config.id, { stepNear: 10n ** 23n, maxEmoji: 4 })
    const posts = await bothTrades()
    expect(posts[0]?.text.split('\n')[0]).toBe('🟢'.repeat(4))
  })

  it('posts with the chat’s photo, the alert as its caption; a file Telegram refuses falls back to text and drops the media', async () => {
    await w.store.updateConfig(w.config.id, { media: { kind: 'animation', fileId: 'gif-1' } })
    await bothTrades()
    const post = w.tgFake.calls.find((c) => c.method === 'sendAnimation')
    expect(post?.params).toMatchObject({ chat_id: -100777, animation: 'gif-1', parse_mode: 'HTML' })
    expect(String(post?.params.caption)).toContain('$SINGULARTY Buy!')

    const next = await world()
    await next.store.updateConfig(next.config.id, { media: { kind: 'photo', fileId: 'gone' } })
    next.tgFake.failNext('sendPhoto', { code: 400, description: 'Bad Request: wrong file identifier/HTTP URL specified' })
    await next.follower.step()
    next.publish(BUY)
    next.setHead(BUY.block_height + FINAL_MARGIN + TRAIL)
    await next.follower.step()
    await next.process()
    await next.deliver()
    expect(next.tgFake.messages().filter((m) => m.method === 'sendMessage')).toHaveLength(1)
    expect((await next.store.config(next.config.id))?.media).toBeNull()
  })
})
