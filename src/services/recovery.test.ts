import { describe, expect, it } from 'vitest'
import { createExportKeyPair, exportKeyFingerprint } from '@/lib/exportCrypto'
import { challengeProblem, exportSealedKey, readRecoverHash, type OwnerChallenge } from './recovery'
import { LinkRequestError } from './telegramLink'

const WALLET = 'a'.repeat(64)

function challenge(over: Partial<OwnerChallenge> & { lines: string[] }): OwnerChallenge {
  const { lines, ...rest } = over
  return {
    id: 'req1',
    kind: 'export',
    nonce: 'n',
    recipient: 'nearkit.vercel.app',
    expiresAt: 0,
    ownerAccount: 'alice.testnet',
    accountId: WALLET,
    destination: null,
    message: ['NearKit: export the private key of my NearKit wallet', ...lines, '', 'footer'].join('\n'),
    ...rest,
  }
}

describe('the recovery page’s address', () => {
  it('reads the wallet to export or the destination to approve; anything else lists the owner’s wallets', () => {
    expect(readRecoverHash(`#wallet=${WALLET}`)).toEqual({ kind: 'export', wallet: WALLET })
    expect(readRecoverHash(`#approve=${WALLET}&to=bob.testnet`)).toEqual({ kind: 'approve', wallet: WALLET, destination: 'bob.testnet' })
    expect(readRecoverHash(`#approve=${WALLET}&to=${encodeURIComponent('bob.testnet')}`)).toEqual({ kind: 'approve', wallet: WALLET, destination: 'bob.testnet' })
    for (const bad of [
      '',
      '#',
      '#wallet=',
      `#wallet=${WALLET}&x=1`,
      '#wallet=Bad Account',
      `#approve=${WALLET}&to=%E0%A4%A`,
      `#approve=${WALLET}&to=bad%20account`,
      '#recover=abc',
    ])
      expect(readRecoverHash(bad)).toEqual({ kind: 'list' })
  })
})

describe('checking a request before the wallet signs it', () => {
  it('accepts a request that says exactly what the user is doing, and nothing else', async () => {
    const browser = await createExportKeyPair()
    const fp = await exportKeyFingerprint(browser.publicKey)
    const good = challenge({ lines: [`NearKit wallet: ${WALLET}`, `Browser key: ${fp}`, 'Owner wallet: alice.testnet', 'Network: testnet', 'Request: req1'] })
    const want = { kind: 'export' as const, network: 'testnet', recipient: 'nearkit.vercel.app', wallet: WALLET, recipientKey: browser.publicKey }
    expect(await challengeProblem(good, want)).toBeNull()
    const other = await createExportKeyPair()
    expect(await challengeProblem(good, { ...want, recipientKey: other.publicKey })).toMatch(/another browser/)
    expect(await challengeProblem(good, { ...want, wallet: 'b'.repeat(64) })).toMatch(/another NearKit wallet/)
    expect(await challengeProblem(good, { ...want, network: 'mainnet' })).toMatch(/runs on mainnet/)
    expect(await challengeProblem({ ...good, recipient: 'evil.example' }, want)).toMatch(/another site/)
    expect(await challengeProblem(good, { ...want, kind: 'approve-destination' })).toMatch(/different kind/)
    expect(await challengeProblem({ ...good, id: 'req2' }, want)).toMatch(/malformed/)
  })
})

describe('export over the API', () => {
  it('passes the server’s refusal through as a readable error', async () => {
    const calls: { url: string; body: unknown }[] = []
    const refuse = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ error: { code: 'used', message: 'This request was already used. Start again.' } }), { status: 409 })
    }) as typeof fetch
    const body = { challengeId: 'req1', publicKey: 'ed25519:K', signature: 'sig' }
    const error = await exportSealedKey('https://api.test', body, refuse).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LinkRequestError)
    expect(error).toMatchObject({ status: 409, code: 'used', message: 'This request was already used. Start again.' })
    expect(calls).toEqual([{ url: 'https://api.test/api/recovery/export', body }])
  })
})
