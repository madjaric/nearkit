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

describe('global search opens a token’s own page (Token Detail), never the swap', () => {
  it('a symbol opens its Token Detail, showing the name and the contract', () => {
    const token = buildResults('usdt', listed).find((r) => r.group === 'Tokens')
    expect(token).toMatchObject({ label: 'USDt', to: '/token/usdt.tether-token.near' })
    expect(String(token?.detail)).toBe('Tether USD · usdt.tether-token.near')
  })

  it('"nearly" ranks the NEARLY token first, above launches whose contract merely contains it; the result opens Token Detail', () => {
    const launch = (contract: string, symbol: string, name: string): TokenListing => ({
      id: contract,
      symbol,
      name,
      decimals: 18,
      contract,
      status: 'listed',
      source: 'discovered',
      market: null,
    })
    const tokens = [...listed, sing, launch('nstai.nearlytrade.near', 'NSTAI', 'NST AI'), launch('nearly.nearlytrade.near', 'NEARLY', 'Nearly')]
    for (const q of ['nearly', 'NEARLY']) {
      const found = buildResults(q, tokens).filter((r) => r.group === 'Tokens')
      expect(found.map((r) => r.label)).toEqual(['NEARLY', 'SINGULARTY', 'NSTAI'])
      expect(found[0]?.to).toBe('/token/nearly.nearlytrade.near')
    }
    // "near": NEAR itself first, then the symbol that starts with it.
    expect(
      buildResults('near', tokens)
        .filter((r) => r.group === 'Tokens')
        .map((r) => r.label)
        .slice(0, 2),
    ).toEqual(['NEAR', 'NEARLY'])
  })

  it('a token name opens its Token Detail', () => {
    expect(buildResults('tether', listed).find((r) => r.group === 'Tokens')).toMatchObject({ label: 'USDt', to: '/token/usdt.tether-token.near' })
  })

  it('a full contract opens its Token Detail, listed once', () => {
    const results = buildResults('usdt.tether-token.near', listed, { token: listed[1] as TokenListing, note: null, state: 'found' })
    const tokens = results.filter((r) => r.group === 'Tokens')
    expect(tokens).toHaveLength(1)
    expect(tokens[0]?.to).toBe('/token/usdt.tether-token.near')
  })

  it('NEAR opens its own page', () => {
    expect(buildResults('near', listed).find((r) => r.token?.id === 'near')).toMatchObject({ to: '/token/near', detail: 'Native NEAR' })
  })

  it('an empty search suggests tokens that open their pages', () => {
    expect(buildResults('', [...listed, sing]).map((r) => r.to)).toEqual(['/token/usdt.tether-token.near', `/token/${encodeURIComponent(SING)}`])
  })

  it('no result of a token search leads to the swap', () => {
    for (const q of ['', 'usdt', 'tether', 'usdt.tether-token.near', SING]) {
      const results = buildResults(q, [...listed, sing], { token: sing, note: null, state: 'found' })
      expect(results.filter((r) => r.token).every((r) => r.to.startsWith('/token/'))).toBe(true)
      expect(results.some((r) => r.to.startsWith('/swap'))).toBe(false)
    }
  })
})

describe('global search: a contract in no list', () => {
  it('shows the token read from chain (symbol, name, decimals, not in your list) and opens its Token Detail', () => {
    const results = buildResults(SING, listed, { token: sing, note: null, state: 'found' })
    const token = results.find((r) => r.group === 'Tokens')
    expect(token).toMatchObject({ label: 'SINGULARTY', to: `/token/${encodeURIComponent(SING)}`, token: sing })
    expect(String(token?.detail)).toBe('Singularity is NEAR · 18 decimals · not in your list')
    // The scan stays on offer, after the token.
    expect(results.map((r) => r.group)).toEqual(['Tokens', 'Scan'])
  })

  it('while checking, only the scan row says so, and no token is invented', () => {
    expect(buildResults(SING, listed, { token: null, note: 'Checking it on mainnet…', state: 'checking' })).toMatchObject([{ group: 'Scan', detail: 'Checking it on mainnet…' }])
  })

  it('an address that isn’t a token: “Token not found”, with the reason, and its scan', () => {
    const bad = buildResults('someone.near', listed, { token: null, note: 'someone.near is an account without a contract, not a token', state: 'not-found' })
    expect(bad[0]).toMatchObject({ group: 'Tokens', label: 'Token not found', detail: 'someone.near is an account without a contract, not a token', to: '/token/someone.near' })
    expect(bad[0]?.token).toBeUndefined()
    expect(bad.map((r) => r.group)).toEqual(['Tokens', 'Scan'])
  })
})
