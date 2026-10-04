import { describe, expect, it } from 'vitest'
import {
  checkOwnerControl,
  implicitAccountOf,
  isEvmAddress,
  ownerControlProblem,
  ownerKeyNote,
  signedKeyProblem,
  walletAccounts,
  type KeyPermission,
  type OwnerControl,
} from './ownerAccount'

const OWNER = 'bottest.near'
/** bottest.near's only key: a full-access key of bottest.near, and the backup key of its NearKit wallet eb2f…. */
const OWNER_KEY = 'ed25519:G27MijJFPXLkWZC8fDnX2AvL1gq8jidmemvK8u9gid6b'
/** A NearKit wallet's own account: 64 hex characters, the implicit account of its NearKit key (not an EVM address). */
const IMPLICIT = 'eb2f3770f5da2d8de058988bcd3fef1a24a4262b0b3823fdb1045e0a8ca95672'
/** That wallet's NearKit key, as a wallet holds it after Recover exported it: not a key of bottest.near. */
const WALLET_KEY = 'ed25519:Gq4ZvDvpSENU2KvUM2aojmy7oopjQsim95dEzdhRpzPT'
/** A limited (function-call) key of bottest.near. */
const APP_KEY = 'ed25519:11111111111111111111111111111111'
/** An EVM address as wallets show it (checksummed, mixed case). */
const EVM = '0x52908400098527886E0F7030069857D2E4169EE7'
/** The same kind of address in NEAR's ETH-implicit form (lowercase): still an EVM address. */
const EVM_LOWER = `0x${'ab'.repeat(20)}`

/** The chain as the check reads it: bottest.near's keys. It records every lookup. */
function chain() {
  const keys: Record<string, KeyPermission> = { [OWNER_KEY]: 'full', [APP_KEY]: 'function-call' }
  const asked: string[] = []
  const permission = async (account: string, publicKey: string): Promise<KeyPermission> => {
    asked.push(`${account} ${publicKey}`)
    return account === OWNER ? (keys[publicKey] ?? 'missing') : 'missing'
  }
  return { permission, asked }
}
const down = async (): Promise<KeyPermission> => {
  throw new Error('NEAR RPC unavailable')
}
const refusal = (c: OwnerControl) => {
  if (c.ok) throw new Error(`expected a refusal, got ${JSON.stringify(c)}`)
  return c
}

describe('the NEAR accounts a wallet shares', () => {
  it('an EVM address (0x + 40 hex, any case) is never a NEAR account; a 64-character hex id is a NEAR implicit account', () => {
    expect(isEvmAddress(EVM)).toBe(true)
    expect(isEvmAddress(EVM_LOWER)).toBe(true)
    expect(isEvmAddress(IMPLICIT)).toBe(false)
    expect(isEvmAddress(OWNER)).toBe(false)
    expect(walletAccounts([EVM, IMPLICIT, EVM_LOWER, OWNER, 'Not An Account', IMPLICIT])).toEqual({ near: [IMPLICIT, OWNER], evm: [EVM, EVM_LOWER] })
  })

  it('the implicit account of an ed25519 key is its 32 bytes in hex: eb2f… is Gq4ZvD…’s, not bottest.near’s key’s', () => {
    expect(implicitAccountOf(WALLET_KEY)).toBe(IMPLICIT)
    expect(implicitAccountOf(OWNER_KEY)).toBe('df2812a648648f51a35d378ae8dd2fded95b88fec3c61ac4f9f9cdd938876fac')
    expect(implicitAccountOf('ed25519:short')).toBeNull()
    expect(implicitAccountOf('secp256k1:G27MijJFPXLkWZC8fDnX2AvL1gq8jidmemvK8u9gid6b')).toBeNull()
  })
})

