import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SocialLinks } from '@/components/brand/Social'
import { SOCIAL } from '@/config/social'
import { createBridgeClient, newRequestKey, reviewKey } from './bridge'

/**
 * The bridge client's identity and keys. On NEARKITS web a request names the user with the web
 * session; in Telegram's Mini App with the launch data Telegram signed (and never both: the server
 * checks the one it gets). A start carries the review's request key, so asking again finds the same
 * order. And the community links every page shows: the two official accounts, named in words.
 */

function recorder() {
  const sent: { path: string; body: Record<string, unknown> }[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    return new Response(JSON.stringify({ wallets: [{ id: 'w1', accountId: 'a.near', name: 'Main', slot: 1, frozen: false }] }), { status: 200 })
  }) as typeof globalThis.fetch
  return { sent, fetch }
}

describe('the bridge client names the user once, the way the page has', () => {
  it('in the Mini App: Telegram’s launch data, and no web session even if one is stored', async () => {
    const r = recorder()
    const client = createBridgeClient({ apiUrl: 'https://api.test', fetch: r.fetch, session: () => 'web-session-token', telegram: () => 'auth_date=1&signature=x' })
    expect(await client.wallets()).toEqual([{ id: 'w1', accountId: 'a.near', name: 'Main', slot: 1, frozen: false }])
    expect(r.sent[0]).toEqual({ path: '/api/bridge/wallets', body: { telegram: 'auth_date=1&signature=x' } })
  })

  it('on the web: the session, as before', async () => {
    const r = recorder()
    const client = createBridgeClient({ apiUrl: 'https://api.test', fetch: r.fetch, session: () => 'web-session-token' })
    await client.orders().catch(() => undefined)
    expect(r.sent[0]?.body).toEqual({ session: 'web-session-token' })
  })

  it('a start carries its review’s request key; without one, nothing extra is sent', async () => {
    const r = recorder()
    const client = createBridgeClient({ apiUrl: 'https://api.test', fetch: r.fetch, session: () => null })
    const req = { product: 'bridge' as const, chain: 'sol' as const, amount: '1', sourceAddress: 'So1', destination: { kind: 'nearkits' as const, walletId: 'w1' } }
    await client.start(req, 'key-0123456789abcdef').catch(() => undefined)
    await client.start(req).catch(() => undefined)
    expect(r.sent[0]?.body).toEqual({ ...req, requestKey: 'key-0123456789abcdef' })
    expect(r.sent[1]?.body).not.toHaveProperty('requestKey')
  })

  it('a review’s key: the same for the same request sent again (a retry after a lost answer), a new one for any other', () => {
    const req = { chain: 'sol' as const, amount: '1', sourceAddress: 'So1', destination: { kind: 'nearkits' as const, walletId: 'w1' }, kitsSlippagePct: 1 }
    const first = reviewKey(null, req)
    expect(first.key).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
    expect(reviewKey(first, { ...req }).key).toBe(first.key)
    expect(reviewKey(first, { ...req, amount: '2' }).key).not.toBe(first.key)
    expect(reviewKey(first, { ...req, kitsSlippagePct: 2 }).key).not.toBe(first.key)
    // After its order was made the form forgets it: the next start is a new review.
    expect(reviewKey(null, req).key).not.toBe(first.key)
  })

  it('request keys are random, URL-safe and of the length the server takes (16–64)', () => {
    const keys = new Set(Array.from({ length: 50 }, () => newRequestKey()))
    expect(keys.size).toBe(50)
    for (const k of keys) expect(k).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
  })
})

describe('the community links', () => {
  it('link exactly the two official accounts, each named in words, in a new tab, with no referrer', () => {
    for (const variant of ['nav', 'inline'] as const) {
      const html = renderToStaticMarkup(createElement(SocialLinks, { variant }))
      expect(html).toContain('href="https://t.me/NearKitsCommunity"')
      expect(html).toContain('href="https://x.com/Near_Kits"')
      expect(html).toContain(`aria-label="${SOCIAL.telegram.label}"`)
      expect(html).toContain(`aria-label="${SOCIAL.x.label}"`)
      expect(html.match(/<a /g)).toHaveLength(2)
      expect(html.match(/target="_blank" rel="noopener noreferrer"/g)).toHaveLength(2)
    }
  })
})
