import { describe, expect, it } from 'vitest'
import { parseEnv } from '@/config/env'
import { NETWORKS } from '@/config/networks'
import { PRODUCTION_FEE_RECIPIENT } from '@/lib/fees'
import { createNearContext } from './context'
import { memoryStorage } from './stores'

const trading = (network: 'mainnet' | 'testnet', recipient?: string) => {
  const { env } = parseEnv({
    VITE_NEARKIT_SERVICES: 'near',
    VITE_NEAR_NETWORK: network,
    VITE_ENABLE_MAINNET_EXECUTION: 'true',
    ...(recipient ? { VITE_NEARKIT_FEE_RECIPIENT: recipient } : {}),
  })
  const ctx = createNearContext({ env, network: NETWORKS[network], kv: memoryStorage(), fetch: (async () => new Response('{}')) as typeof fetch })
  return { trading: ctx.capabilities.execution.trading, execution: ctx.capabilities.execution, policy: ctx.policy }
}

describe('the NEARKITS fee account in the web app', () => {
  it('mainnet trades only with the production account; transfers work either way', () => {
    const ok = trading('mainnet', PRODUCTION_FEE_RECIPIENT)
    expect(ok.trading).toMatchObject({ enabled: true, reason: null, feeCharged: true, feeRecipient: PRODUCTION_FEE_RECIPIENT })
    expect(ok.policy.feeRecipient).toBe(PRODUCTION_FEE_RECIPIENT)
    for (const [recipient, why] of [
      [undefined, /not configured \(it must be nearkitfee\.near\)/],
      ['testone.near', /testone\.near is a test account/],
      ['someone.near', /must be nearkitfee\.near, not someone\.near/],
    ] as const) {
      const t = trading('mainnet', recipient)
      expect(t.trading.enabled).toBe(false)
      expect(t.trading.reason).toMatch(why)
      expect(t.trading.reason).toContain('Transfers still work')
      expect(t.policy.feeRecipient).toBeNull()
      expect(t.execution.enabled).toBe(true)
    }
  })

  it('testnet charges no fee and needs no account', () => {
    expect(trading('testnet').trading).toMatchObject({ enabled: true, feeCharged: false, feeRecipient: null })
  })
})
