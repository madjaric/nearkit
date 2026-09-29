import { describe, expect, it } from 'vitest'
import { looksLikeContract } from '@/lib/validation'
import type { TokenListing } from '@/types/domain'
import { buildResults } from './searchResults'

const SING = 'singularty.nearlytrade.near'
const listed: TokenListing[] = [
  { id: 'near', symbol: 'NEAR', name: 'NEAR', decimals: 24, contract: null, isNative: true, status: 'listed', source: 'native', market: null },
  { id: 'usdt.tether-token.near', symbol: 'USDt', name: 'Tether USD', decimals: 6, contract: 'usdt.tether-token.near', status: 'listed', source: 'known', market: null },
]
const sing: TokenListing = { id: SING, symbol: 'SINGULARTY', name: 'Singularity is NEAR', decimals: 18, contract: SING, status: 'listed', source: 'discovered', market: null }

describe('what reads as a contract', () => {
  it('named accounts with a dot, implicit and ETH-implicit addresses; not symbols', () => {
    expect(looksLikeContract(SING)).toBe(true)
    expect(looksLikeContract('a'.repeat(64).replace(/a/g, 'f'))).toBe(true)
    expect(looksLikeContract(`0x${'a'.repeat(40)}`)).toBe(true)
    expect(looksLikeContract('usdt')).toBe(false)
    expect(looksLikeContract('singularty')).toBe(false)
    // 64 characters that aren't hex are a name, not an implicit address.
    expect(looksLikeContract('z'.repeat(64))).toBe(false)
    expect(looksLikeContract('Bad.Near')).toBe(false)
  })
})

describe('global search: a contract in no list', () => {
  it('shows the token read from chain (symbol, name, decimals, not listed) and opens the swap with it', () => {
    const results = buildResults(SING, listed, { token: sing, note: null })
    const token = results.find((r) => r.group === 'Tokens')
    expect(token).toMatchObject({ label: 'SINGULARTY', to: `/swap?to=${encodeURIComponent(SING)}`, token: sing })
    expect(String(token?.detail)).toBe('Singularity is NEAR · 18 decimals · not listed')
    // The scan stays on offer, after the token.
    expect(results.map((r) => r.group)).toEqual(['Tokens', 'Scan'])
  })

  it('while checking, and when it isn’t a token, the scan row says so and no token is invented', () => {
    expect(buildResults(SING, listed, { token: null, note: 'Checking it on mainnet…' })).toMatchObject([{ group: 'Scan', detail: 'Checking it on mainnet…' }])
    const bad = buildResults('someone.near', listed, { token: null, note: 'someone.near is an account without a contract, not a token' })
    expect(bad.some((r) => r.group === 'Tokens')).toBe(false)
    expect(bad[0]?.detail).toContain('not a token')
  })

  it('a listed contract is matched from the list, once', () => {
    const results = buildResults('usdt.tether-token.near', listed, { token: listed[1] as TokenListing, note: null })
    expect(results.filter((r) => r.group === 'Tokens')).toHaveLength(1)
  })
})
