import { describe, expect, it } from 'vitest'
import { rankTokens } from './tokenSearch'

/** Tokens in the order a list hands them over: launches whose contracts contain "nearly" come first. */
const TOKENS = [
  { id: 'near', symbol: 'NEAR', name: 'NEAR', contract: null },
  { id: 'singularty.nearlytrade.near', symbol: 'SINGULARTY', name: 'Singularity', contract: 'singularty.nearlytrade.near' },
  { id: 'nstai.nearlytrade.near', symbol: 'NSTAI', name: 'NST AI', contract: 'nstai.nearlytrade.near' },
  { id: 'wrap.near', symbol: 'wNEAR', name: 'Wrapped NEAR fungible token', contract: 'wrap.near' },
  { id: 'nearly.nearlytrade.near', symbol: 'NEARLY', name: 'Nearly', contract: 'nearly.nearlytrade.near' },
  { id: 'blackdragon.tkn.near', symbol: 'BLACKDRAGON', name: 'Black Dragon', contract: 'blackdragon.tkn.near' },
  { id: 'nearkat.tkn.near', symbol: 'KAT', name: 'NearKat', contract: 'nearkat.tkn.near' },
]
const symbols = (q: string) => rankTokens(TOKENS, q).map((t) => t.symbol)

describe('token search ranking', () => {
  it('"nearly" and "NEARLY": the NEARLY token first, then the launches whose contract merely contains it', () => {
    expect(symbols('nearly')[0]).toBe('NEARLY')
    expect(symbols('NEARLY')[0]).toBe('NEARLY')
    expect(symbols(' Nearly ')).toEqual(['NEARLY', 'SINGULARTY', 'NSTAI'])
  })

  it('exact symbol, exact name, symbol prefix, name prefix, any substring, then a contract match', () => {
    // "near": NEAR's symbol exactly; NEARLY's symbol starts with it; NearKat's name starts with it;
    // wNEAR has it inside; the launches only in their contracts.
    expect(symbols('near')).toEqual(['NEAR', 'NEARLY', 'KAT', 'wNEAR', 'SINGULARTY', 'NSTAI', 'BLACKDRAGON'])
    // An exact name beats a symbol prefix.
    expect(symbols('black dragon')).toEqual(['BLACKDRAGON'])
    expect(symbols('singularity')[0]).toBe('SINGULARTY')
  })

  it('a full contract finds exactly that token first', () => {
    expect(symbols('nstai.nearlytrade.near')).toEqual(['NSTAI'])
    expect(symbols('WRAP.NEAR')[0]).toBe('wNEAR')
  })

  it('an empty query keeps the list as it is; no match is an empty list', () => {
    expect(symbols('  ')).toEqual(TOKENS.map((t) => t.symbol))
    expect(symbols('zzz')).toEqual([])
  })
})
