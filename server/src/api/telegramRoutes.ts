import type { TelegramApprovalResult, TelegramApprovals } from '../custody/telegramApprovals'
import type { Route } from './http'
import { field } from './linkRoutes'

/**
 * NearKit's Telegram Mini App (the NearKit web page Telegram opens inside the chat): the
 * request it shows, and its Approve. Approve carries Telegram's signed launch data; the
 * signer checks that signature itself, so this API only relays it. Responses hold public
 * data only.
 */
export function telegramRoutes(deps: {
  approvals: TelegramApprovals
  /** The wallet's Telegram user hears about every approval, in the bot. */
  onApproved: (r: TelegramApprovalResult & { userId: number; walletId: string }) => Promise<void>
}): Record<string, Route> {
  return {
    '/api/telegram/request': async (body) => deps.approvals.view(field(body, 'digest', 64)),
    '/api/telegram/approve': async (body) => {
      const r = await deps.approvals.approve(field(body, 'initData', 4096))
      // Telling Telegram is best effort; the approval already counts.
      if (r.userId !== null && r.walletId !== null) await deps.onApproved({ ...r, userId: r.userId, walletId: r.walletId }).catch(() => undefined)
      return { kind: r.kind, accountId: r.accountId, target: r.target }
    },
  }
}
