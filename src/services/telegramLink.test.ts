import { describe, expect, it } from 'vitest'
import { confirmLink, describeLink, LinkRequestError, readHandoffId, readLinkCode, readRecoverCode } from './telegramLink'

const code = 'Abc_DEF-123456789012345'

describe('link code from the page URL', () => {
  it('reads the code from the fragment only when it is well formed', () => {
    expect(readLinkCode(`#link=${code}`)).toBe(code)
    expect(readLinkCode('#link=short')).toBeNull()
    expect(readLinkCode(`#link=${code}<script>`)).toBeNull()
    expect(readLinkCode('')).toBeNull()
    expect(readLinkCode(`#other=${code}`)).toBeNull()
  })
})

describe('trade handoff IDs', () => {
  it('accepts only well-formed IDs from the swap link', () => {
    expect(readHandoffId(code)).toBe(code)
    expect(readHandoffId('short')).toBeNull()
    expect(readHandoffId(null)).toBeNull()
    expect(readHandoffId(`${code}/../x`)).toBeNull()
  })
})

describe('NearKit API calls', () => {
  const fetchReturning = (status: number, body: unknown) =>
    (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as unknown })
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
  let calls: { url: string; body: unknown }[] = []

  it('posts JSON to the configured API and returns the answer', async () => {
    calls = []
    const described = { telegram: { name: 'Alice', username: 'alice' }, network: 'testnet', recipient: 'nearkit.vercel.app', message: 'm', nonce: 'n', expiresAt: 1 }
    expect(await describeLink('http://localhost:8787', code, fetchReturning(200, described))).toEqual(described)
    expect(calls[0]).toEqual({ url: 'http://localhost:8787/api/link/describe', body: { code } })
  })

  it('turns API errors into readable failures with their code', async () => {
    const error = await confirmLink(
      'http://localhost:8787',
      { code, accountId: 'a.testnet', publicKey: 'k', signature: 's' },
      fetchReturning(403, { error: { code: 'function-call-key', message: 'Use a full-access key' } }),
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LinkRequestError)
    expect(error).toMatchObject({ status: 403, code: 'function-call-key', message: 'Use a full-access key' })
  })

  it('says the server is unreachable when fetch fails', async () => {
    const error = await describeLink('http://localhost:8787', code, (async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof fetch).catch((e: unknown) => e)
    expect(error).toMatchObject({ status: 0, code: 'unreachable' })
  })
})

describe('export links from before /recover', () => {
  it('are recognized (to send the user to /recover), and never read as a link code', () => {
    expect(readRecoverCode(`#recover=${code}`)).toBe(code)
    expect(readRecoverCode(`#link=${code}`)).toBeNull()
    expect(readRecoverCode('#recover=short')).toBeNull()
    expect(readLinkCode(`#recover=${code}`)).toBeNull()
  })
})