describe('whether a wallet can sign for the owner: the owner account itself, or a full-access key of the owner on chain', () => {
  it('the owner account itself, by its exact id, first or not: allowed, and no key is looked up', async () => {
    const c = chain()
    expect(await checkOwnerControl({ accounts: [OWNER] }, OWNER, c.permission)).toEqual({ ok: true, via: 'account', account: OWNER })
    expect(await checkOwnerControl({ accounts: [IMPLICIT, OWNER], keys: [{ accountId: IMPLICIT, publicKey: WALLET_KEY }] }, OWNER, c.permission)).toEqual({
      ok: true,
      via: 'account',
      account: OWNER,
    })
    expect(c.asked).toEqual([])
  })

  it('eb2f… signing with its own key Gq4ZvD…: refused, naming the account and the key', async () => {
    const c = chain()
    const r = refusal(await checkOwnerControl({ accounts: [IMPLICIT], keys: [{ accountId: IMPLICIT, publicKey: WALLET_KEY }] }, OWNER, c.permission))
    expect(r).toEqual({ ok: false, reason: 'not-owner-key', account: IMPLICIT, publicKey: WALLET_KEY, permission: 'missing' })
    expect(c.asked).toEqual([`${OWNER} ${WALLET_KEY}`])
    expect(ownerControlProblem(r, OWNER)).toBe(
      `Your wallet is connected as ${IMPLICIT} and signs with ${WALLET_KEY}, which isn’t a key of ${OWNER}. Connect the wallet that holds ${OWNER}’s own key, then try again.`,
    )
    // On the page of that very NearKit wallet, with its own key: said as it is.
    expect(ownerControlProblem(r, OWNER, IMPLICIT)).toBe(
      `Your wallet is connected as ${IMPLICIT}, your NearKit wallet itself: it signs with that wallet’s exported key (${WALLET_KEY}), which isn’t a key of ${OWNER}. Connect the wallet that holds ${OWNER}’s own key, then try again.`,
    )
  })

  it('eb2f… signing with G27Mij…, a full-access key of bottest.near on chain: allowed as eb2f… (its id stays eb2f…: no account is taken for another)', async () => {
    const r = await checkOwnerControl({ accounts: [IMPLICIT], keys: [{ accountId: IMPLICIT, publicKey: OWNER_KEY }] }, OWNER, chain().permission)
    expect(r).toEqual({ ok: true, via: 'key', account: IMPLICIT, publicKey: OWNER_KEY })
    if (!r.ok || r.via !== 'key') throw new Error('expected an owner key')
    expect(ownerKeyNote(r, OWNER)).toBe(
      `Your wallet is connected as ${IMPLICIT}. It signs with ${OWNER_KEY}, a full-access key of ${OWNER}, so its signature counts as ${OWNER}’s.`,
    )
  })

  it('a limited (function-call) key of the owner: refused', async () => {
    const r = refusal(await checkOwnerControl({ accounts: [IMPLICIT], keys: [{ accountId: IMPLICIT, publicKey: APP_KEY }] }, OWNER, chain().permission))
    expect(r).toEqual({ ok: false, reason: 'not-owner-key', account: IMPLICIT, publicKey: APP_KEY, permission: 'function-call' })
    expect(ownerControlProblem(r, OWNER)).toBe(
      `Your wallet is connected as ${IMPLICIT} and signs with ${APP_KEY}, which is only a limited (function-call) key of ${OWNER}. Owner requests need a full-access key of ${OWNER}: connect the wallet that holds one, then try again.`,
    )
  })

  it('no key reported and not the owner: refused, without asking the chain', async () => {
    const c = chain()
    const r = refusal(await checkOwnerControl({ accounts: [IMPLICIT] }, OWNER, c.permission))
    expect(r).toEqual({ ok: false, reason: 'no-key', account: IMPLICIT })
    expect(c.asked).toEqual([])
    expect(ownerControlProblem(r, OWNER)).toBe(
      `Your wallet returned ${IMPLICIT}, not ${OWNER}, and didn’t say which key it signs with, so NearKit can’t tell whether it holds a key of ${OWNER}. Switch to ${OWNER} itself in your wallet; if it keeps returning the same account, remove NearKit from the wallet’s connected sites, then connect again.`,
    )
  })

  it('the chain can’t be asked: refused, never assumed', async () => {
    const r = refusal(await checkOwnerControl({ accounts: [IMPLICIT], keys: [{ accountId: IMPLICIT, publicKey: OWNER_KEY }] }, OWNER, down))
    expect(r).toEqual({ ok: false, reason: 'unchecked', account: IMPLICIT, publicKey: OWNER_KEY })
    expect(ownerControlProblem(r, OWNER)).toBe(
      `NearKit couldn’t check on chain whether ${OWNER_KEY} is a key of ${OWNER}: the network didn’t answer. Nothing was signed. Try again in a moment.`,
    )
  })

  it('several accounts: the first that signs with an owner key is used; a lookup that failed outweighs a "not a key" answer', async () => {
    const two = {
      accounts: [IMPLICIT, 'other.near'],
      keys: [
        { accountId: IMPLICIT, publicKey: WALLET_KEY },
        { accountId: 'other.near', publicKey: OWNER_KEY },
      ],
    }
    expect(await checkOwnerControl(two, OWNER, chain().permission)).toEqual({ ok: true, via: 'key', account: 'other.near', publicKey: OWNER_KEY })
    const flaky = async (_: string, publicKey: string): Promise<KeyPermission> => {
      if (publicKey === OWNER_KEY) throw new Error('NEAR RPC unavailable')
      return 'missing'
    }
    expect(await checkOwnerControl(two, OWNER, flaky)).toEqual({ ok: false, reason: 'unchecked', account: 'other.near', publicKey: OWNER_KEY })
  })

  it('nothing connected, an EVM address only, and ids that aren’t NEAR accounts (exact: no case folding, no trimming)', async () => {
    const c = chain()
    expect(await checkOwnerControl({ accounts: [] }, OWNER, c.permission)).toEqual({ ok: false, reason: 'none' })
    expect(await checkOwnerControl({ accounts: ['BotTest.near'] }, OWNER, c.permission)).toEqual({ ok: false, reason: 'none' })
    expect(await checkOwnerControl({ accounts: [` ${OWNER}`] }, OWNER, c.permission)).toEqual({ ok: false, reason: 'none' })
    const evm = refusal(await checkOwnerControl({ accounts: [EVM] }, OWNER, c.permission))
    expect(evm).toEqual({ ok: false, reason: 'evm-only', evm: EVM })
    expect(ownerControlProblem(evm, OWNER)).toBe(
      `Your wallet returned an EVM address (${EVM}), not a NEAR account. Switch to the NEAR account ${OWNER} in your wallet, then try again.`,
    )
    expect(ownerControlProblem({ ok: false, reason: 'none' }, OWNER)).toBe(`No NEAR account is connected. Connect ${OWNER}, the wallet this NearKit wallet was created with.`)
    expect(c.asked).toEqual([])
  })
})

describe('the key a signature was made with: the decisive check', () => {
  it('kept only when it is a full-access key of the owner on chain right now, whatever account the wallet names', async () => {
    expect(await signedKeyProblem(OWNER_KEY, OWNER, chain().permission)).toBeNull()
    for (const key of [WALLET_KEY, APP_KEY, 'not a key'])
      expect(await signedKeyProblem(key, OWNER, chain().permission)).toBe(
        `Your wallet signed with ${key}, which isn’t a full-access key of ${OWNER}. NearKit didn’t use that signature.`,
      )
    expect(await signedKeyProblem(OWNER_KEY, OWNER, down)).toBe(
      `NearKit couldn’t check on chain whether ${OWNER_KEY} is a key of ${OWNER}, so it didn’t use that signature. Try again in a moment.`,
    )
  })
})
