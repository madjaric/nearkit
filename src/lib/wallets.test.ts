import { describe, expect, it } from 'vitest'
import type { Wallet } from '@/types/domain'
import { canExecute, executableWallets, executesViaNearKit, presetMembers, signsInBrowser, sourceOf, tradeWalletPool } from './wallets'

const w = (id: string, over: Partial<Wallet> = {}): Wallet => ({ id, label: id, accountId: id, kind: 'named', isMain: false, ...over })

describe('wallet classes', () => {
  it('tells NEARKITS wallets, connected wallets and watch-only accounts apart', () => {
    const nearkit = w('degen', { source: 'nearkit', access: 'signer' })
    const external = w('bottest.near', { source: 'external', access: 'signer' })
    const watch = w('trader.near', { source: 'watch', access: 'watch' })
    expect([nearkit, external, watch].map(sourceOf)).toEqual(['nearkit', 'external', 'watch'])
    expect([nearkit, external, watch].map(canExecute)).toEqual([true, true, false])
    // NearKit wallets are never signed in the browser: NearKit's server executes them.
    expect([nearkit, external, watch].map(signsInBrowser)).toEqual([false, true, false])
    expect([nearkit, external, watch].map(executesViaNearKit)).toEqual([true, false, false])
  })

  it('reads older wallets without a source from their access (demo and saved data)', () => {
    expect(sourceOf(w('w01'))).toBe('external')
    expect(sourceOf(w('w02', { access: 'signer' }))).toBe('external')
    expect(sourceOf(w('watch-1', { access: 'watch' }))).toBe('watch')
    // A watch access always wins: a client can't lift it by claiming another source.
    expect(sourceOf(w('x', { source: 'external', access: 'watch' }))).toBe('watch')
  })
})

describe('presetMembers', () => {
  const list = [w('a', { source: 'external', access: 'signer' }), w('b', { source: 'nearkit', access: 'signer' }), w('c', { source: 'watch', access: 'watch' })]

  it('keeps the executable members and names the rest, so a legacy preset never runs a watch wallet', () => {
    const r = presetMembers({ walletIds: ['a', 'b', 'c', 'gone'] }, list)
    expect(r.executable.map((x) => x.id)).toEqual(['a', 'b'])
    expect(r.excluded).toEqual([
      { id: 'c', reason: 'watch' },
      { id: 'gone', reason: 'missing' },
    ])
  })
})

describe('executableWallets: what the portfolio is made of', () => {
  const list = [
    w('a', { source: 'external', access: 'signer' }),
    w('b', { source: 'nearkit', access: 'signer' }),
    w('c', { source: 'watch', access: 'watch' }),
    w('d', { access: 'watch' }),
  ]

  it('keeps every wallet that can act and leaves every watch-only one out, by the one rule canExecute states', () => {
    expect(executableWallets(list).map((x) => x.id)).toEqual(['a', 'b'])
    expect(executableWallets(list)).toEqual(list.filter(canExecute))
    expect(executableWallets(list.filter((x) => !canExecute(x)))).toEqual([])
    expect(executableWallets([])).toEqual([])
  })
})

describe('tradeWalletPool: where a trade ticket may spend from', () => {
  it('offers NEARKITS wallets that are not frozen, then the connected accounts, and never a watch-only wallet, whatever it holds', () => {
    const list = [
      w('nk', { source: 'nearkit', access: 'signer' }),
      w('frozen', { source: 'nearkit', access: 'signer', frozen: true }),
      w('me.near', { source: 'external', access: 'signer' }),
      w('whale.near', { source: 'watch', access: 'watch' }),
    ]
    const pool = tradeWalletPool(list)
    expect(pool.nearkit.map((x) => x.id)).toEqual(['nk'])
    expect(pool.browser.map((x) => x.id)).toEqual(['me.near'])
    expect(pool.options.map((x) => x.id)).toEqual(['nk', 'me.near'])
    expect(pool.options.every(canExecute)).toBe(true)
  })
})
