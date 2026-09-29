import { describe, expect, it } from 'vitest'
import { base58Decode, base58Encode, base64Decode, base64Encode } from '@/lib/encoding'
import { nep413Digest } from '@/services/near/nep413'
import { createRpcClient } from '@/services/near/rpc'
import { serializeSignedTransaction, serializeTransaction, transactionDigest } from '@/services/near/transaction'
import { recoveryRoutes } from '../api/recoveryRoutes'
import { RecoveryApiError, type RecoveryDescription } from '../custody/recovery'
import { ALICE } from './testing'
import { LINKED, ONE, walletBot } from './walletTesting'

type Harness = Awaited<ReturnType<typeof walletBot>>
const MALLORY = 'mallory.testnet'

async function keypair() {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  return { pair, publicKey: `ed25519:${base58Encode(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))}` }
}

/** What the user's own wallet does with the export page's request. */
async function walletSign(d: RecoveryDescription, key: CryptoKeyPair) {
  const digest = await nep413Digest({ message: d.message, nonce: base64Decode(d.nonce) as Uint8Array, recipient: d.recipient })
  return base64Encode(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key.privateKey, digest)))
}

async function setup() {
  const linked = await keypair()
  const app = await keypair()
  const h = await walletBot({ linkedKey: linked.publicKey, extraKeys: { [app.publicKey]: 'function-call' } })
  return { h, linked, app }
}

async function addBackup(h: Harness) {
  await h.press('cr:show')
  await h.press(h.button('Add backup key'))
  await h.press(h.button('Add backup key'))
}

async function exportLink(h: Harness) {
  await h.press('cr:export')
  const url = h.buttons().find((b) => b.url)?.url ?? ''
  expect(url).toMatch(/^https:\/\/nearkit\.vercel\.app\/telegram#recover=[A-Za-z0-9_-]{16,}$/)
  return url.split('#recover=')[1] as string
}

/** Someone holding Alice's Telegram session links a wallet of their own and makes it the default. */
async function intruder(h: Harness) {
  const k = await keypair()
  h.chain.accounts.set(MALLORY, { amount: ONE, keys: { [k.publicKey]: 'full' } })
  h.store.createLinkRequest({ codeHash: 'mallory', userId: ALICE.id, network: 'testnet', nonce: 'n', message: 'm', ttlMs: 60_000 })
  h.store.completeLink({ codeHash: 'mallory', network: 'testnet', accountId: MALLORY, userId: ALICE.id, publicKey: k.publicKey })
  h.store.updateSettings(ALICE.id, { defaultAccount: MALLORY })
  return k
}

describe('backup key: yours even without NearKit', () => {
  it('adds your linked wallet’s key to the NearKit wallet, on chain', async () => {
    const { h, linked } = await setup()
    const w = await h.funded(2n * ONE)
    await h.press('cr:show')
    expect(h.last()?.text).toContain('Backup key</b> · not added yet')
    await h.press(h.button('Add backup key'))
    expect(h.last()?.text).toContain(`Your owner wallet <code>${LINKED}</code> gets a full-access key`)
    expect(h.last()?.text).toContain(linked.publicKey)
    await h.press(h.button('Add backup key'))
    expect(h.last()?.text).toContain('Backup key added')
    expect(h.chain.keysOf(w.accountId).sort()).toEqual([w.publicKey, linked.publicKey].sort())
    expect(h.wallet()?.backupKey).toBe(linked.publicKey)
    await h.press('cw:home')
    expect(h.last()?.text).toContain('Backup key: your own wallet can control this one ✓')
  })

  it('with the backup key, your own wallet moves the funds by itself: no NearKit involved', async () => {
    const { h, linked } = await setup()
    const w = await h.funded(2n * ONE)
    await addBackup(h)
    const rpc = createRpcClient({ urls: ['https://rpc.test'], fetch: h.chain.fetch })
    const key = await rpc.call<{ nonce: number }>('query', { request_type: 'view_access_key', finality: 'final', account_id: w.accountId, public_key: linked.publicKey })
    const block = await rpc.call<{ header: { hash: string } }>('block', { finality: 'final' })
    const tx = {
      signerId: w.accountId,
      publicKey: linked.publicKey,
      nonce: BigInt(key.nonce) + 1n,
      receiverId: 'bob.testnet',
      blockHash: base58Decode(block.header.hash) as Uint8Array,
      actions: [{ type: 'Transfer' as const, deposit: ONE }],
    }
    const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, linked.pair.privateKey, await transactionDigest(serializeTransaction(tx))))
    const before = h.chain.accounts.get('bob.testnet')?.amount ?? 0n
    await rpc.call('send_tx', { signed_tx_base64: base64Encode(serializeSignedTransaction(tx, signature)), wait_until: 'FINAL' })
    expect((h.chain.accounts.get('bob.testnet')?.amount ?? 0n) - before).toBe(ONE)
  })
})

