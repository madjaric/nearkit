import { describe, expect, it } from 'vitest'
import type { Session } from '@/types/domain'
import { identityOf } from './identity'
import type { NearKitEndedSession, NearKitWebSession } from './nearkitWeb'

/**
 * Who the user is, asked once for every page: a browser wallet, a NEARKITS web session (the
 * custodial NEARKITS wallets, signed in from the bot's /web link), both, or nobody. Most real
 * activity comes from users with only the NEARKITS session: they are signed in, not "not connected".
 */

const WALLET: Session = { accountId: 'alice.near', walletId: 'alice.near', connectedAt: 1, mode: 'near' }
const WEB: NearKitWebSession = { token: 'T'.repeat(43), expiresAt: 2, userName: 'Tess', userHandle: 'tess' }
const ENDED: NearKitEndedSession = { userName: 'Tess', userHandle: 'tess', at: 1 }
const read = (o: { wallet?: Session | null; walletPending?: boolean; nearkit?: NearKitWebSession | null; ended?: NearKitEndedSession | null }) => ({
  wallet: o.wallet ?? null,
  walletPending: o.walletPending ?? false,
  nearkit: o.nearkit ?? null,
  ended: o.ended ?? null,
})

describe('who the user is', () => {
  it('a NEARKITS web session alone signs the user in, where the page takes NEARKITS wallets', () => {
    expect(identityOf(read({ nearkit: WEB }), { custodial: true })).toEqual({ kind: 'signed-in', wallet: null, nearkit: WEB })
  })

  it('a browser wallet signs the user in everywhere; with a NEARKITS session too, both count', () => {
    expect(identityOf(read({ wallet: WALLET }), { custodial: false })).toEqual({ kind: 'signed-in', wallet: WALLET, nearkit: null })
    expect(identityOf(read({ wallet: WALLET, nearkit: WEB }), { custodial: true })).toEqual({ kind: 'signed-in', wallet: WALLET, nearkit: WEB })
  })

  it('a page that takes only a browser wallet doesn’t count the NEARKITS session', () => {
    expect(identityOf(read({ nearkit: WEB }), { custodial: false })).toEqual({ kind: 'signed-out' })
    expect(identityOf(read({ ended: ENDED }), { custodial: false })).toEqual({ kind: 'signed-out' })
  })

  it('a NEARKITS session that ended (expired, or signed out from Telegram) is said so, not "connect a wallet"', () => {
    expect(identityOf(read({ ended: ENDED }), { custodial: true })).toEqual({ kind: 'session-ended', ended: ENDED })
    // A browser wallet still signs the user in.
    expect(identityOf(read({ wallet: WALLET, ended: ENDED }), { custodial: true })).toEqual({ kind: 'signed-in', wallet: WALLET, nearkit: null })
  })

  it('nobody: signed out', () => {
    expect(identityOf(read({}), { custodial: true })).toEqual({ kind: 'signed-out' })
  })

  it('while the browser wallet is restored: pending, unless a NEARKITS session already answers (the top bar waits for the wallet)', () => {
    expect(identityOf(read({ walletPending: true }), { custodial: true })).toEqual({ kind: 'pending' })
    expect(identityOf(read({ walletPending: true, ended: ENDED }), { custodial: true })).toEqual({ kind: 'pending' })
    expect(identityOf(read({ walletPending: true, nearkit: WEB }), { custodial: true })).toEqual({ kind: 'signed-in', wallet: null, nearkit: WEB })
    expect(identityOf(read({ walletPending: true, nearkit: WEB }), { custodial: true, waitForWallet: true })).toEqual({ kind: 'pending' })
    expect(identityOf(read({ walletPending: true, nearkit: WEB }), { custodial: false })).toEqual({ kind: 'pending' })
  })
})
