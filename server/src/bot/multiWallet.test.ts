import { describe, expect, it } from 'vitest'
import { base58Decode, base58Encode } from '@/lib/encoding'
import { recoveryRoutes } from '../api/recoveryRoutes'
import { MAX_ACTIVE_WALLETS_PER_USER } from '../custody/limits'
import type { TradingWallet } from '../custody/store'
import type { ChallengeView } from '../signer/core'
import { exportAsOwner, ownerKeypair } from '../signer/testing'
import { ALICE } from './testing'
import { ONE, walletBot } from './walletTesting'

type Harness = Awaited<ReturnType<typeof walletBot>>

/** Creates a wallet with the New/Create button shown right now (a fresh one-time key each time). */
async function newWallet(h: Harness): Promise<TradingWallet> {
  h.advance(10_000) // a person's pace: the bot's flood limit is not what these tests are about
  await h.press('cw:list')
  const create = h.button('New wallet') || h.button('Create NEARKITS wallet')
  if (!create) {
    await h.say('/wallet')
    await h.press(h.button('Create NEARKITS wallet'))
  } else {
    await h.press(create)
  }
  return (await h.wallet()) as TradingWallet
}

describe('several NEARKITS wallets per Telegram user', () => {
  it(`up to ${MAX_ACTIVE_WALLETS_PER_USER} active wallets; the next is refused; deleting an empty one frees its slot`, async () => {
    const h = await walletBot()
    const made: TradingWallet[] = []
    for (let i = 0; i < MAX_ACTIVE_WALLETS_PER_USER; i++) made.push(await newWallet(h))
    expect(new Set(made.map((w) => w.accountId)).size).toBe(MAX_ACTIVE_WALLETS_PER_USER)
    expect(made.map((w) => w.slot)).toEqual(Array.from({ length: MAX_ACTIVE_WALLETS_PER_USER }, (_, i) => i + 1))
    // Each has its own key: no two wallets share one.
    expect(new Set(made.map((w) => w.publicKey)).size).toBe(MAX_ACTIVE_WALLETS_PER_USER)
    await h.press('cw:list')
    expect(h.last()?.text).toContain(`${MAX_ACTIVE_WALLETS_PER_USER} of ${MAX_ACTIVE_WALLETS_PER_USER}`)
    expect(h.button('New wallet')).toBe('') // no Create button when full
    await h.press(`cw:new:extra-key-1`)
    expect(h.last()?.text).toContain(`You have ${MAX_ACTIVE_WALLETS_PER_USER} NEARKITS wallets`)
    // Deleting the (never funded) 4th frees slot 4; a new day's creation takes it.
    await h.press(`cr:delete:${made[3]?.id}`)
    await h.press(h.button('Yes, delete it'))
    h.advance(86_400_001) // today's creations are used up; tomorrow the freed slot can be filled
    const again = await newWallet(h)
    expect(again.slot).toBe(4)
    expect(again.accountId).not.toBe(made[3]?.accountId)
  })

  it('an old Create button (from before several wallets, no key) never makes a second wallet', async () => {
    const h = await walletBot()
    await h.press('cw:create')
    await h.press('cw:create')
    const [only] = await h.custody.store.activeWallets(ALICE.id, 'testnet')
    expect(await h.custody.store.activeWallets(ALICE.id, 'testnet')).toHaveLength(1)
    expect(h.last()?.text).toContain(only?.accountId)
    expect(h.last()?.text).not.toContain('created')
  })

  it('a used Create button never offers its wallet again once that wallet is closed', async () => {
    const h = await walletBot()
    await h.say('/wallet')
    const create = h.button('Create NEARKITS wallet')
    await h.press(create)
    const w = (await h.wallet()) as TradingWallet
    await h.press(`cr:delete:${w.id}`)
    await h.press(h.button('Yes, delete it'))
    await h.press(create) // the same old button, pressed again later
    expect(h.last()?.text).not.toContain(w.accountId)
    expect(h.last()?.text).toContain('already used')
    expect(await h.custody.store.activeWallets(ALICE.id, 'testnet')).toEqual([])
  })

  it('every screen names the wallet it acts on; selecting another switches the one trades use', async () => {
    const h = await walletBot()
    const main = await newWallet(h)
    const second = await newWallet(h)
    h.chain.fund(main.accountId, 2n * ONE)
    h.chain.fund(second.accountId, 3n * ONE)
    // A new wallet is selected on creation.
    await h.press('cw:home')
    expect(h.last()?.text).toContain('Wallet 2')
    expect(h.last()?.text).toContain(second.accountId)
    await h.press(`cw:sel:${main.id}`)
    expect(h.last()?.text).toContain('Main')
    expect(h.last()?.text).toContain(main.accountId)
    await h.press('cw:dep')
    expect(h.last()?.text).toContain('Main')
    expect(h.last()?.text).toContain(main.accountId)
    await h.press('cw:list')
    expect(h.last()?.text).toContain(`✅ 1. <b>Main</b>`)
    // Another user's wallet can't be selected.
    await h.press(`cw:sel:not-a-wallet`)
    expect((await h.wallet())?.id).toBe(main.id)
  })

  it('a withdrawal started on one wallet stays on it, even if another is selected meanwhile', async () => {
    const h = await walletBot()
    const a = await newWallet(h)
    const b = await newWallet(h)
    h.chain.fund(a.accountId, 3n * ONE)
    h.chain.fund(b.accountId, 3n * ONE)
    await h.press(`cw:sel:${a.id}`)
    await h.press('cw:wd')
    expect(h.last()?.text).toContain('Main')
    await h.press(h.button('NEAR ·'))
    await h.say('1')
    const toLinked = h.button('(linked)')
    // The user switches to wallet b before choosing the destination.
    await h.press(`cw:sel:${b.id}`)
    await h.press(toLinked)
    expect(h.last()?.text).toContain(`From <b>Main</b>`)
    const before = { a: h.chain.accounts.get(a.accountId)?.amount ?? 0n, b: h.chain.accounts.get(b.accountId)?.amount ?? 0n }
    await h.press(h.button('Confirm withdraw'))
    expect(h.last()?.text).toContain('Withdrawal confirmed')
    expect(h.chain.accounts.get(b.accountId)?.amount).toBe(before.b)
    expect(before.a - (h.chain.accounts.get(a.accountId)?.amount ?? 0n)).toBeGreaterThanOrEqual(ONE)
    expect(h.chain.sent.every((s) => s.tx.signerId === a.accountId)).toBe(true)
  })

  it('an old Recovery button acts only on the wallet it was shown for', async () => {
    const h = await walletBot()
    const a = await newWallet(h)
    const b = await newWallet(h)
    await h.press(`cr:delete:${a.id}`)
    const yes = h.button('Yes, delete it')
    expect(yes).toBe(`cr:deleteyes:${a.id}`)
    // The user selects b, then presses the old confirmation: only a is deleted.
    await h.press(`cw:sel:${b.id}`)
    await h.press(yes)
    expect((await h.custody.store.wallet(a.id))?.status).toBe('deleted')
    expect((await h.custody.store.wallet(b.id))?.status).toBe('active')
    // A button for another user's (or a closed) wallet does nothing.
    await h.press(`cr:deleteyes:${a.id}`)
    expect((await h.custody.store.wallet(b.id))?.status).toBe('active')
  })

  it('the backup key goes on the wallet it was offered for, and only that one', async () => {
    const owner = await ownerKeypair()
    const h = await walletBot({ linkedKey: owner.publicKey })
    const a = await newWallet(h)
    const b = await newWallet(h)
    h.chain.fund(a.accountId, 2n * ONE)
    h.chain.fund(b.accountId, 2n * ONE)
    await h.press(`cw:sel:${a.id}`) // a is selected; the Recovery screen of b is used
    await h.press(`cr:show:${b.id}`)
    expect(h.last()?.text).toContain('Wallet 2')
    await h.press(h.button('Add backup key'))
    expect(h.last()?.text).toContain('Wallet 2')
    await h.press(h.button('Add backup key'))
    expect(h.last()?.text).toContain('Backup key added')
    expect(h.chain.keysOf(b.accountId).sort()).toEqual([b.publicKey, owner.publicKey].sort())
    expect(h.chain.keysOf(a.accountId)).toEqual([a.publicKey])
    expect((await h.custody.store.wallet(b.id))?.backupKey).toBe(owner.publicKey)
    expect((await h.custody.store.wallet(a.id))?.backupKey).toBeNull()
    // And a's own backup key works the same, independently.
    await h.press(`cr:show:${a.id}`)
    await h.press(h.button('Add backup key'))
    await h.press(h.button('Add backup key'))
    expect(h.chain.keysOf(a.accountId).sort()).toEqual([a.publicKey, owner.publicKey].sort())
  })

  it('export is per wallet: the key exported for one wallet is that wallet’s alone', async () => {
    const owner = await ownerKeypair()
    const h = await walletBot({ linkedKey: owner.publicKey })
    const wallets = [await newWallet(h), await newWallet(h), await newWallet(h)]
    const third = wallets[2] as TradingWallet
    await h.press(`cw:sel:${wallets[0]?.id}`) // Main is selected; wallet 3's own Export button is used
    await h.press(`cr:export:${third.id}`)
    expect(h.last()?.text).toContain('Wallet 3')
    expect(h.buttons().find((b) => b.url)?.url).toBe(`https://nearkits.com/recover#wallet=${third.accountId}`)
    const routes = recoveryRoutes({ recovery: h.custody.recovery, onExported: async () => undefined, onDestinationApproved: async () => undefined })
    const secret = await exportAsOwner(
      {
        challenge: async (req) => (await routes['/api/recovery/challenge']?.(req, {} as never)) as ChallengeView,
        exportKey: async (p) => (await routes['/api/recovery/export']?.(p, {} as never)) as { sealed: unknown },
      },
      third.accountId,
      owner,
    )
    const raw = base58Decode(secret.slice('ed25519:'.length)) as Uint8Array
    const exportedPublic = `ed25519:${base58Encode(raw.subarray(32))}`
    expect(exportedPublic).toBe(third.publicKey)
    // Nothing of the other wallets: their public keys differ, and the key opens only this one.
    for (const other of wallets.slice(0, 2)) expect(other.publicKey).not.toBe(exportedPublic)
    const audit = await h.custody.store.auditOf(third.id)
    expect(audit.map((a) => a.action)).toContain('key-exported')
    for (const other of wallets.slice(0, 2)) expect((await h.custody.store.auditOf(other.id)).map((a) => a.action)).not.toContain('key-exported')
  })
})