describe('export: in the web app, after the owner wallet signs', () => {
  it('shows the key once, to the owner, and tells Telegram', async () => {
    const { h, linked } = await setup()
    const w = await h.funded(ONE)
    const code = await exportLink(h)
    const notices: unknown[] = []
    const routes = recoveryRoutes({ recovery: h.custody.recovery, onExported: async (r) => void notices.push(r) })
    const d = (await routes['/api/recovery/describe']?.({ code }, {} as never)) as RecoveryDescription
    expect(d).toMatchObject({ wallet: w.accountId, owner: LINKED, network: 'testnet' })
    expect(d.message).toContain(`Wallet: ${w.accountId}`)
    const out = (await routes['/api/recovery/export']?.({ code, accountId: LINKED, publicKey: linked.publicKey, signature: await walletSign(d, linked.pair) }, {} as never)) as {
      accountId: string
      publicKey: string
      secretKey: string
    }
    expect(out.accountId).toBe(w.accountId)
    const raw = base58Decode(out.secretKey.slice('ed25519:'.length)) as Uint8Array
    expect(`ed25519:${base58Encode(raw.subarray(32))}`).toBe(w.publicKey)
    expect(notices).toEqual([{ userId: ALICE.id, wallet: w.accountId, signedBy: LINKED }])
    // Once only; and the security log never holds the key.
    await expect(h.custody.recovery.export({ code, accountId: LINKED, publicKey: linked.publicKey, signature: await walletSign(d, linked.pair) })).rejects.toMatchObject({
      status: 409,
    })
    const audit = h.custody.store.auditOf(w.id)
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['export-requested', 'key-exported']))
    expect(JSON.stringify(audit)).not.toContain(out.secretKey.slice(8))
  })

  it('refuses another account, a bad signature, a function-call key and an expired link', async () => {
    const { h, linked, app } = await setup()
    await h.funded(ONE)
    const code = await exportLink(h)
    const d = h.custody.recovery.describe(code)
    const sig = await walletSign(d, linked.pair)
    const refused = (p: Promise<unknown>) => p.then(() => null).catch((e: unknown) => (e instanceof RecoveryApiError ? e.status : e))
    expect(await refused(h.custody.recovery.export({ code, accountId: 'bob.testnet', publicKey: linked.publicKey, signature: sig }))).toBe(403)
    expect(
      await refused(h.custody.recovery.export({ code, accountId: LINKED, publicKey: linked.publicKey, signature: await walletSign({ ...d, message: 'other' }, linked.pair) })),
    ).toBe(401)
    expect(await refused(h.custody.recovery.export({ code, accountId: LINKED, publicKey: app.publicKey, signature: await walletSign(d, app.pair) }))).toBe(403)
    const next = await exportLink(h)
    h.advance(10 * 60_000 + 1)
    expect(await refused(h.custody.recovery.export({ code: next, accountId: LINKED, publicKey: linked.publicKey, signature: sig }))).toBe(410)
  })
})

