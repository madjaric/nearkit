import { describe, expect, it } from 'vitest'
import { NETWORKS } from './networks'
import { parseEnv } from './env'

describe('parseEnv', () => {
  it('defaults to the real services on testnet with mainnet execution off', () => {
    const { env, issues } = parseEnv({})
    expect(issues).toEqual([])
    expect(env).toEqual({ services: 'near', network: 'testnet', rpcUrls: null, mainnetExecution: false, feeRecipient: null, kitContract: null })
  })

  it('enables mainnet execution only for the exact string "true"', () => {
    expect(parseEnv({ VITE_ENABLE_MAINNET_EXECUTION: 'true' }).env.mainnetExecution).toBe(true)
    expect(parseEnv({ VITE_ENABLE_MAINNET_EXECUTION: 'false' }).env.mainnetExecution).toBe(false)
    const fuzzy = parseEnv({ VITE_ENABLE_MAINNET_EXECUTION: 'yes' })
    expect(fuzzy.env.mainnetExecution).toBe(false)
    expect(fuzzy.issues[0]?.key).toBe('VITE_ENABLE_MAINNET_EXECUTION')
  })

  it('rejects unknown networks and service modes instead of guessing', () => {
    const { issues } = parseEnv({ VITE_NEAR_NETWORK: 'Mainnet', VITE_NEARKIT_SERVICES: 'mock' })
    expect(issues.map((i) => i.key).sort()).toEqual(['VITE_NEARKIT_SERVICES', 'VITE_NEAR_NETWORK'])
  })

  it('accepts https RPC overrides in order and refuses plain http outside localhost', () => {
    expect(parseEnv({ VITE_NEAR_RPC_URL: 'https://a.example/, https://b.example' }).env.rpcUrls).toEqual(['https://a.example', 'https://b.example'])
    expect(parseEnv({ VITE_NEAR_RPC_URL: 'http://localhost:3030' }).env.rpcUrls).toEqual(['http://localhost:3030'])
    const bad = parseEnv({ VITE_NEAR_RPC_URL: 'http://rpc.example' })
    expect(bad.env.rpcUrls).toBeNull()
    expect(bad.issues[0]?.key).toBe('VITE_NEAR_RPC_URL')
  })

  it('validates the fee recipient and refuses an account from the other network', () => {
    expect(parseEnv({ VITE_NEAR_NETWORK: 'mainnet', VITE_NEARKIT_FEE_RECIPIENT: 'fees.nearkit.near' }).env.feeRecipient).toBe('fees.nearkit.near')
    const cross = parseEnv({ VITE_NEAR_NETWORK: 'mainnet', VITE_NEARKIT_FEE_RECIPIENT: 'fees.testnet' })
    expect(cross.env.feeRecipient).toBeNull()
    expect(cross.issues[0]?.message).toMatch(/belongs to testnet/)
    const invalid = parseEnv({ VITE_NEARKIT_FEE_RECIPIENT: 'Fees.Near' })
    expect(invalid.env.feeRecipient).toBeNull()
    expect(invalid.issues[0]?.key).toBe('VITE_NEARKIT_FEE_RECIPIENT')
  })

  it('keeps $KIT unset until a contract is configured', () => {
    expect(parseEnv({}).env.kitContract).toBeNull()
    expect(parseEnv({ VITE_NEAR_NETWORK: 'testnet', VITE_KIT_TOKEN_CONTRACT: 'kit.nearly.testnet' }).env.kitContract).toBe('kit.nearly.testnet')
  })
})

describe('network configuration', () => {
  it('never mixes networks: every endpoint and contract belongs to its own network', () => {
    for (const url of NETWORKS.mainnet.rpcUrls) expect(url).not.toMatch(/test/)
    for (const url of NETWORKS.testnet.rpcUrls) expect(url).toMatch(/test/)
    expect(NETWORKS.mainnet.explorerUrl).toBe('https://nearblocks.io')
    expect(NETWORKS.testnet.explorerUrl).toBe('https://testnet.nearblocks.io')
    expect(NETWORKS.mainnet.wrapContract).toBe('wrap.near')
    expect(NETWORKS.testnet.wrapContract).toBe('wrap.testnet')
    for (const id of NETWORKS.testnet.knownTokens) expect(id.endsWith('.near')).toBe(false)
    for (const id of NETWORKS.mainnet.knownTokens) expect(id.endsWith('.testnet')).toBe(false)
    expect(NETWORKS.testnet.rhea.aggregator).toBeNull()
    expect(NETWORKS.testnet.nearUsd).toBeNull()
  })

  it('is frozen so nothing can rewrite an endpoint at runtime', () => {
    expect(Object.isFrozen(NETWORKS.mainnet)).toBe(true)
    expect(Object.isFrozen(NETWORKS.mainnet.rpcUrls)).toBe(true)
    expect(Object.isFrozen(NETWORKS.testnet.rhea)).toBe(true)
  })
})
