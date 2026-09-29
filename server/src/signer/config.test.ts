import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { keyring, localKeyWrapper, parseSealed } from '../custody/vault'
import { openDatabase } from '../db/open'
import { runAdmin } from './admin'
import { loadSignerConfig } from './config'
import { openWalletKey } from './envelope'
import { buildSigner } from './service'
import { SignerStore } from './store'
import { TEST_OWNER_KEY } from './testing'

const AUTH = randomBytes(32).toString('base64')
const ARN = 'arn:aws:kms:eu-central-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab'
const PG = 'postgres://signer:secret@signer-db.internal:5432/signer'

const mainnet = {
  NEAR_NETWORK: 'mainnet',
  NEARKIT_MAINNET_CUSTODY: 'enabled',
  NEARKIT_SIGNER_AUTH_KEY: AUTH,
  NEARKIT_KMS_KEY_ARN: ARN,
  NEARKIT_SIGNER_DATABASE_URL: PG,
  NEARKIT_SIGNER_RECIPIENT: 'nearkit.vercel.app',
  NEARKIT_FEE_RECIPIENT: 'nearkitfee.near',
  NEARKIT_SIGNER_TLS_CERT: 'cert.pem',
  NEARKIT_SIGNER_TLS_KEY: 'key.pem',
  NEARKIT_SIGNER_HOST: '10.0.0.5',
}
const keys = (env: Record<string, string | undefined>) =>
  loadSignerConfig(env)
    .issues.map((i) => i.key)
    .sort()

describe('the signer’s configuration fails closed', () => {
  it('mainnet: everything production needs, and then it starts', () => {
    const { config, issues } = loadSignerConfig(mainnet)
    expect(issues).toEqual([])
    expect(config).toMatchObject({ kek: { kind: 'kms', current: ARN }, feeRecipient: 'nearkitfee.near', rpc: { quorum: 2 }, database: { kind: 'postgres' } })
  })

  it('mainnet without the owner’s switch, a KMS key, PostgreSQL, TLS or the production fee account does not start', () => {
    expect(keys({ ...mainnet, NEARKIT_MAINNET_CUSTODY: undefined })).toEqual(['NEARKIT_MAINNET_CUSTODY'])
    expect(keys({ ...mainnet, NEARKIT_KMS_KEY_ARN: undefined })).toEqual(['NEARKIT_KMS_KEY_ARN'])
    expect(keys({ ...mainnet, NEARKIT_KMS_KEY_ARN: undefined, NEARKIT_SIGNER_KEK: randomBytes(32).toString('base64') })).toEqual(['NEARKIT_SIGNER_KEK'])
    expect(keys({ ...mainnet, NEARKIT_KMS_KEY_ARN: 'arn:aws:kms:eu-central-1:123456789012:alias/nearkit' })).toEqual(['NEARKIT_KMS_KEY_ARN'])
    expect(keys({ ...mainnet, NEARKIT_SIGNER_DATABASE_URL: undefined })).toEqual(['NEARKIT_SIGNER_DATABASE_URL'])
    expect(keys({ ...mainnet, NEARKIT_SIGNER_TLS_CERT: undefined, NEARKIT_SIGNER_TLS_KEY: undefined })).toEqual(['NEARKIT_SIGNER_TLS_CERT'])
    expect(keys({ ...mainnet, NEARKIT_FEE_RECIPIENT: undefined })).toEqual(['NEARKIT_FEE_RECIPIENT'])
    expect(keys({ ...mainnet, NEARKIT_FEE_RECIPIENT: 'testone.near' })).toEqual(['NEARKIT_FEE_RECIPIENT'])
    expect(keys({ ...mainnet, NEARKIT_SIGNER_RPC_URLS: 'https://one.rpc' })).toEqual(['NEARKIT_SIGNER_RPC_QUORUM', 'NEARKIT_SIGNER_RPC_QUORUM'])
    expect(keys({ ...mainnet, NEARKIT_SIGNER_RPC_QUORUM: '1' })).toEqual(['NEARKIT_SIGNER_RPC_QUORUM'])
    expect(keys({ ...mainnet, NEARKIT_SIGNER_RECIPIENT: 'localhost' })).toEqual(['NEARKIT_SIGNER_RECIPIENT'])
    expect(keys({ ...mainnet, NEARKIT_SIGNER_AUTH_KEY: 'short' })).toEqual(['NEARKIT_SIGNER_AUTH_KEY'])
    // On this machine only (a sidecar), no TLS is needed.
    expect(keys({ ...mainnet, NEARKIT_SIGNER_TLS_CERT: undefined, NEARKIT_SIGNER_TLS_KEY: undefined, NEARKIT_SIGNER_HOST: '127.0.0.1' })).toEqual([])
  })

  it('the network is never assumed, and no secret is ever repeated in a problem', () => {
    const secret = randomBytes(32).toString('base64')
    const { issues } = loadSignerConfig({ NEARKIT_SIGNER_AUTH_KEY: 'nope', NEARKIT_SIGNER_KEK: secret.slice(0, 20), NEARKIT_SIGNER_DATABASE_URL: 'mysql://u:p@h/d' })
    expect(issues.map((i) => i.key)).toEqual(expect.arrayContaining(['NEAR_NETWORK', 'NEARKIT_SIGNER_AUTH_KEY', 'NEARKIT_SIGNER_KEK', 'NEARKIT_SIGNER_DATABASE_URL']))
    expect(JSON.stringify(issues)).not.toContain(secret.slice(0, 20))
    expect(JSON.stringify(issues)).not.toContain('u:p')
  })

  it('testnet: a local KEK and SQLite, no fee account', () => {
    const { config, issues } = loadSignerConfig({
      NEAR_NETWORK: 'testnet',
      NEARKIT_SIGNER_AUTH_KEY: AUTH,
      NEARKIT_SIGNER_KEK: randomBytes(32).toString('base64'),
      NEARKIT_SIGNER_RECIPIENT: 'localhost',
    })
    expect(issues).toEqual([])
    expect(config).toMatchObject({ kek: { kind: 'local' }, database: { kind: 'sqlite' }, feeRecipient: null, rpc: { quorum: 1 } })
    expect(
      keys({
        NEAR_NETWORK: 'testnet',
        NEARKIT_SIGNER_AUTH_KEY: AUTH,
        NEARKIT_SIGNER_KEK: randomBytes(32).toString('base64'),
        NEARKIT_SIGNER_RECIPIENT: 'x',
        NEARKIT_FEE_RECIPIENT: 'a.testnet',
      }),
    ).toEqual(['NEARKIT_FEE_RECIPIENT'])
  })
})

