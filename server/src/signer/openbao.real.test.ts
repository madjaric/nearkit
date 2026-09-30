import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { KeyUnavailableError } from '../custody/vault'
import { kmsKeyWrapper, probeKek } from './kms'
import { openBaoTransitApi } from './openbao'

/**
 * Against a real OpenBao (NEARKIT_TEST_OPENBAO_ADDR, with a root token of that test server
 * in NEARKIT_TEST_OPENBAO_TOKEN), e.g. a local dev server:
 *
 *   docker run -d -p 127.0.0.1:18200:8200 quay.io/openbao/openbao:2.6.3 \
 *     server -dev -dev-listen-address=0.0.0.0:8200 -dev-root-token-id=<test token>
 *
 * It sets up transit the way production does (openbao-init), then checks that the signer's
 * token can wrap and open only as intended, and do nothing else.
 */
const ADDR = process.env.NEARKIT_TEST_OPENBAO_ADDR
const ROOT = process.env.NEARKIT_TEST_OPENBAO_TOKEN

async function bao(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${ADDR}/v1/${path}`, {
    method,
    headers: { 'x-vault-token': token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
}

describe.skipIf(!ADDR || !ROOT)('OpenBao transit, for real', { timeout: 60_000 }, () => {
  it('wallet data keys open only for their wallet, with a token that can do nothing else', async () => {
    const root = ROOT as string
    const key = `nearkit-wallets-${randomBytes(4).toString('hex')}`
    // What openbao-init does in production.
    const mounts = await bao('GET', 'sys/mounts', root)
    if (!('transit/' in (mounts.json.data as Record<string, unknown>))) expect((await bao('POST', 'sys/mounts/transit', root, { type: 'transit' })).status).toBe(204)
    expect((await bao('POST', `transit/keys/${key}`, root, { type: 'aes256-gcm96', derived: true, exportable: false, allow_plaintext_backup: false })).status).toBeLessThan(300)
    const policy = `path "transit/encrypt/${key}" { capabilities = ["update"] }\npath "transit/decrypt/${key}" { capabilities = ["update"] }\npath "auth/token/renew-self" { capabilities = ["update"] }\npath "auth/token/lookup-self" { capabilities = ["read"] }\n`
    expect((await bao('PUT', `sys/policies/acl/${key}`, root, { policy })).status).toBe(204)
    const made = await bao('POST', 'auth/token/create-orphan', root, { policies: [key], period: '768h', display_name: 'nearkit-signer', no_default_policy: true })
    const token = (made.json.auth as { client_token: string }).client_token

    const api = openBaoTransitApi({ addr: ADDR as string, mount: 'transit', key, token, tlsPin: null })
    const wrapper = kmsKeyWrapper(api)
    expect(await probeKek(wrapper)).toBe('ok')
    const dek = randomBytes(32)
    const aad = 'nearkit:wallet:v2|mainnet|abc|owner:alice.near'
    const wrapped = await wrapper.wrap(dek, aad)
    expect(Buffer.from(wrapped, 'base64').toString()).toMatch(/^vault:v1:/)
    expect((await wrapper.unwrap(wrapped, aad)).equals(dek)).toBe(true)
    // Another wallet's context, or a tampered ciphertext: refused, never another key.
    await expect(wrapper.unwrap(wrapped, 'nearkit:wallet:v2|mainnet|abc|owner:mallory.near')).rejects.toBeInstanceOf(KeyUnavailableError)
    const text = Buffer.from(wrapped, 'base64').toString()
    const flipped = text.slice(0, -4) + (text.at(-4) === 'A' ? 'B' : 'A') + text.slice(-3)
    await expect(wrapper.unwrap(Buffer.from(flipped).toString('base64'), aad)).rejects.toBeInstanceOf(KeyUnavailableError)
    expect(await api.renewToken()).toBeGreaterThan(0)

    // The signer's token can't read, export, rotate, reconfigure, back up or delete the key, nor make another.
    for (const [method, path, body] of [
      ['GET', `transit/keys/${key}`, undefined],
      ['GET', `transit/export/encryption-key/${key}`, undefined],
      ['GET', `transit/backup/${key}`, undefined],
      ['POST', `transit/keys/${key}/rotate`, {}],
      ['POST', `transit/keys/${key}/config`, { deletion_allowed: true }],
      ['DELETE', `transit/keys/${key}`, undefined],
      ['POST', 'transit/keys/another', {}],
      ['POST', `transit/datakey/plaintext/${key}`, { context: 'eA==' }],
      ['GET', 'sys/mounts', undefined],
    ] as const)
      expect((await bao(method, path, token, body)).status, `${method} ${path}`).toBe(403)
    // And the key itself is not exportable, whoever asks.
    expect((await bao('GET', `transit/export/encryption-key/${key}`, root)).status).toBe(400)
  })
})
