import { ChallengeError } from '../signer/errors'
import { walletName } from './limits'
import { recoveryError } from './recovery'
import type { TelegramRequestInput, TelegramRequestView, TradingSigner } from './signer'
import type { CustodyStore, TradingWallet } from './store'

/**
 * Approvals in NearKit's Telegram Mini App, for NearKit wallets with no owner wallet.
 *
 * The bot asks the signer for a request (a withdrawal address, or the wallet's first owner)
 * and gives the user a link to NearKit's Mini App with the request's digest as `startapp`.
 * The page shows the request only if it hashes to that digest; its Approve sends the launch
 * data Telegram signed for the user who opened it. This app relays that data and nothing
 * else: the signer checks Telegram's signature itself, so the app can't approve anything.
 */

const relay = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run()
  } catch (e) {
    throw recoveryError(e) ?? e
  }
}

export interface TelegramApprovalResult {
  kind: 'destination' | 'bind-owner'
  accountId: string
  target: string
  userId: number | null
  walletId: string | null
}

export function createTelegramApprovals(deps: { custody: CustodyStore; signer: TradingSigner; network: string; botUsername: string | (() => string) }) {
  const { custody, signer, network } = deps

  /** This app's copy follows the signer: an owner the signer bound is recorded here too. */
  async function syncOwner(w: TradingWallet): Promise<TradingWallet> {
    if (w.ownerAccount) return w
    const info = await signer.keyInfo(w.accountId).catch(() => null)
    if (info?.ownerAccount && (await custody.setOwner(w.id, info.ownerAccount, info.ownerKey)))
      await custody.audit({ userId: w.userId, walletId: w.id, action: 'owner-bound', detail: { owner: info.ownerAccount } })
    return (await custody.wallet(w.id)) ?? w
  }

  return {
    /** The Mini App link for a request: NearKit's bot, with the request's digest as `startapp`. */
    link: (r: Pick<TelegramRequestView, 'digest'>): string => `https://t.me/${typeof deps.botUsername === 'function' ? deps.botUsername() : deps.botUsername}?startapp=${r.digest}`,

    /** A new request for the wallet's Telegram account to approve. */
    async request(w: TradingWallet, input: TelegramRequestInput): Promise<TelegramRequestView> {
      try {
        return await signer.telegramRequest(input)
      } catch (e) {
        // The signer already knows an owner this copy missed: follow it.
        if (e instanceof ChallengeError && e.problem === 'owned') await syncOwner(w)
        throw recoveryError(e) ?? e
      }
    },

    /** The request behind a Mini App link, as the page shows it: public data only. */
    async view(digest: string) {
      const r = await relay(() => signer.telegramRequestView(digest))
      const w = r.request ? await custody.walletByAccount(network, r.request.accountId) : null
      return { ...r, walletName: w && w.status === 'active' ? walletName(w) : null }
    },

    /** The Mini App's Approve: Telegram's signed launch data, which the signer checks. */
    async approve(initData: string): Promise<TelegramApprovalResult> {
      const r = await relay(() => signer.telegramApprove(initData))
      let w = await custody.walletByAccount(network, r.accountId)
      if (w && r.kind === 'bind-owner') w = await syncOwner(w)
      else if (w) await custody.audit({ userId: w.userId, walletId: w.id, action: 'destination-approved', detail: { destination: r.target, approvedBy: 'telegram' } })
      return { ...r, userId: w?.userId ?? null, walletId: w?.id ?? null }
    },

    syncOwner,
  }
}

export type TelegramApprovals = ReturnType<typeof createTelegramApprovals>