describe('the signer operator’s command line', () => {
  it('pauses and resumes, reports status, and moves keys to a new KEK (a dry run first)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nearkit-signer-admin-'))
    try {
      const oldKek = randomBytes(32).toString('base64')
      const newKek = randomBytes(32).toString('base64')
      const base = { NEAR_NETWORK: 'testnet', NEARKIT_SIGNER_AUTH_KEY: AUTH, NEARKIT_SIGNER_DB_PATH: join(dir, 's.sqlite'), NEARKIT_SIGNER_RECIPIENT: 'nearkit.vercel.app' }
      // Two keys made under the old KEK.
      const before = await buildSigner(loadSignerConfig({ ...base, NEARKIT_SIGNER_KEK: oldKek }).config as NonNullable<ReturnType<typeof loadSignerConfig>['config']>)
      for (let i = 0; i < 2; i++) await before.core.handle('create-key', { owner: { accountId: 'alice.testnet', publicKey: TEST_OWNER_KEY }, userId: 1 })
      await before.db.close()

      const out: string[] = []
      const run = (argv: string[], env: Record<string, string>) => runAdmin(argv, env, (l) => void out.push(l))
      const rotating = { ...base, NEARKIT_SIGNER_KEK: newKek, NEARKIT_SIGNER_KEK_PREVIOUS: oldKek }
      expect(await run(['reseal'], rotating)).toBe(0)
      expect(out.at(-1)).toMatch(/would reseal 2 .*dry run/)
      expect(await run(['reseal', '--apply'], rotating)).toBe(0)
      expect(out.at(-1)).toMatch(/^resealed 2 /)
      expect(await run(['reseal', '--apply'], rotating)).toBe(0)
      expect(out.at(-1)).toMatch(/^resealed 0 · already current 2/)
      // The old KEK can be retired: every key opens with the new one alone.
      const db = await openDatabase({ kind: 'sqlite', path: join(dir, 's.sqlite') })
      const held = await new SignerStore(db).activeKeys()
      for (const k of held) {
        expect(parseSealed(k.sealedKey as string).ref).toBe(localKeyWrapper(Buffer.from(newKek, 'base64')).ref)
        const seed = await openWalletKey(keyring(localKeyWrapper(Buffer.from(newKek, 'base64'))), k.sealedKey as string, {
          network: k.network,
          accountId: k.accountId,
          publicKey: k.publicKey,
          owner: k.ownerAccount,
        })
        seed.fill(0)
      }
      await db.close()

      const current = { ...base, NEARKIT_SIGNER_KEK: newKek }
      expect(await run(['pause', 'incident', 'drill'], current)).toBe(0)
      expect(await run(['status'], current)).toBe(1)
      expect(out.some((l) => /paused true/.test(l))).toBe(true)
      expect(await run(['resume', 'drill over'], current)).toBe(0)
      expect(await run(['status'], current)).toBe(0)
      expect(await run(['pause'], current)).toBe(2)
      expect(await run(['nonsense'], current)).toBe(2)
      // It never prints a secret.
      expect(out.join('\n')).not.toContain(newKek)
      expect(out.join('\n')).not.toContain(oldKek)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
