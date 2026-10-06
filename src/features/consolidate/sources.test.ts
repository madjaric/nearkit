import { describe, expect, it } from 'vitest'
import { heldBalances } from '@/lib/tokenRanking'
import type { Holding, TokenListing, Wallet } from '@/types/domain'
import { consolidatePool, defaultConsolidateToken, defaultFamily } from './sources'

/**
 * Consolidate gathers one token from several wallets into one: every wallet that can act is a
 * possible source (NearKit wallets through NearKit's server, the connected wallet's accounts signed
 * here), never a watch-only or frozen one, never the destination itself.
 */

const wallet = (id: string, source: 'nearkit' | 'external' | 'watch', extra: Partial<Wallet> = {}): Wallet => ({
  id,
  label: id,
  accountId: id,
  kind: 'named',
  isMain: false,
  access: source === 'watch' ? 'watch' : 'signer',
  source,
  ...extra,
})
const A = wallet('a.near', 'nearkit', { nearkitId: 'nk-a' })
const B = wallet('b.near', 'nearkit', { nearkitId: 'nk-b' })
const FROZEN = wallet('f.near', 'nearkit', { nearkitId: 'nk-f', frozen: true })
const CONNECTED = wallet('me.near', 'external')
const WATCH = wallet('watch.near', 'watch')
const WALLETS = [A, B, FROZEN, CONNECTED, WATCH]

const SING = 'singularty.nearlytrade.near'
const NEARLY = 'nearly-2.nearlytrade.near'
const hold = (walletId: string, tokenId: string, amount: number): Holding => ({ walletId, tokenId, amount, raw: '1', verified: true })
const listing = (id: string, symbol: string, priceUsd: number | null = null, isNative = false): TokenListing => ({
  id,
  symbol,
  name: symbol,
  decimals: 18,
  contract: isNative ? null : id,
  isNative,
  status: 'listed',
  market: priceUsd === null ? null : { tokenId: id, priceUsd, priceNear: 0, change24hPct: null, liquidityUsd: null, volume24hUsd: null, updatedAt: 0 },
})
const TOKENS = [
  listing('near', 'NEAR', 5, true),
  listing('wrap.near', 'wNEAR', 5),
  listing('usdt.tether-token.near', 'USDt', 1),
  listing(SING, 'SINGULARTY'),
  listing(NEARLY, 'NEARLY', 0.002),
]

describe('who can be a source', () => {
  it('every wallet that can act except the destination: NEARKITS wallets (not frozen) and the connected accounts; never a watch-only wallet', () => {
    const pool = consolidatePool(WALLETS, A.id)
    expect(pool.nearkit.map((w) => w.id)).toEqual([B.id])
    expect(pool.browser.map((w) => w.id)).toEqual([CONNECTED.id])
    expect(pool.all.map((w) => w.id)).toEqual([B.id, CONNECTED.id])
    expect(consolidatePool(WALLETS, WATCH.id).all.map((w) => w.id)).toEqual([A.id, B.id, CONNECTED.id])
  })

  it('a watch-only wallet’s balance never makes a token available to move', () => {
    const holdings = [hold(WATCH.id, SING, 9_999), hold(A.id, NEARLY, 10)]
    const held = heldBalances(
      holdings,
      consolidatePool(WALLETS, CONNECTED.id).all.map((w) => w.id),
    )
    expect(held.has(SING)).toBe(false)
    expect(held.get(NEARLY)).toBe(10)
  })
})

describe('which family a run starts from (NEARKITS wallets or connected accounts, one at a time)', () => {
  it('the one with more wallets holding the token; NEARKITS on a tie; the only one there is', () => {
    const pool = consolidatePool([A, B, CONNECTED, wallet('me2.near', 'external')], 'dest.near')
    expect(defaultFamily(pool, (id) => id === A.id || id === B.id)).toBe('nearkit')
    expect(defaultFamily(pool, (id) => id === CONNECTED.id || id === 'me2.near')).toBe('browser')
    expect(defaultFamily(pool, () => false)).toBe('nearkit')
    expect(defaultFamily(consolidatePool([CONNECTED], 'x'), () => false)).toBe('browser')
    expect(defaultFamily(consolidatePool([A], 'x'), () => false)).toBe('nearkit')
  })
})

describe('the token a Consolidate opens on', () => {
  it('the most valuable token the sources hold, another token before NEAR; a token without a price still counts', () => {
    expect(defaultConsolidateToken(TOKENS, new Map([[SING, 1_000_000]]), 'wrap.near')).toBe(SING)
    expect(
      defaultConsolidateToken(
        TOKENS,
        new Map([
          ['near', 100],
          [NEARLY, 40_000],
          [SING, 5],
        ]),
        'wrap.near',
      ),
    ).toBe(NEARLY)
    expect(defaultConsolidateToken(TOKENS, new Map([['near', 3]]), 'wrap.near')).toBe('near')
  })

  it('nothing held (or balances not read yet): the fallback', () => {
    expect(defaultConsolidateToken(TOKENS, new Map(), 'wrap.near')).toBe('wrap.near')
  })
})
