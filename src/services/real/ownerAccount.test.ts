import { describe, expect, it } from 'vitest'
import { parseEnv } from '@/config/env'
import { NETWORKS } from '@/config/networks'
import { NoNearAccountError } from '@/services/near/errors'
import type { WalletAdapter, WalletSession } from '@/services/near/wallet'
import { createNearServices } from './index'
import { memoryStorage } from './stores'
import { createFakeChain, fakeWallet } from './testing/fakeChain'

/**
 * The connected NEAR account, as Recover's owner requests depend on it: a wallet's EVM
 * addresses are never taken for NEAR accounts, and a signature for the owner is asked for only
 * while the wallet can sign for the owner (the owner account itself, or a full-access key of the
 * owner it reports), and kept only if the key that made it is a full-access key of the owner on
 * chain right now, whatever account the wallet names. No account is ever taken for another.
 * NearKit's signer checks the same again and decides.
 */

const OWNER = 'bottest.testnet'
/** The owner's own key: a full-access key of the owner, and the backup key of its NearKit wallet. */
const OWNER_KEY = 'ed25519:G27MijJFPXLkWZC8fDnX2AvL1gq8jidmemvK8u9gid6b'
/** A NearKit wallet's own account: the implicit account of its NearKit key. */
const IMPLICIT = 'eb2f3770f5da2d8de058988bcd3fef1a24a4262b0b3823fdb1045e0a8ca95672'
/** That wallet's NearKit key, as a wallet holds it after Recover exported it: not a key of the owner. */
const WALLET_KEY = 'ed25519:Gq4ZvDvpSENU2KvUM2aojmy7oopjQsim95dEzdhRpzPT'
/** A limited (function-call) key of the owner. */
const APP_KEY = 'ed25519:11111111111111111111111111111111'
const EVM = '0x52908400098527886E0F7030069857D2E4169EE7'
const ONE = 10n ** 24n

/** What a wallet shares: its accounts, and the key it says each one signs with. */
const session = (accounts: string[], keys: Record<string, string> = {}): WalletSession => ({
  walletId: 'fake',
  walletName: 'Fake Wallet',
  accounts,
  batch: true,
  keys: Object.entries(keys).map(([accountId, publicKey]) => ({ accountId, publicKey })),
})
const request = { message: 'NEARKITS owner request', recipient: 'nearkit.example', nonce: new Uint8Array(32), accountId: OWNER }

/**
 * NearKit web's wallet service on a fake chain where the owner holds its own key (and a limited app
 * key) and its NearKit wallet eb2f… holds its NearKit key plus the owner's key as its backup key.
 * The wallet signs with `signsWith` (default: the owner's key) and names `claims` as the account it
 * signed as (default: the account it was asked for), as a wallet signing with its active account does.
 */
function setup(start: WalletSession, opts: { signsWith?: string; claims?: string } = {}) {
  const kv = memoryStorage()
  const chain = createFakeChain({
    accounts: {
      [OWNER]: { amount: ONE, keys: { [OWNER_KEY]: 'full', [APP_KEY]: 'function-call' } },
      [IMPLICIT]: { amount: ONE, keys: { [WALLET_KEY]: 'full', [OWNER_KEY]: 'full' } },
    },
  })
  /** While true, every key lookup fails as an unreachable network would. */
  let keysDown = false
  const fetch: typeof chain.fetch = async (input, init) => {
    if (keysDown && String(init?.body ?? '').includes('view_access_key')) throw new TypeError('Failed to fetch')
    return chain.fetch(input, init)
  }
  const { env } = parseEnv({ VITE_NEAR_NETWORK: 'testnet' })
  const wallet = fakeWallet(start, undefined, async () => ({ publicKey: opts.signsWith ?? OWNER_KEY, signature: 'c2lnbmF0dXJl' }))
  const asked: string[] = []
  const adapter: WalletAdapter = {
    ...wallet.adapter,
    signMessage: async (signerId, req) => {
      asked.push(signerId)
      const signed = await wallet.adapter.signMessage(signerId, req)
      return opts.claims === undefined ? signed : { ...signed, accountId: opts.claims }
    },
  }
  const open = () => createNearServices({ env, network: NETWORKS.testnet, fetch, kv, wallet: async () => adapter })
  /** `reload`: the same browser after a reload (what NearKit stored, and the wallet's session, are still there). */
  return { services: open(), reload: open, wallet, asked, setKeysDown: (v: boolean) => (keysDown = v) }
}