describe('the owner, not whichever wallet is linked now', () => {
  it('export: a wallet linked later is refused; the owner signs, linked or not', async () => {
    const { h, linked } = await setup()
    const w = await h.funded(ONE)
    const mallory = await intruder(h)
    const code = await exportLink(h)
    const d = h.custody.recovery.describe(code)
    expect(d.owner).toBe(LINKED)
    await expect(h.custody.recovery.export({ code, accountId: MALLORY, publicKey: mallory.publicKey, signature: await walletSign(d, mallory.pair) })).rejects.toMatchObject({
      status: 403,
      code: 'not-owner',
    })
    expect(h.custody.store.auditOf(w.id).map((a) => a.action)).toContain('export-refused')
    h.store.unlink('testnet', LINKED, ALICE.id)
    const out = await h.custody.recovery.export({ code, accountId: LINKED, publicKey: linked.publicKey, signature: await walletSign(d, linked.pair) })
    expect(out.signedBy).toBe(LINKED)
  })

  it('backup key: always a key of the owner wallet; a request for any other key is refused before signing', async () => {
    const { h, linked } = await setup()
    const w = await h.funded(2n * ONE)
    const mallory = await intruder(h)
    await h.press('cr:show')
    await h.press(h.button('Add backup key'))
    expect(h.last()?.text).toContain(`Your owner wallet <code>${LINKED}</code>`)
    expect(h.last()?.text).not.toContain(mallory.publicKey)
    const forged = h.custody.store.createIntent({
      walletId: w.id,
      userId: ALICE.id,
      chatId: ALICE.id,
      kind: 'backup-key',
      params: { linkedAccount: MALLORY, publicKey: mallory.publicKey },
      ttlMs: 60_000,
    })
    const sent = h.chain.rpcCalls('send_tx').length
    await h.press(`cx:ok:${forged.id}`)
    expect(h.last()?.text).toContain('Only a key of the wallet this NearKit wallet was created with can be its backup key')
    expect(h.chain.rpcCalls('send_tx')).toHaveLength(sent)
    expect(h.chain.keysOf(w.accountId)).toEqual([w.publicKey])
    await addBackup(h)
    expect(h.chain.keysOf(w.accountId).sort()).toEqual([w.publicKey, linked.publicKey].sort())
  })

  it('revoke: a key that isn’t the owner’s doesn’t count, and Recovery warns about it', async () => {
    const { h, linked } = await setup()
    const w = await h.funded(2n * ONE)
    const stranger = await keypair()
    ;(h.chain.accounts.get(w.accountId)?.keys as Record<string, 'full'>)[stranger.publicKey] = 'full'
    await h.press('cr:show')
    expect(h.last()?.text).toContain(`Another key also controls this wallet: <code>${stranger.publicKey.slice(0, 16)}…</code>`)
    await h.press('cr:revoke')
    await h.press(h.button('Remove NearKit’s key'))
    expect(h.last()?.text).toContain(`no other key on this wallet is a full-access key of ${LINKED}`)
    expect(h.chain.keysOf(w.accountId)).toContain(w.publicKey)
    await addBackup(h)
    await h.press('cr:revoke')
    await h.press(h.button('Remove NearKit’s key'))
    expect(h.last()?.text).toContain('NearKit’s key was removed')
    expect(h.chain.keysOf(w.accountId).sort()).toEqual([linked.publicKey, stranger.publicKey].sort())
  })

  it('after a key change on the owner wallet, linking it again makes the new key the backup key', async () => {
    const { h, linked } = await setup()
    const w = await h.funded(2n * ONE)
    const next = await keypair()
    const keys = h.chain.accounts.get(LINKED)?.keys as Record<string, 'full' | 'function-call'>
    delete keys[linked.publicKey]
    keys[next.publicKey] = 'full'
    await addBackup(h)
    expect(h.last()?.text).toContain(`no longer a full-access key of ${LINKED}. Link ${LINKED} again`)
    h.store.createLinkRequest({ codeHash: 'relink', userId: ALICE.id, network: 'testnet', nonce: 'n', message: 'm', ttlMs: 60_000 })
    h.store.completeLink({ codeHash: 'relink', network: 'testnet', accountId: LINKED, userId: ALICE.id, publicKey: next.publicKey })
    await addBackup(h)
    expect(h.last()?.text).toContain('Backup key added')
    expect(h.chain.keysOf(w.accountId).sort()).toEqual([w.publicKey, next.publicKey].sort())
  })
})

describe('removing NearKit’s access, and deleting an empty wallet', () => {
  it('needs the backup key first; then NearKit’s key is deleted on chain and its copy erased', async () => {
    const { h, linked } = await setup()
    const w = await h.funded(2n * ONE)
    await h.press('cr:revoke')
    await h.press(h.button('Remove NearKit’s key'))
    expect(h.last()?.text).toContain('Add your backup key first')
    expect(h.chain.keysOf(w.accountId)).toContain(w.publicKey)
    await addBackup(h)
    await h.press('cr:show')
    await h.press(h.button('Remove NearKit’s access'))
    await h.press(h.button('Remove NearKit’s key'))
    expect(h.last()?.text).toContain('NearKit’s key was removed')
    expect(h.chain.keysOf(w.accountId)).toEqual([linked.publicKey])
    expect(h.custody.store.wallet(w.id)).toMatchObject({ status: 'revoked', sealedKey: null })
    expect(h.wallet()).toBeNull()
    expect(h.chain.accounts.get(w.accountId)?.amount).toBeGreaterThan(ONE)
  })

  it('deletes only a wallet that was never funded', async () => {
    const h = await walletBot()
    await h.press('cw:create')
    const w = h.wallet()
    await h.press('cr:delete')
    await h.press(h.button('Yes, delete it'))
    expect(h.last()?.text).toContain('never funded')
    expect(h.custody.store.wallet(w?.id as string)).toMatchObject({ status: 'deleted', sealedKey: null })
    await h.funded(ONE)
    await h.press('cr:delete')
    expect(h.last()?.text).toContain('can’t just be deleted')
    expect(h.wallet()?.status).toBe('active')
  })
})
