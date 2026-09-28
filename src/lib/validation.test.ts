import { describe, expect, it } from 'vitest'
import { accountIdError, accountKind, accountNetworkHint, isForeignToNetwork, isValidAccountId } from './validation'

describe('NEAR account validation', () => {
  it.each(['alice.near', 'bob-01.near', 'a_b.c-d.near', 'near', 'app.alice.near', 'kit.tg'])('accepts %s', (id) => {
    expect(isValidAccountId(id)).toBe(true)
  })

  it.each(['a', 'Alice.near', 'alice..near', '.alice.near', 'alice.near.', 'al ice.near', 'alice@near', `${'a'.repeat(65)}`])('rejects %s', (id) => {
    expect(isValidAccountId(id)).toBe(false)
  })

  it('detects account kinds', () => {
    expect(accountKind('f'.repeat(64))).toBe('implicit')
    expect(accountKind(`0x${'1'.repeat(40)}`)).toBe('eth-implicit')
    expect(accountKind(`0s${'a'.repeat(40)}`)).toBe('deterministic')
    expect(accountKind(`0u${'z'.repeat(52)}`)).toBe('universal')
    expect(accountKind('alice.near')).toBe('named')
    expect(accountKind('F'.repeat(64))).toBeNull()
  })

  it('reads the network from a named account suffix only', () => {
    expect(accountNetworkHint('alice.near')).toBe('mainnet')
    expect(accountNetworkHint('alice.testnet')).toBe('testnet')
    expect(accountNetworkHint('intents.tg')).toBeNull()
    expect(accountNetworkHint('f'.repeat(64))).toBeNull()
    expect(isForeignToNetwork('alice.testnet', 'mainnet')).toBe(true)
    expect(isForeignToNetwork('alice.near', 'mainnet')).toBe(false)
    expect(isForeignToNetwork('f'.repeat(64), 'testnet')).toBe(false)
  })

  it('explains the problem', () => {
    expect(accountIdError('')).toBe('Enter a NEAR account')
    expect(accountIdError('Bob.near')).toBe('Account IDs are lowercase')
    expect(accountIdError('bob near')).toBe('Account IDs cannot contain spaces')
    expect(accountIdError('b')).toBe('Too short: at least 2 characters')
    expect(accountIdError('bob$.near')).toBe('Only a–z, 0–9 and - _ . are allowed')
    expect(accountIdError('bob..near')).toBe('Not a valid NEAR account ID')
    expect(accountIdError('bob.near')).toBeNull()
  })
})
