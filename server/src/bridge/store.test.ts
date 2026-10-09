import { describe, expect, it } from 'vitest'
import type { BridgeQuoteView } from '@/lib/bridge/types'
import { migrate } from '../db/schema'
import { ENGINE_TIMEOUT_MS, openTestDatabase, TEST_ENGINES, type TestEngine } from '../db/testing'
import { BridgeStore, type NewBridgeOrder } from './store'

/**
 * Bridge orders after the generic Bridge arrived: one table for both products. An order made before
 * it (production's Bridge & Buy rows) reads back exactly as it was, as Bridge & Buy; a Bridge order
 * can go to any NEAR account ('external'); the database itself refuses anything else.
 */

/** The schema each engine had before the generic Bridge: Bridge & Buy only. */
const BEFORE: Record<TestEngine, number> = { sqlite: 15, pglite: 6, postgres: 6 }

const QUOTE = { chain: 'sol', amountIn: '1000000000', nearOut: '1', nearMinOut: '1', fee: {} } as unknown as BridgeQuoteView

const order = (over: Partial<NewBridgeOrder> = {}): NewBridgeOrder => ({
  network: 'mainnet',
  product: 'buy-kits',
  kind: 'connected',
  userId: null,
  walletId: null,
  recipient: 'bob.near',
  chain: 'sol',
  originAsset: 'nep141:sol.omft.near',
  sourceAddress: 'So1ana',
  amountIn: '1000000000',
  depositAddress: `dep-${Math.random()}`,
  depositDeadline: 2,
  signBy: 1,
  quote: QUOTE,
  oneclick: { signature: 'ed25519:x' },
  kitsMinPerNear: '5',
  kitsSlippage: 1,
  nextCheckAt: null,
  ...over,
})

describe.each(TEST_ENGINES)('bridge orders on %s', (engine) => {
  it(
    'a Bridge & Buy order made before the generic Bridge reads back unchanged, as Bridge & Buy',
    async () => {
      const db = await openTestDatabase(engine, { migrateTo: BEFORE[engine] })
      await db.run(
        `INSERT INTO bridge_orders (id, network, kind, user_id, wallet_id, recipient, chain, origin_asset, source_address, amount_in, deposit_address,
           deposit_deadline, sign_by, quote, oneclick, kits_min_per_near, kits_slippage, status, next_check_at, checks, created_at, updated_at)
         VALUES ('old-order-1', 'mainnet', 'connected', NULL, NULL, 'bob.near', 'sol', 'nep141:sol.omft.near', 'So1ana', '1000000000', 'dep-old',
           2, 1, ?, '{}', '5', 1, 'delivered', NULL, 0, 10, 10)`,
        [JSON.stringify(QUOTE)],
      )
      await migrate(db)
      const o = await new BridgeStore(db).get('old-order-1')
      expect(o).toMatchObject({
        id: 'old-order-1',
        product: 'buy-kits',
        kind: 'connected',
        status: 'delivered',
        recipient: 'bob.near',
        kitsMinPerNear: '5',
        depositAddress: 'dep-old',
      })
      // One deposit address is still one order after the rebuild.
      await expect(
        db.run(
          `INSERT INTO bridge_orders (id, network, kind, recipient, chain, origin_asset, source_address, amount_in, deposit_address, deposit_deadline, sign_by, quote, oneclick, kits_slippage, status, checks, created_at, updated_at) VALUES ('dup', 'mainnet', 'connected', 'x.near', 'sol', 'a', 'b', '1', 'dep-old', 1, 1, '{}', '{}', 0, 'awaiting-deposit', 0, 1, 1)`,
        ),
      ).rejects.toThrow()
    },
    ENGINE_TIMEOUT_MS,
  )

  it(
    'a Bridge order to any NEAR account is stored as one; the database refuses an unknown product or destination',
    async () => {
      const db = await openTestDatabase(engine)
      const store = new BridgeStore(db)
      const o = await store.create(order({ product: 'bridge', kind: 'external', recipient: 'carol.near', kitsMinPerNear: null, kitsSlippage: 0 }))
      expect(await store.get(o.id)).toMatchObject({ product: 'bridge', kind: 'external', recipient: 'carol.near', kitsMinPerNear: null })
      await expect(store.create(order({ product: 'other' as never }))).rejects.toThrow()
      await expect(store.create(order({ kind: 'custodian' as never }))).rejects.toThrow()
    },
    ENGINE_TIMEOUT_MS,
  )
})