describe('the connected NEAR account', () => {
  it('a wallet that shares only an EVM address is not connected as a NEAR account: NEARKITS keeps no session and says so', async () => {
    const { services, wallet } = setup(session([EVM]))
    const failed = await services.wallets.connect('fake').catch((e: unknown) => e)
    expect(failed).toBeInstanceOf(NoNearAccountError)
    expect((failed as NoNearAccountError).evm).toEqual([EVM])
    expect((failed as Error).message).toContain(`an EVM address (${EVM}), not a NEAR account`)
    expect(await services.wallets.getSession()).toBeNull()
    // The wallet session NearKit can't use is signed out, not left behind.
    expect(await wallet.adapter.session()).toBeNull()
  })

  it('EVM values a wallet lists next to NEAR accounts are left out: the session is the first NEAR account', async () => {
    const { services } = setup(session([EVM, IMPLICIT]))
    expect(await services.wallets.connect('fake')).toMatchObject({ accountId: IMPLICIT, accounts: [IMPLICIT] })
  })

  it('Connect bottest.near on a wallet that lists eb2f… first and bottest.near after it: the session is bottest.near’s, also after a reload', async () => {
    const { services, reload } = setup(session([IMPLICIT, OWNER]))
    expect(await services.wallets.connect('fake', { account: OWNER })).toMatchObject({ accountId: OWNER, accounts: [IMPLICIT, OWNER] })
    expect(await reload().wallets.getSession()).toMatchObject({ accountId: OWNER })
  })

  it('a plain connect is the wallet’s own first account, and an account the wallet doesn’t share is never the session’s', async () => {
    const { services, wallet } = setup(session([IMPLICIT, OWNER]))
    await services.wallets.connect('fake', { account: OWNER })
    expect(await services.wallets.connect('fake')).toMatchObject({ accountId: IMPLICIT })
    // Only eb2f… now: asking for bottest.near by name doesn't make eb2f… bottest.near.
    wallet.setSession(session([IMPLICIT]))
    expect(await services.wallets.connect('fake', { account: OWNER })).toMatchObject({ accountId: IMPLICIT, accounts: [IMPLICIT] })
  })

  it('the key the wallet reports for its account is kept for the owner check, which reads it on chain: eb2f… with the owner’s key can sign for the owner, as eb2f…', async () => {
    const { services } = setup(session([IMPLICIT], { [IMPLICIT]: OWNER_KEY }))
    expect(await services.wallets.connect('fake')).toMatchObject({ accountId: IMPLICIT })
    expect(await services.wallets.ownerControl(OWNER)).toEqual({ ok: true, via: 'key', account: IMPLICIT, publicKey: OWNER_KEY })
    // eb2f… with its own key: not the owner's.
    const own = setup(session([IMPLICIT], { [IMPLICIT]: WALLET_KEY }))
    await own.services.wallets.connect('fake')
    expect(await own.services.wallets.ownerControl(OWNER)).toEqual({ ok: false, reason: 'not-owner-key', account: IMPLICIT, publicKey: WALLET_KEY, permission: 'missing' })
  })
})

