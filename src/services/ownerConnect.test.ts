import { describe, expect, it } from 'vitest'
import type { OwnerControl } from '@/lib/ownerAccount'
import type { Session } from '@/types/domain'
import { NoNearAccountError } from './near/errors'
import { reconnectAs } from './ownerConnect'

const OWNER = 'bottest.near'
const OWNER_KEY = 'ed25519:G27MijJFPXLkWZC8fDnX2AvL1gq8jidmemvK8u9gid6b'
const IMPLICIT = 'eb2f3770f5da2d8de058988bcd3fef1a24a4262b0b3823fdb1045e0a8ca95672'
const WALLET_KEY = 'ed25519:Gq4ZvDvpSENU2KvUM2aojmy7oopjQsim95dEzdhRpzPT'
const EVM = '0x52908400098527886E0F7030069857D2E4169EE7'

const session = (accounts: string[]): Session => ({ accountId: accounts[0] ?? '', walletId: accounts[0] ?? '', connectedAt: 1, mode: 'near', walletName: 'Fake Wallet', accounts })

/**
 * The wallet service as "Connect <owner>" uses it: it answers each connect in turn, and its owner
 * check (key-based, tested with the service) answers as scripted. It records the calls.
 */
function wallets(connect: () => Session, control: OwnerControl = { ok: true, via: 'account', account: OWNER }) {
  const calls: string[] = []
  return {
    calls,
    service: {
      disconnect: async () => {
        calls.push('disconnect')
      },
      connect: async (walletId?: string, options?: { account?: string }) => {
        calls.push(options?.account ? `connect ${walletId} as ${options.account}` : `connect ${walletId}`)
        return connect()
      },
      ownerControl: async (owner: string) => {
        calls.push(`check ${owner}`)
        return control
      },
    },
  }
}

describe('Connect <owner>: a reconnect that must end on a wallet that can sign for the owner', () => {
  it('signs the current session out, connects asking for the owner by name, then checks the wallet against the owner', async () => {
    const w = wallets(() => session([OWNER]))
    expect(await reconnectAs(w.service, 'hot-wallet', OWNER)).toMatchObject({ ok: true, session: { accountId: OWNER }, control: { via: 'account', account: OWNER } })
    expect(w.calls).toEqual(['disconnect', `connect hot-wallet as ${OWNER}`, `check ${OWNER}`])
  })

  it('a wallet that can’t sign for the owner is not a success: the result says why and keeps what the wallet returned', async () => {
    const refused: OwnerControl = { ok: false, reason: 'not-owner-key', account: IMPLICIT, publicKey: WALLET_KEY, permission: 'missing' }
    const w = wallets(() => session([IMPLICIT]), refused)
    expect(await reconnectAs(w.service, 'hot-wallet', OWNER)).toEqual({ ok: false, mismatch: refused, session: session([IMPLICIT]) })
  })

  it('a wallet that signs with an owner key under another account id: a success, as that account (it is never taken for the owner)', async () => {
    const byKey: OwnerControl = { ok: true, via: 'key', account: IMPLICIT, publicKey: OWNER_KEY }
    const r = await reconnectAs(wallets(() => session([IMPLICIT]), byKey).service, 'hot-wallet', OWNER)
    expect(r).toEqual({ ok: true, session: session([IMPLICIT]), control: byKey })
  })

  it('a wallet that shares only an EVM address: reported as an EVM address, not as an account, and no key is checked', async () => {
    const w = wallets(() => {
      throw new NoNearAccountError([EVM])
    })
    expect(await reconnectAs(w.service, 'hot-wallet', OWNER)).toEqual({ ok: false, mismatch: { ok: false, reason: 'evm-only', evm: EVM }, session: null })
    expect(w.calls).toEqual(['disconnect', `connect hot-wallet as ${OWNER}`])
  })

  it('a rejected connect stays an error', async () => {
    const w = wallets(() => {
      throw new Error('User rejected the connection')
    })
    await expect(reconnectAs(w.service, 'hot-wallet', OWNER)).rejects.toThrow('User rejected the connection')
  })
})