/** The schema each engine had before Telegram's Bridge: the generic Bridge, no request key, no notices. */
const BEFORE_TELEGRAM: Record<TestEngine, number> = { sqlite: 16, pglite: 7, postgres: 7 }

describe.each(TEST_ENGINES)('bridge orders for Telegram on %s', (engine) => {
  it(
    'an order made before Telegram’s Bridge reads back unchanged, with no request key and nothing announced',
    async () => {
      const db = await openTestDatabase(engine, { migrateTo: BEFORE_TELEGRAM[engine] })
      await db.run(
        `INSERT INTO bridge_orders (id, network, product, kind, user_id, wallet_id, recipient, chain, origin_asset, source_address, amount_in, deposit_address,
           deposit_deadline, sign_by, quote, oneclick, kits_min_per_near, kits_slippage, status, next_check_at, checks, created_at, updated_at)
         VALUES ('old-bridge-1', 'mainnet', 'bridge', 'external', NULL, NULL, 'carol.near', 'sol', 'nep141:sol.omft.near', 'So1ana', '1000000000', 'dep-old-2',
           2, 1, ?, '{}', NULL, 0, 'complete', NULL, 0, 10, 10)`,
        [JSON.stringify(QUOTE)],
      )
      await migrate(db)
      const o = await new BridgeStore(db).get('old-bridge-1')
      expect(o).toMatchObject({ id: 'old-bridge-1', product: 'bridge', kind: 'external', status: 'complete', requestKey: null, notified: null })
    },
    ENGINE_TIMEOUT_MS,
  )

  it(
    'one request key is one order: found again by it, and the database refuses a second order with it',
    async () => {
      const db = await openTestDatabase(engine)
      const store = new BridgeStore(db)
      const key = 'tg-key-0123456789abcdef'
      const o = await store.create(order({ product: 'bridge', kind: 'nearkits', recipient: 'w.near', kitsMinPerNear: null, kitsSlippage: 0, requestKey: key }))
      expect(o.requestKey).toBe(key)
      expect((await store.byRequestKey(key))?.id).toBe(o.id)
      expect(await store.byRequestKey('another-key-0123456789')).toBeNull()
      await expect(store.create(order({ requestKey: key }))).rejects.toThrow()
      // Orders without a key are as many as there are deposit addresses.
      await store.create(order())
      await store.create(order())
    },
    ENGINE_TIMEOUT_MS,
  )

  it(
    'a notice is claimed once: the same one again, or an earlier one after a later one, is refused',
    async () => {
      const db = await openTestDatabase(engine)
      const store = new BridgeStore(db)
      const o = await store.create(order({ product: 'bridge', kind: 'nearkits', recipient: 'w.near', kitsMinPerNear: null, kitsSlippage: 0 }))
      expect(await store.claimNotice(o.id, 'deposit', [])).toBe(true)
      expect(await store.claimNotice(o.id, 'deposit', [])).toBe(false)
      expect(await store.claimNotice(o.id, 'complete', [])).toBe(true)
      // 'deposit' comes before 'complete': once the order announced it was complete, a late deposit notice is not sent.
      expect(await store.claimNotice(o.id, 'deposit', ['complete'])).toBe(false)
      expect((await store.get(o.id))?.notified).toBe('complete')
    },
    ENGINE_TIMEOUT_MS,
  )

  it(
    'the source address a user last sent from on a chain, for their next order there',
    async () => {
      const db = await openTestDatabase(engine)
      const store = new BridgeStore(db)
      const now = { t: 1 }
      const timed = new BridgeStore(db, () => now.t)
      await db.run("INSERT INTO telegram_users (user_id, username, first_name, language_code, created_at, updated_at) VALUES (7, NULL, 'U', NULL, 1, 1)").catch(() => undefined)
      await timed.create(order({ userId: 7, kind: 'nearkits', chain: 'sol', sourceAddress: 'OldSolAddress' }))
      now.t = 5
      await timed.create(order({ userId: 7, kind: 'nearkits', chain: 'sol', sourceAddress: 'NewSolAddress' }))
      await timed.create(order({ userId: 7, kind: 'nearkits', chain: 'eth', sourceAddress: '0xabc' }))
      expect(await store.lastSourceAddress(7, 'mainnet', 'sol')).toBe('NewSolAddress')
      expect(await store.lastSourceAddress(7, 'mainnet', 'bsc')).toBeNull()
      expect(await store.lastSourceAddress(8, 'mainnet', 'sol')).toBeNull()
    },
    ENGINE_TIMEOUT_MS,
  )
})
