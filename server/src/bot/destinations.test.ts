import { describe, expect, it } from 'vitest'
import { recoveryRoutes } from '../api/recoveryRoutes'
import { RecoveryApiError } from '../custody/recovery'
import type { TradingWallet } from '../custody/store'
import type { ChallengeView } from '../signer/core'
import { DestinationNotApprovedError } from '../signer/errors'
import { ownerKeypair, ownerSign } from '../signer/testing'
import { ALICE } from './testing'
import { LINKED, ONE, walletBot } from './walletTesting'

/**
 * Withdrawals go anywhere valid, but only to the owner wallet or to a destination the
 * owner approved with its own signature; the signer enforces it. These are the ways an
 * attacker might try to get around that.
 */

const MALLORY = 'mallory.testnet'

async function world() {
  const owner = await ownerKeypair()
  const h = await walletBot({ linkedKey: owner.publicKey })
  const w = (await h.funded(5n * ONE)) as TradingWallet
  const mallory = await ownerKeypair()
  h.chain.accounts.set(MALLORY, { amount: ONE, keys: { [mallory.publicKey]: 'full' } })
  h.chain.accounts.set('evil.testnet', { amount: ONE })
  const routes = recoveryRoutes({ recovery: h.custody.recovery, onExported: async () => undefined, onDestinationApproved: async () => undefined })
  const challenge = async (destination: string, wallet = w.accountId) =>
    (await routes['/api/recovery/challenge']?.({ kind: 'approve-destination', accountId: wallet, destination }, {} as never)) as ChallengeView
  const approve = (c: ChallengeView, publicKey: string, signature: string) => routes['/api/recovery/destination']?.({ challengeId: c.id, publicKey, signature }, {} as never)
  const status = (p: Promise<unknown> | undefined) => (p ?? Promise.resolve()).then(() => null).catch((e: unknown) => (e instanceof RecoveryApiError ? e.status : e))
  /** A withdrawal intent as a compromised app would make it: no bot checks at all, straight to Confirm. */
  const forgedWithdraw = async (to: string, amount = ONE) => {
    const i = await h.custody.store.createIntent({
      walletId: w.id,
      userId: ALICE.id,
      chatId: ALICE.id,
      kind: 'withdraw',
      params: { asset: 'near', symbol: 'NEAR', decimals: 24, amount: amount.toString(), to, linked: false },
      quote: { feeNear: '1', registration: null, fresh: false },
      ttlMs: 60_000,
    })
    return h.custody.engine.execute(i.id, ALICE.id)
  }
  return { h, w, owner, mallory, challenge, approve, status, forgedWithdraw }
}