describe('signing for the owner', () => {
  it('checks the wallet right before signing: without the owner account or an owner key, nothing is asked of the wallet', async () => {
    const { services, wallet, asked } = setup(session([OWNER]))
    await services.wallets.connect('fake')
    // The wallet moved to the NearKit wallet's account after it connected, and says no key.
    wallet.setSession(session([IMPLICIT]))
    await expect(services.wallets.signMessage(request)).rejects.toThrow(`Your wallet returned ${IMPLICIT}, not ${OWNER}, and didn’t say which key it signs with`)
    // With the NearKit wallet's own key.
    wallet.setSession(session([IMPLICIT], { [IMPLICIT]: WALLET_KEY }))
    await expect(services.wallets.signMessage(request)).rejects.toThrow(`Your wallet is connected as ${IMPLICIT} and signs with ${WALLET_KEY}, which isn’t a key of ${OWNER}.`)
    // And on an EVM address only.
    wallet.setSession(session([EVM]))
    await expect(services.wallets.signMessage(request)).rejects.toThrow(`Your wallet returned an EVM address (${EVM}), not a NEAR account.`)
    expect(asked).toEqual([])
  })

  it('reports G27Mij… but signs with Gq4ZvD…: the signature is discarded, nothing is sent', async () => {
    const { services, asked } = setup(session([IMPLICIT], { [IMPLICIT]: OWNER_KEY }), { signsWith: WALLET_KEY })
    await services.wallets.connect('fake')
    await expect(services.wallets.signMessage(request)).rejects.toThrow(
      `Your wallet signed with ${WALLET_KEY}, which isn’t a full-access key of ${OWNER}. NEARKITS didn’t use that signature.`,
    )
    expect(asked).toEqual([IMPLICIT])
  })

  it('signs with G27Mij… while reporting eb2f…: kept and handed on, as eb2f…’s signature made with the owner’s key', async () => {
    const { services, asked } = setup(session([IMPLICIT], { [IMPLICIT]: OWNER_KEY }))
    await services.wallets.connect('fake')
    expect(await services.wallets.signMessage(request)).toEqual({ accountId: IMPLICIT, publicKey: OWNER_KEY, signature: 'c2lnbmF0dXJl' })
    // Asked of the wallet's own account: no account is taken for the owner.
    expect(asked).toEqual([IMPLICIT])
  })

  it('reports bottest.near but signs with a key that isn’t bottest.near’s (another account’s, or only a limited one): discarded', async () => {
    for (const key of [WALLET_KEY, APP_KEY]) {
      const { services, asked } = setup(session([OWNER]), { signsWith: key })
      await services.wallets.connect('fake')
      await expect(services.wallets.signMessage(request)).rejects.toThrow(
        `Your wallet signed with ${key}, which isn’t a full-access key of ${OWNER}. NEARKITS didn’t use that signature.`,
      )
      expect(asked).toEqual([OWNER])
    }
  })

  it('signs as the owner while the wallet shares the owner account, first or not, with the owner’s key', async () => {
    const { services, asked } = setup(session([OWNER]))
    await services.wallets.connect('fake')
    expect(await services.wallets.signMessage(request)).toMatchObject({ accountId: OWNER, publicKey: OWNER_KEY })
    const after = setup(session([IMPLICIT, OWNER]))
    await after.services.wallets.connect('fake')
    expect(await after.services.wallets.signMessage(request)).toMatchObject({ accountId: OWNER, publicKey: OWNER_KEY })
    expect([...asked, ...after.asked]).toEqual([OWNER, OWNER])
  })

  it('the chain can’t be asked: refused before signing, and a signature already made is not used', async () => {
    const before = setup(session([IMPLICIT], { [IMPLICIT]: OWNER_KEY }))
    await before.services.wallets.connect('fake')
    before.setKeysDown(true)
    await expect(before.services.wallets.signMessage(request)).rejects.toThrow(`NEARKITS couldn’t check on chain whether ${OWNER_KEY} is a key of ${OWNER}`)
    expect(before.asked).toEqual([])
    // The owner account itself needs no lookup before signing; the signature's key is still checked after.
    const after = setup(session([OWNER]))
    await after.services.wallets.connect('fake')
    after.setKeysDown(true)
    await expect(after.services.wallets.signMessage(request)).rejects.toThrow(
      `NEARKITS couldn’t check on chain whether ${OWNER_KEY} is a key of ${OWNER}, so it didn’t use that signature. Try again in a moment.`,
    )
    expect(after.asked).toEqual([OWNER])
  })

  it('the session keeps what the wallet returned, for the user to see: every account it shared, with its key', async () => {
    const shared: WalletSession = {
      ...session([IMPLICIT]),
      provider: [{ accountId: IMPLICIT, publicKey: WALLET_KEY, extra: ['label=bottest.near'] }],
    }
    const { services } = setup(shared)
    const s = await services.wallets.connect('fake')
    expect(s.walletDetails).toEqual([{ accountId: IMPLICIT, publicKey: WALLET_KEY, extra: ['label=bottest.near'] }])
    // A display name the wallet sends is shown, never used: the account is still eb2f….
    expect(s.accountId).toBe(IMPLICIT)
  })
})
