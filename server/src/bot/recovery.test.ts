import { describe, expect, it } from 'vitest'
import { base58Decode, base58Encode, base64Encode } from '@/lib/encoding'
import { createRpcClient } from '@/services/near/rpc'
import { serializeSignedTransaction, serializeTransaction, transactionDigest } from '@/services/near/transaction'
import { createExportKeyPair, openExport } from '@/lib/exportCrypto'
import { challengeProblem } from '@/services/recovery'
import { ownerSign } from '../signer/testing'
import { ALICE } from './testing'
import { keypair, setup, status, webApi, type Harness } from './recoveryTesting'
import { LINKED, ONE, walletBot } from './walletTesting'

const MALLORY = 'mallory.testnet'

async function addBackup(h: Harness) {
  await h.press('cr:show')
  await h.press(h.button('Add backup key'))
  await h.press(h.button('Add backup key'))
}

/** Someone holding Alice's Telegram session links a wallet of their own and makes it the default. */
async function intruder(h: Harness) {
  const k = await keypair()
  h.chain.accounts.set(MALLORY, { amount: ONE, keys: { [k.publicKey]: 'full' } })
  await h.store.createLinkRequest({ codeHash: 'mallory', userId: ALICE.id, network: 'testnet', nonce: 'n', message: 'm', ttlMs: 60_000 })
  await h.store.completeLink({ codeHash: 'mallory', network: 'testnet', accountId: MALLORY, userId: ALICE.id, publicKey: k.publicKey })
  await h.store.updateSettings(ALICE.id, { defaultAccount: MALLORY })
  return k
}

