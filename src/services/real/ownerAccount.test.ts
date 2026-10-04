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
 * addresses are never taken for NEAR accounts, and a signature for the owner is asked for
 * only while the wallet is on the owner, and kept only if the wallet signed as the owner.
 */

const OWNER = 'bottest.testnet'
/** A NearKit wallet's own account, as a wallet holding its exported key shows it. */
const IMPLICIT = 'eb2f3770f5da2d8de058988bcd3fef1a24a4262b0b3823fdb1045e0a8ca95672'
const EVM = '0x52908400098527886E0F7030069857D2E4169EE7'
const ONE = 10n ** 24n

const session = (accounts: string[]): WalletSession => ({ walletId: 'fake', walletName: 'Fake Wallet', accounts, batch: true })
const request = { message: 'NearKit owner request', recipient: 'nearkit.example', nonce: new Uint8Array(32), accountId: OWNER }

/** NearKit web's wallet service on a fake chain, with a wallet that signs messages as `signsAs` (default: the account asked for). */
function setup(start: WalletSession, signsAs?: string) {
  const chain = createFakeChain({ accounts: { [OWNER]: { amount: ONE }, [IMPLICIT]: { amount: ONE } } })
  const { env } = parseEnv({ VITE_NEAR_NETWORK: 'testnet' })
  const wallet = fakeWallet(start, undefined, async () => ({ publicKey: 'ed25519:11111111111111111111111111111111', signature: 'c2lnbmF0dXJl' }))
  const asked: string[] = []
  const adapter: WalletAdapter = {
    ...wallet.adapter,
    signMessage: async (signerId, req) => {
      asked.push(signerId)
      const signed = await wallet.adapter.signMessage(signerId, req)
      return signsAs === undefined ? signed : { ...signed, accountId: signsAs }
    },
  }
  const services = createNearServices({ env, network: NETWORKS.testnet, fetch: chain.fetch, kv: memoryStorage(), wallet: async () => adapter })
  return { services, wallet, asked }
}

describe('the connected NEAR account', () => {
  it('a wallet that shares only an EVM address is not connected as a NEAR account: NearKit keeps no session and says so', async () => {
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
})

describe('signing for the owner', () => {
  it('checks the wallet’s active account right before signing: on another account nothing is asked of the wallet', async () => {
    const { services, wallet, asked } = setup(session([OWNER]))
    await services.wallets.connect('fake')
    // The wallet moved to the NearKit wallet's account after it connected.
    wallet.setSession(session([IMPLICIT]))
    await expect(services.wallets.signMessage(request)).rejects.toThrow(`Your wallet returned ${IMPLICIT}, not ${OWNER}. Switch to ${OWNER} in your wallet, then try again.`)
    // And on an EVM address only.
    wallet.setSession(session([EVM]))
    await expect(services.wallets.signMessage(request)).rejects.toThrow(`Your wallet returned an EVM address (${EVM}), not a NEAR account.`)
    expect(asked).toEqual([])
  })

  it('a signature the wallet made as another account is refused, never handed on', async () => {
    const { services, asked } = setup(session([OWNER]), IMPLICIT)
    await services.wallets.connect('fake')
    await expect(services.wallets.signMessage(request)).rejects.toThrow(`Your wallet returned ${IMPLICIT}, not ${OWNER}.`)
    expect(asked).toEqual([OWNER])
  })

  it('signs as the owner while the owner is the active NEAR account', async () => {
    const { services, asked } = setup(session([OWNER]))
    await services.wallets.connect('fake')
    expect(await services.wallets.signMessage(request)).toMatchObject({ accountId: OWNER })
    expect(asked).toEqual([OWNER])
  })
})