describe('withdrawal destinations the owner approves', () => {
  it('someone in the Telegram account links their own wallet: it can’t approve anything, and funds go nowhere new', async () => {
    const { h, w, mallory, challenge, approve, status } = await world()
    await h.store.createLinkRequest({ codeHash: 'm', userId: ALICE.id, network: 'testnet', nonce: 'n', message: 'm', ttlMs: 60_000 })
    await h.store.completeLink({ codeHash: 'm', network: 'testnet', accountId: MALLORY, userId: ALICE.id, publicKey: mallory.publicKey })
    await h.store.updateSettings(ALICE.id, { defaultAccount: MALLORY })
    // The linked wallet is now Mallory's, but the approval message still names the owner, and only its key counts.
    const c = await challenge(MALLORY)
    expect(c.ownerAccount).toBe(LINKED)
    expect(await status(approve(c, mallory.publicKey, await ownerSign(c, mallory.pair)))).toBe(403)
    // The Withdraw flow offers the (new) linked wallet, but it still needs the owner's approval.
    await h.press('cw:wd')
    await h.press(h.button('NEAR ·'))
    await h.say('1')
    await h.press(h.button('(linked)'))
    expect(h.last()?.text).toContain('Approve a new destination')
    expect(h.chain.accounts.get(MALLORY)?.amount).toBe(ONE)
    expect(h.chain.sent).toHaveLength(0)
    expect((await h.custody.signer.destinations(w.accountId)).destinations).toEqual([])
  })

  it('a new NearKit wallet answers to the same owner as the others, not to a wallet linked later', async () => {
    const { h, w, mallory } = await world()
    await h.store.createLinkRequest({ codeHash: 'm2', userId: ALICE.id, network: 'testnet', nonce: 'n', message: 'm', ttlMs: 60_000 })
    await h.store.completeLink({ codeHash: 'm2', network: 'testnet', accountId: MALLORY, userId: ALICE.id, publicKey: mallory.publicKey })
    await h.store.updateSettings(ALICE.id, { defaultAccount: MALLORY })
    await h.press('cw:list')
    await h.press(h.button('New wallet'))
    const created = (await h.wallet()) as TradingWallet
    expect(created.id).not.toBe(w.id)
    expect(created.ownerAccount).toBe(LINKED)
    expect((await h.signerVault?.key('testnet', created.accountId))?.ownerAccount).toBe(LINKED)
  })

  it('a compromised app that skips every check still can’t withdraw: the signer refuses an unapproved destination', async () => {
    const { h, w, forgedWithdraw } = await world()
    const r = await forgedWithdraw('evil.testnet')
    expect(r).toMatchObject({ kind: 'finished', intent: { status: 'failed' } })
    expect(r.kind === 'finished' && r.intent.result?.message).toMatch(/not an approved destination/)
    expect(h.chain.sent).toHaveLength(0)
    // And signing directly, without the engine, too.
    await expect(
      h.custody.signer.sign({
        wallet: w,
        intentId: 'forged',
        step: 0,
        op: { kind: 'withdraw-near', to: 'evil.testnet', amount: ONE },
        plan: [{ receiverId: 'evil.testnet', actions: [{ kind: 'transfer', deposit: ONE.toString() }], label: 'x' }],
        nonce: 1n,
        blockHash: new Uint8Array(32).fill(1),
      }),
    ).rejects.toThrow(DestinationNotApprovedError)
  })

  it('the owner’s own wallet needs no approval; an approved destination works; a substituted one does not', async () => {
    const { h, w, owner, challenge, approve, forgedWithdraw } = await world()
    expect(await forgedWithdraw(LINKED)).toMatchObject({ kind: 'finished', intent: { status: 'done' } })
    const c = await challenge('bob.testnet')
    await approve(c, owner.publicKey, await ownerSign(c, owner.pair))
    expect(await forgedWithdraw('bob.testnet')).toMatchObject({ kind: 'finished', intent: { status: 'done' } })
    expect(await forgedWithdraw('evil.testnet')).toMatchObject({ kind: 'finished', intent: { status: 'failed' } })
    expect((await h.custody.signer.destinations(w.accountId)).destinations.map((d) => d.destination)).toEqual(['bob.testnet'])
  })

  it('a tampered database can’t add a destination: the signer re-verifies the owner’s signature every time', async () => {
    const { h, w, owner, mallory, challenge, approve, forgedWithdraw } = await world()
    const c = await challenge('bob.testnet')
    await approve(c, owner.publicKey, await ownerSign(c, owner.pair))
    // Rewrite the stored approval to another destination: the signed message still says bob.testnet.
    await h.db.run("UPDATE signer_destinations SET destination = 'evil.testnet' WHERE destination = 'bob.testnet'")
    expect(await forgedWithdraw('evil.testnet')).toMatchObject({ kind: 'finished', intent: { status: 'failed' } })
    // Insert a whole approval signed by an attacker's key, claiming the owner: the key isn't the owner's on chain.
    const forged = await challenge('evil.testnet')
    await h.db.run(
      `INSERT INTO signer_destinations (id, network, account_id, destination, owner_account, public_key, challenge_id, message, nonce, recipient, signature, approved_at)
       VALUES ('x', 'testnet', ?, 'mallory.testnet', ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        w.accountId,
        LINKED,
        mallory.publicKey,
        forged.id,
        forged.message.replace('evil.testnet', MALLORY),
        forged.nonce,
        forged.recipient,
        await ownerSign({ ...forged, message: forged.message.replace('evil.testnet', MALLORY) }, mallory.pair),
      ],
    )
    expect(await forgedWithdraw(MALLORY)).toMatchObject({ kind: 'finished', intent: { status: 'failed' } })
    expect(h.chain.accounts.get('evil.testnet')?.amount).toBe(ONE)
    expect(h.chain.accounts.get(MALLORY)?.amount).toBe(ONE)
  })

  it('stale, replayed or cross-wallet approvals are refused', async () => {
    const { h, w, owner, challenge, approve, status } = await world()
    const stale = await challenge('bob.testnet')
    h.advance(5 * 60_000 + 1)
    expect(await status(approve(stale, owner.publicKey, await ownerSign(stale, owner.pair)))).toBe(410)
    const c = await challenge('bob.testnet')
    const sig = await ownerSign(c, owner.pair)
    expect(await status(approve(c, owner.publicKey, sig))).toBeNull()
    expect(await status(approve(c, owner.publicKey, sig))).toBe(409)
    // A second wallet of the same owner: the approval of the first doesn't carry over.
    await h.press('cw:list')
    await h.press(h.button('New wallet'))
    const other = (await h.wallet()) as TradingWallet
    expect(other.id).not.toBe(w.id)
    expect((await h.custody.signer.destinations(other.accountId)).destinations).toEqual([])
    // The first wallet's signed message can't approve anything for the second one.
    const c2 = await challenge('bob.testnet', other.accountId)
    expect(await status(approve(c2, owner.publicKey, sig))).toBe(403)
  })

  it('an approval made with an owner key that is later removed no longer counts: approve again with the current key', async () => {
    const { h, owner, challenge, approve, forgedWithdraw } = await world()
    const c = await challenge('bob.testnet')
    await approve(c, owner.publicKey, await ownerSign(c, owner.pair))
    const keys = h.chain.accounts.get(LINKED)?.keys as Record<string, 'full' | 'function-call'>
    const next = await ownerKeypair()
    delete keys[owner.publicKey]
    keys[next.publicKey] = 'full'
    expect(await forgedWithdraw('bob.testnet')).toMatchObject({ kind: 'finished', intent: { status: 'failed' } })
    await h.db.run('UPDATE signer_destinations SET revoked_at = 1')
    const again = await challenge('bob.testnet')
    await approve(again, next.publicKey, await ownerSign(again, next.pair))
    expect(await forgedWithdraw('bob.testnet')).toMatchObject({ kind: 'finished', intent: { status: 'done' } })
  })

  it('removing an approval (only ever safe) blocks that destination again', async () => {
    const { h, w, owner, challenge, approve, forgedWithdraw } = await world()
    const c = await challenge('bob.testnet')
    await approve(c, owner.publicKey, await ownerSign(c, owner.pair))
    expect(await h.custody.signer.revokeDestination({ accountId: w.accountId, destination: 'bob.testnet' })).toBe(true)
    expect(await forgedWithdraw('bob.testnet')).toMatchObject({ kind: 'finished', intent: { status: 'failed' } })
  })
})
