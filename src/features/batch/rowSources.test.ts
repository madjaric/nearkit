import { describe, expect, it } from 'vitest'
import { tradeWalletPool } from '@/lib/wallets'
import type { Wallet } from '@/types/domain'
import { nearkitLines, perRowSources, rowSource, totalsBySource } from './rowSources'

/**
 * Batch Send, Manual: while the batch runs on NearKit wallets, each row may name the NearKit wallet
 * it sends from. A row that names none follows Send from; nothing else can be chosen.
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
const MAIN = wallet('main.near', 'nearkit', { label: 'Main', nearkitId: 'nk-main' })
const SNIPER = wallet('sniper.near', 'nearkit', { label: 'Sniper A', nearkitId: 'nk-sniper' })
const FROZEN = wallet('frozen.near', 'nearkit', { label: 'Frozen', nearkitId: 'nk-frozen', frozen: true })
const CONNECTED = wallet('me.near', 'external', { label: 'Me' })
const WATCH = wallet('watch.near', 'watch', { label: 'Watched' })
// What Send from offers (useSourceWallet): NearKit wallets that aren't frozen, then the connected accounts.
const POOL = tradeWalletPool([MAIN, SNIPER, FROZEN, CONNECTED, WATCH])

describe('when Manual rows offer their own wallet', () => {
  const pool = POOL.options.filter((w) => w.source === 'nearkit')

  it('Send from is one of two or more NEARKITS wallets: each row picks its own', () => {
    expect(perRowSources('manual', MAIN, pool)).toBe('rows')
    expect(perRowSources('manual', SNIPER, pool)).toBe('rows')
  })

  it('Send from is the connected account, with two or more NEARKITS wallets: the page says how to get there (rows still send from Send from)', () => {
    expect(perRowSources('manual', CONNECTED, pool)).toBe('switch')
  })

  it('never in Paste list, never with a single NEARKITS wallet, never from a watch-only account', () => {
    expect(perRowSources('paste', MAIN, pool)).toBeNull()
    expect(perRowSources('paste', CONNECTED, pool)).toBeNull()
    expect(perRowSources('manual', MAIN, [MAIN])).toBeNull()
    expect(perRowSources('manual', CONNECTED, [MAIN])).toBeNull()
    expect(perRowSources('manual', WATCH, pool)).toBeNull()
    expect(perRowSources('manual', undefined, pool)).toBeNull()
  })
})

describe('the wallet a manual row sends from', () => {
  it('follows Send from until the row names a wallet', () => {
    expect(rowSource(undefined, MAIN.id, POOL.nearkit)).toBe(MAIN.id)
    expect(rowSource(undefined, SNIPER.id, POOL.nearkit)).toBe(SNIPER.id)
  })

  it('a row that names another NEARKITS wallet sends from it; rows can each name a different one', () => {
    expect(rowSource(SNIPER.id, MAIN.id, POOL.nearkit)).toBe(SNIPER.id)
    expect([undefined, SNIPER.id, MAIN.id].map((choice) => rowSource(choice, MAIN.id, POOL.nearkit))).toEqual([MAIN.id, SNIPER.id, MAIN.id])
  })

  it('never a watch-only, frozen or unknown wallet, and never from a connected account’s batch (it signs the whole batch itself)', () => {
    for (const choice of [WATCH.id, FROZEN.id, CONNECTED.id, 'made-up.near']) expect(rowSource(choice, MAIN.id, POOL.nearkit)).toBe(MAIN.id)
    expect(rowSource(SNIPER.id, CONNECTED.id, POOL.nearkit)).toBe(CONNECTED.id)
  })
})

describe('what each wallet sends in all', () => {
  it('sums each source’s lines exactly, in the token’s units', () => {
    const totals = totalsBySource(
      [
        { source: MAIN.id, amountText: '0.1' },
        { source: SNIPER.id, amountText: '2.5' },
        { source: MAIN.id, amountText: '0.25' },
      ],
      6,
    )
    expect(totals).toEqual(
      new Map([
        [MAIN.id, 350_000n],
        [SNIPER.id, 2_500_000n],
      ]),
    )
  })
})

describe('the lines NEARKITS’ server sends', () => {
  it('every row from Send from: the lines are exactly as before (no per-line wallet)', () => {
    expect(
      nearkitLines(
        [
          { to: 'alice.near', amount: '1', source: MAIN },
          { to: 'bob.near', amount: '2', source: MAIN },
        ],
        MAIN,
      ),
    ).toEqual([
      { to: 'alice.near', amount: '1' },
      { to: 'bob.near', amount: '2' },
    ])
  })

  it('rows from different wallets: every line names the NEARKITS wallet that sends it (its server id, name and account)', () => {
    expect(
      nearkitLines(
        [
          { to: 'alice.near', amount: '1', source: MAIN },
          { to: 'bob.near', amount: '2', source: SNIPER },
        ],
        MAIN,
      ),
    ).toEqual([
      { to: 'alice.near', amount: '1', from: { walletId: 'nk-main', label: 'Main', accountId: MAIN.accountId } },
      { to: 'bob.near', amount: '2', from: { walletId: 'nk-sniper', label: 'Sniper A', accountId: SNIPER.accountId } },
    ])
  })
})
