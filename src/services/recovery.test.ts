import { describe, expect, it } from 'vitest'
import { createExportKeyPair, exportKeyFingerprint } from '@/lib/exportCrypto'
import { cancelExport, challengeProblem, collectExport, exportStatus, readRecoverHash, requestExport, type OwnerChallenge } from './recovery'
import { LinkRequestError } from './telegramLink'

const WALLET = 'a'.repeat(64)
/** The two lines an export request states its hold with (NEARKITS' signer writes them). */
const HOLD = ['Held until: 2026-10-08T12:05:00.000Z', 'Collect by: 2026-10-09T12:05:00.000Z']

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
    const good = challenge({ lines: [`NearKit wallet: ${WALLET}`, `Browser key: ${fp}`, 'Owner wallet: alice.testnet', 'Network: testnet', 'Request: req1', ...HOLD] })
    const want = { kind: 'export' as const, network: 'testnet', recipient: 'nearkit.vercel.app', wallet: WALLET, recipientKey: browser.publicKey }
    expect(await challengeProblem(good, want)).toBeNull()
    const other = await createExportKeyPair()
    expect(await challengeProblem(good, { ...want, recipientKey: other.publicKey })).toMatch(/another browser/)
    expect(await challengeProblem(good, { ...want, wallet: 'b'.repeat(64) })).toMatch(/another NEARKITS wallet/)
    expect(await challengeProblem(good, { ...want, network: 'mainnet' })).toMatch(/runs on mainnet/)
    expect(await challengeProblem({ ...good, recipient: 'evil.example' }, want)).toMatch(/another site/)
    expect(await challengeProblem(good, { ...want, kind: 'approve-destination' })).toMatch(/different kind/)
    expect(await challengeProblem({ ...good, id: 'req2' }, want)).toMatch(/malformed/)
  })
})

describe('an export request must say NEARKITS holds it (AUTH-05)', () => {
  const lines = async () => {
    const browser = await createExportKeyPair()
    const fp = await exportKeyFingerprint(browser.publicKey)
    const want = { kind: 'export' as const, network: 'testnet', recipient: 'nearkit.vercel.app', wallet: WALLET, recipientKey: browser.publicKey }
    return { want, base: [`NearKit wallet: ${WALLET}`, `Browser key: ${fp}`, 'Owner wallet: alice.testnet', 'Network: testnet', 'Request: req1'] }
  }

  it('refuses one that doesn’t say how long the export is held: a server that would release it at once gets no signature', async () => {
    const { want, base } = await lines()
    expect(await challengeProblem(challenge({ lines: base }), want)).toMatch(/how long NEARKITS holds/)
    expect(await challengeProblem(challenge({ lines: [...base, HOLD[0] as string] }), want)).toMatch(/how long NEARKITS holds/)
    expect(await challengeProblem(challenge({ lines: [...base, ...HOLD] }), want)).toBeNull()
  })

  it('refuses times that make no sense: held until before the request expires, or collected before it is released', async () => {
    const { want, base } = await lines()
    const at = (iso: string) => challenge({ lines: [...base, `Held until: ${iso}`, 'Collect by: 2026-10-09T00:00:00.000Z'], expiresAt: Date.parse('2026-10-07T12:00:00.000Z') })
    expect(await challengeProblem(at('2026-10-07T11:59:00.000Z'), want)).toMatch(/how long NEARKITS holds/)
    expect(await challengeProblem(at('2026-10-09T01:00:00.000Z'), want)).toMatch(/how long NEARKITS holds/)
    expect(await challengeProblem(at('not a time'), want)).toMatch(/how long NEARKITS holds/)
    expect(await challengeProblem(at('2026-10-08T12:00:00.000Z'), want)).toBeNull()
  })
})

describe('export over the API', () => {
  const recorder = (status: number, json: unknown) => {
    const calls: { url: string; body: unknown }[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify(json), { status })
    }) as typeof fetch
    return { calls, fetchImpl }
  }

  it('passes the server’s refusal through as a readable error', async () => {
    const { calls, fetchImpl } = recorder(409, { error: { code: 'used', message: 'This request was already used. Start again.' } })
    const body = { challengeId: 'req1', publicKey: 'ed25519:K', signature: 'sig' }
    const error = await requestExport('https://api.test', body, fetchImpl).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LinkRequestError)
    expect(error).toMatchObject({ status: 409, code: 'used', message: 'This request was already used. Start again.' })
    expect(calls).toEqual([{ url: 'https://api.test/api/recovery/export', body }])
  })

  it('a held export is asked about, collected and cancelled by its ID only', async () => {
    const { calls, fetchImpl } = recorder(200, { exportId: 'req1', status: 'held' })
    await exportStatus('https://api.test', 'req1', fetchImpl)
    await collectExport('https://api.test', 'req1', fetchImpl)
    await cancelExport('https://api.test', 'req1', fetchImpl)
    expect(calls).toEqual([
      { url: 'https://api.test/api/recovery/export/status', body: { exportId: 'req1' } },
      { url: 'https://api.test/api/recovery/export/collect', body: { exportId: 'req1' } },
      { url: 'https://api.test/api/recovery/export/cancel', body: { exportId: 'req1' } },
    ])
  })
})