describe('backup key: yours even without NEARKITS', () => {
  it('adds your linked wallet’s key to the NEARKITS wallet, on chain', async () => {
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
    expect((await h.wallet())?.backupKey).toBe(linked.publicKey)
    await h.press('cw:home')
    expect(h.last()?.text).toContain('Backup key: your own wallet can control this one ✓')
  })

  it('with the backup key, your own wallet moves the funds by itself: no NEARKITS involved', async () => {
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
  it('names the recovery page on the web address NEARKITS is configured with, never a fixed one', async () => {
    const { h } = await setup()
    await h.funded(ONE)
    await h.press('cr:export')
    expect(h.last()?.text).toContain('the same page works without Telegram: nearkits.com/recover')
    const linked = await keypair()
    const moved = await walletBot({ linkedKey: linked.publicKey, env: { NEARKIT_WEB_URL: 'https://web.example' } })
    await moved.funded(ONE)
    await moved.press('cr:export')
    expect(moved.last()?.text).toContain('the same page works without Telegram: web.example/recover')
    expect(moved.last()?.text).not.toContain('vercel.app')
    expect(moved.buttons().find((b) => b.url)?.url).toMatch(/^https:\/\/web\.example\/recover#wallet=[0-9a-f]{64}$/)
  })

  it('the Export screen says every export is held and announced here', async () => {
    const { h } = await setup()
    await h.funded(ONE)
    await h.press('cr:export')
    expect(h.last()?.text).toContain('NEARKITS holds the export for 24 hours and tells you here at once')
  })

  it('refuses another account’s key, a bad signature, a function-call key, an expired request and a guessing streak', async () => {
    const { h, linked, app } = await setup()
    const w = await h.funded(ONE)
    const api = webApi(h)
    const browser = await createExportKeyPair()
    const fresh = () => api.challenge({ kind: 'export', accountId: w.accountId, recipientKey: browser.publicKey })
    const stranger = await keypair()
    h.chain.accounts.set('stranger.testnet', { amount: ONE, keys: { [stranger.publicKey]: 'full' } })
    let c = await fresh()
    expect(await status(api.requestExport({ challengeId: c.id, publicKey: stranger.publicKey, signature: await ownerSign(c, stranger.pair) }))).toBe(403)
    expect(await status(api.requestExport({ challengeId: c.id, publicKey: linked.publicKey, signature: await ownerSign({ ...c, message: 'other' }, linked.pair) }))).toBe(403)
    // A function-call key of the owner can't export.
    expect(await status(api.requestExport({ challengeId: c.id, publicKey: app.publicKey, signature: await ownerSign(c, app.pair) }))).toBe(403)
    c = await fresh()
    h.advance(5 * 60_000 + 1)
    expect(await status(api.requestExport({ challengeId: c.id, publicKey: linked.publicKey, signature: await ownerSign(c, linked.pair) }))).toBe(410)
    c = await fresh()
    for (let i = 0; i < 5; i++) await status(api.requestExport({ challengeId: c.id, publicKey: stranger.publicKey, signature: await ownerSign(c, stranger.pair) }))
    // Locked: even the owner's own signature is refused now; a new request works.
    expect(await status(api.requestExport({ challengeId: c.id, publicKey: linked.publicKey, signature: await ownerSign(c, linked.pair) }))).toBe(403)
    c = await fresh()
    expect(await status(api.requestExport({ challengeId: c.id, publicKey: linked.publicKey, signature: await ownerSign(c, linked.pair) }))).toBeNull()
  })

  it('a stolen link, a known Telegram ID or wallet address, or an intercepted signature exports nothing readable', async () => {
    const { h, linked } = await setup()
    const w = await h.funded(ONE)
    const api = webApi(h)
    // The link is just the wallet's (public) address: an attacker with it and their own browser and wallet gets nowhere.
    const mallory = await keypair()
    h.chain.accounts.set(MALLORY, { amount: ONE, keys: { [mallory.publicKey]: 'full' } })
    const theirs = await createExportKeyPair()
    const c1 = await api.challenge({ kind: 'export', accountId: w.accountId, recipientKey: theirs.publicKey })
    expect(c1.message).toContain(`Owner wallet: ${LINKED}`)
    expect(await status(api.requestExport({ challengeId: c1.id, publicKey: mallory.publicKey, signature: await ownerSign(c1, mallory.pair) }))).toBe(403)
    // The owner's signed request, intercepted and sent first: the key is sealed to the OWNER's browser key, so it opens nowhere else.
    const owners = await createExportKeyPair()
    const c2 = await api.challenge({ kind: 'export', accountId: w.accountId, recipientKey: owners.publicKey })
    const held = await api.requestExport({ challengeId: c2.id, publicKey: linked.publicKey, signature: await ownerSign(c2, linked.pair) })
    h.advance(held.releaseAt - h.deps.now())
    const stolen = await api.collect(held.exportId)
    await expect(openExport(theirs.privateKey, stolen.sealed, { challengeId: c2.id, network: 'testnet', accountId: w.accountId })).rejects.toThrow()
    // Swapping the browser key after the owner signed is not possible: the request keeps the key it was made with.
    expect(await status(api.requestExport({ challengeId: c2.id, publicKey: linked.publicKey, signature: await ownerSign(c2, linked.pair) }))).toBe(409)
  })
})

describe('the web page checks what it is asked to sign', () => {
  it('accepts NEARKITS’ real requests, and refuses one that was altered on the way', async () => {
    const { h } = await setup()
    const w = await h.funded(ONE)
    const api = webApi(h)
    const browser = await createExportKeyPair()
    const c = await api.challenge({ kind: 'export', accountId: w.accountId, recipientKey: browser.publicKey })
    const want = { kind: 'export' as const, network: 'testnet', recipient: 'nearkits.com', wallet: w.accountId, recipientKey: browser.publicKey }
    expect(await challengeProblem(c, want)).toBeNull()
    const theirs = await createExportKeyPair()
    // A server that swapped in its own browser key (to read the export) gets no signature.
    const swapped = await api.challenge({ kind: 'export', accountId: w.accountId, recipientKey: theirs.publicKey })
    expect(await challengeProblem(swapped, want)).toMatch(/another browser/)
    const approve = await api.challenge({ kind: 'approve-destination', accountId: w.accountId, destination: 'bob.testnet' })
    expect(
      await challengeProblem(approve, { kind: 'approve-destination', network: 'testnet', recipient: 'nearkits.com', wallet: w.accountId, destination: 'bob.testnet' }),
    ).toBeNull()
    expect(
      await challengeProblem(approve, { kind: 'approve-destination', network: 'testnet', recipient: 'nearkits.com', wallet: w.accountId, destination: 'evil.testnet' }),
    ).toMatch(/another destination/)
    const session = await api.challenge({ kind: 'owner-session', owner: LINKED })
    expect(await challengeProblem(session, { kind: 'owner-session', network: 'testnet', recipient: 'nearkits.com', owner: LINKED })).toBeNull()
  })
})

describe('recovery without Telegram', () => {
  it('the owner wallet alone lists its NEARKITS wallets and exports one: held, announced in Telegram, collected once its hold is over', async () => {
    const { h, linked } = await setup()
    const a = await h.funded(ONE)
    await h.press('cw:list')
    await h.press(h.button('New wallet'))
    const b = (await h.wallet()) as NonNullable<Awaited<ReturnType<Harness['wallet']>>>
    const notices: unknown[] = []
    const api = webApi(h, notices)
    const updatesBefore = h.fake.messages().length
    const session = await api.challenge({ kind: 'owner-session', owner: LINKED })
    expect(session.message).toContain(`Owner wallet: ${LINKED}`)
    const list = await api.wallets({ challengeId: session.id, publicKey: linked.publicKey, signature: await ownerSign(session, linked.pair) })
    expect(list.ownerAccount).toBe(LINKED)
    expect(list.wallets.map((x) => [x.accountId, x.name])).toEqual([
      [a.accountId, 'Main'],
      [b.accountId, 'Wallet 2'],
    ])
    // The session request is used up: replaying it lists nothing.
    expect(await status(api.wallets({ challengeId: session.id, publicKey: linked.publicKey, signature: await ownerSign(session, linked.pair) }))).toBe(409)
    // Listing involved no bot message at all.
    expect(h.fake.messages().length).toBe(updatesBefore)
    const browser = await createExportKeyPair()
    const c = await api.challenge({ kind: 'export', accountId: b.accountId, recipientKey: browser.publicKey })
    const held = await api.requestExport({ challengeId: c.id, publicKey: linked.publicKey, signature: await ownerSign(c, linked.pair) })
    h.advance(held.releaseAt - h.deps.now())
    const out = await api.collect(held.exportId)
    const secret = await openExport(browser.privateKey, out.sealed, { challengeId: c.id, network: 'testnet', accountId: b.accountId })
    const raw = base58Decode(secret.slice('ed25519:'.length)) as Uint8Array
    expect(`ed25519:${base58Encode(raw.subarray(32))}`).toBe(b.publicKey)
    // Telegram is told twice: when it was asked for, and when it was collected. No bot update was involved.
    expect(notices).toEqual([
      { kind: 'export-requested', userId: ALICE.id, accountId: b.accountId, owner: LINKED, browserKey: held.browserKey },
      { kind: 'exported', userId: ALICE.id, accountId: b.accountId, owner: LINKED, released: 'hold' },
    ])
  })

  it('another account’s signature lists nothing of the owner’s', async () => {
    const { h } = await setup()
    await h.funded(ONE)
    const api = webApi(h)
    const mallory = await keypair()
    h.chain.accounts.set(MALLORY, { amount: ONE, keys: { [mallory.publicKey]: 'full' } })
    // Asking as the owner but signing with another key is refused.
    const s1 = await api.challenge({ kind: 'owner-session', owner: LINKED })
    expect(await status(api.wallets({ challengeId: s1.id, publicKey: mallory.publicKey, signature: await ownerSign(s1, mallory.pair) }))).toBe(403)
    // Asking as themselves lists only their own (none).
    const s2 = await api.challenge({ kind: 'owner-session', owner: MALLORY })
    expect((await api.wallets({ challengeId: s2.id, publicKey: mallory.publicKey, signature: await ownerSign(s2, mallory.pair) })).wallets).toEqual([])
  })
})

describe('the owner, not whichever wallet is linked now', () => {
  it('export: a wallet linked later is refused; the owner signs, linked or not', async () => {
    const { h, linked } = await setup()
    const w = await h.funded(ONE)
    const mallory = await intruder(h)
    const api = webApi(h)
    const browser = await createExportKeyPair()
    const c = await api.challenge({ kind: 'export', accountId: w.accountId, recipientKey: browser.publicKey })
    expect(c.ownerAccount).toBe(LINKED)
    expect(await status(api.requestExport({ challengeId: c.id, publicKey: mallory.publicKey, signature: await ownerSign(c, mallory.pair) }))).toBe(403)
    expect((await h.signerVault?.events('testnet', w.accountId))?.map((e) => e.kind)).toContain('owner-proof-refused')
    await h.store.unlink('testnet', LINKED, ALICE.id)
    const held = await api.requestExport({ challengeId: c.id, publicKey: linked.publicKey, signature: await ownerSign(c, linked.pair) })
    expect(held.accountId).toBe(w.accountId)
  })

  it('backup key: always a key of the owner wallet; a request for any other key is refused before signing', async () => {
    const { h, linked } = await setup()
    const w = await h.funded(2n * ONE)
    const mallory = await intruder(h)
    await h.press('cr:show')
    await h.press(h.button('Add backup key'))
    expect(h.last()?.text).toContain(`Your owner wallet <code>${LINKED}</code>`)
    expect(h.last()?.text).not.toContain(mallory.publicKey)
    const forged = await h.custody.store.createIntent({
      walletId: w.id,
      userId: ALICE.id,
      chatId: ALICE.id,
      kind: 'backup-key',
      params: { linkedAccount: MALLORY, publicKey: mallory.publicKey },
      ttlMs: 60_000,
    })
    const sent = h.chain.rpcCalls('send_tx').length
    await h.press(`cx:ok:${forged.id}`)
    expect(h.last()?.text).toContain('Only a key of the wallet this NEARKITS wallet was created with can be its backup key')
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
    await h.press(h.button('Remove NEARKITS’ key'))
    expect(h.last()?.text).toContain(`no other key on this wallet is a full-access key of ${LINKED}`)
    expect(h.chain.keysOf(w.accountId)).toContain(w.publicKey)
    await addBackup(h)
    await h.press('cr:revoke')
    await h.press(h.button('Remove NEARKITS’ key'))
    expect(h.last()?.text).toContain('NEARKITS’ key was removed')
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
    await h.store.createLinkRequest({ codeHash: 'relink', userId: ALICE.id, network: 'testnet', nonce: 'n', message: 'm', ttlMs: 60_000 })
    await h.store.completeLink({ codeHash: 'relink', network: 'testnet', accountId: LINKED, userId: ALICE.id, publicKey: next.publicKey })
    await addBackup(h)
    expect(h.last()?.text).toContain('Backup key added')
    expect(h.chain.keysOf(w.accountId).sort()).toEqual([w.publicKey, next.publicKey].sort())
  })
})

describe('removing NEARKITS’ access, and deleting an empty wallet', () => {
  it('needs the backup key first; then NEARKITS’ key is deleted on chain and its copy erased', async () => {
    const { h, linked } = await setup()
    const w = await h.funded(2n * ONE)
    await h.press('cr:revoke')
    await h.press(h.button('Remove NEARKITS’ key'))
    expect(h.last()?.text).toContain('Add your backup key first')
    expect(h.chain.keysOf(w.accountId)).toContain(w.publicKey)
    await addBackup(h)
    await h.press('cr:show')
    await h.press(h.button('Remove NEARKITS’ access'))
    await h.press(h.button('Remove NEARKITS’ key'))
    expect(h.last()?.text).toContain('NEARKITS’ key was removed')
    expect(h.chain.keysOf(w.accountId)).toEqual([linked.publicKey])
    expect(await h.custody.store.wallet(w.id)).toMatchObject({ status: 'revoked' })
    // The signer saw NearKit's key gone on chain and erased its copy.
    expect(await h.signerVault?.key('testnet', w.accountId)).toMatchObject({ status: 'erased', sealedKey: null, eraseReason: 'revoked' })
    expect(await h.wallet()).toBeNull()
    expect(h.chain.accounts.get(w.accountId)?.amount).toBeGreaterThan(ONE)
  })

  it('deletes only a wallet that holds nothing of value: never funded, or only NEAR dust', async () => {
    const h = await walletBot()
    await h.press('cw:create')
    const w = await h.wallet()
    await h.press('cr:delete')
    await h.press(h.button('Yes, delete it'))
    expect(h.last()?.text).toContain('never funded')
    expect(await h.custody.store.wallet(w?.id as string)).toMatchObject({ status: 'deleted' })
    expect(await h.signerVault?.key('testnet', w?.accountId as string)).toMatchObject({ status: 'erased', sealedKey: null, eraseReason: 'deleted' })
    await h.funded(ONE)
    await h.press('cr:delete')
    expect(h.last()?.text).toContain('holds 0.05 NEAR or more')
    expect((await h.wallet())?.status).toBe('active')
  })

  it('a wallet left with dust (0.0075 NEAR) is offered for deletion, says the dust stays on chain, and is deleted with its key kept sealed', async () => {
    const h = await walletBot()
    await h.funded(7_500_000_000_000_000_000_000n)
    const w = await h.wallet()
    await h.press('cr:delete')
    expect(h.last()?.text).toContain('holds only dust')
    expect(h.last()?.text).toContain('0.0075')
    await h.press(h.button('Yes, delete it'))
    expect(h.last()?.text).toContain('only dust')
    expect(await h.custody.store.wallet(w?.id as string)).toMatchObject({ status: 'deleted' })
    expect(await h.signerVault?.key('testnet', w?.accountId as string)).toMatchObject({ status: 'active' })
  })
})
