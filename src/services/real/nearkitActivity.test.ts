import { describe, expect, it } from 'vitest'
import { parseEnv } from '@/config/env'
import { NETWORKS } from '@/config/networks'
import type { NearKitActivity, NearKitWeb, NearKitWebSession } from '../nearkitWeb'
import { LinkRequestError } from '../telegramLink'
import { createNearServices } from './index'
import { memoryStorage } from './stores'
import { createFakeChain, fakeWallet } from './testing/fakeChain'

/**
 * Recent activity is one history: what this browser's wallet sent, and what the user's NEARKITS
 * wallets ran wherever it was confirmed (Telegram, NEARKITS web, the Volume Bot), as the server lists it.
 */

const NK = 'a'.repeat(64)
const T0 = Date.UTC(2026, 9, 12, 12)

const BUY: NearKitActivity = { id: 'i-buy', kind: 'buy', status: 'success', accountId: NK, title: 'Buy KITS', detail: '0.5 NEAR', hashes: ['HASH1'], at: T0 - 60_000 }
const SEND: NearKitActivity = {
  id: 'i-send',
  kind: 'withdraw',
  status: 'failed',
  accountId: NK,
  title: 'Send NEAR',
  detail: '1.25 NEAR to bob.near · The transfer failed on chain.',
  hashes: [],
  at: T0 - 5_000,
}

function setup(opts: { web: boolean; server: 'up' | 'down' }) {
  const chain = createFakeChain({ accounts: { [NK]: { amount: 10n ** 24n } } })
  const { env } = parseEnv({ VITE_NEAR_NETWORK: 'mainnet', VITE_NEARKIT_FEE_RECIPIENT: 'fees.example.near' })
  const session = (): NearKitWebSession | null => (opts.web ? { token: 'T'.repeat(43), expiresAt: T0 + 3_600_000, userName: 'Tess', userHandle: 'tess' } : null)
  let asked = 0
  const nearkit = {
    available: true,
    session,
    ended: () => null,
    wallets: async () => (session() ? { wallets: [], limit: 10, canCreate: true } : null),
    activity: async () => {
      asked++
      if (!session()) return null
      if (opts.server === 'down') throw new LinkRequestError(0, 'unreachable', 'The NEARKITS server can’t be reached right now. Try again in a moment.')
      return [SEND, BUY]
    },
    subscribe: () => () => undefined,
  } as unknown as NearKitWeb
  const services = createNearServices({
    env,
    network: NETWORKS.mainnet,
    fetch: chain.fetch,
    kv: memoryStorage(),
    wallet: async () => fakeWallet(null).adapter,
    nearkit,
    now: () => T0,
  })
  return { services, asked: () => asked }
}

describe('recent activity with NEARKITS wallets', () => {
  it('lists what the NEARKITS wallets ran, newest first, as real operations with their status and transactions', async () => {
    const { services } = setup({ web: true, server: 'up' })
    const items = await services.portfolio.listActivity(10)
    expect(items.map((i) => [i.id, i.kind, i.status, i.title, i.detail, i.origin, i.accountId])).toEqual([
      ['nearkit:i-send', 'send', 'failed', 'Send NEAR', '1.25 NEAR to bob.near · The transfer failed on chain.', 'nearkit', NK],
      ['nearkit:i-buy', 'swap', 'success', 'Buy KITS', '0.5 NEAR', 'nearkit', NK],
    ])
    expect(items[1]?.txHashes).toEqual(['HASH1'])
    expect(items[1]?.explorerUrl).toMatch(/HASH1/)
    expect(await services.portfolio.listActivity(1)).toHaveLength(1)
  })

  it('signed out of NEARKITS web: only this browser’s own records, and the server isn’t asked', async () => {
    const { services, asked } = setup({ web: false, server: 'up' })
    expect(await services.portfolio.listActivity(10)).toEqual([])
    expect(asked()).toBe(0)
  })

  it('the server unreachable: this browser’s records still show; nothing is invented', async () => {
    const { services } = setup({ web: true, server: 'down' })
    expect(await services.portfolio.listActivity(10)).toEqual([])
  })
})
