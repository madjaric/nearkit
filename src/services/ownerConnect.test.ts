import { describe, expect, it } from 'vitest'
import type { Session } from '@/types/domain'
import { NoNearAccountError } from './near/errors'
import { reconnectAs } from './ownerConnect'

const OWNER = 'bottest.near'
const IMPLICIT = 'eb2f3770f5da2d8de058988bcd3fef1a24a4262b0b3823fdb1045e0a8ca95672'
const EVM = '0x52908400098527886E0F7030069857D2E4169EE7'

const session = (accounts: string[]): Session => ({ accountId: accounts[0] ?? '', walletId: accounts[0] ?? '', connectedAt: 1, mode: 'near', walletName: 'Fake Wallet', accounts })

/** The wallet service as "Connect <owner>" uses it, answering each connect in turn; it records the calls. */
function wallets(...answers: (() => Session)[]) {
  const calls: string[] = []
  return {
    calls,
    service: {
      disconnect: async () => {
        calls.push('disconnect')
      },
      connect: async (walletId?: string) => {
        calls.push(`connect ${walletId}`)
        const next = answers.shift()
        if (!next) throw new Error('no answer scripted')
        return next()
      },
    },
  }
}

describe('Connect <owner>: a reconnect that must end on the owner', () => {
  it('signs the current session out before it connects, so the wallet can show its account picker', async () => {
    const w = wallets(() => session([OWNER]))
    expect(await reconnectAs(w.service, 'hot-wallet', OWNER)).toMatchObject({ ok: true, session: { accountId: OWNER } })
    expect(w.calls).toEqual(['disconnect', 'connect hot-wallet'])
  })

  it('another NEAR account back from the wallet is not a success: the result names that account', async () => {
    const w = wallets(() => session([IMPLICIT]))
    expect(await reconnectAs(w.service, 'hot-wallet', OWNER)).toEqual({ ok: false, mismatch: { ok: false, reason: 'other-account', account: IMPLICIT } })
    expect(w.calls).toEqual(['disconnect', 'connect hot-wallet'])
  })

  it('a wallet that shares only an EVM address: reported as an EVM address, not as an account', async () => {
    const w = wallets(() => {
      throw new NoNearAccountError([EVM])
    })
    expect(await reconnectAs(w.service, 'hot-wallet', OWNER)).toEqual({ ok: false, mismatch: { ok: false, reason: 'evm-only', evm: EVM } })
  })

  it('a rejected connect stays an error', async () => {
    const w = wallets(() => {
      throw new Error('User rejected the connection')
    })
    await expect(reconnectAs(w.service, 'hot-wallet', OWNER)).rejects.toThrow('User rejected the connection')
  })
})
