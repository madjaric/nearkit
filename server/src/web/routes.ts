import { NATIVE_TOKEN_ID, NEAR_DECIMALS, type NetworkConfig } from '@/config/networks'
import { formatUnits, tryParseUnits } from '@/lib/amounts'
import { mapLimit } from '@/lib/async'
import { MAX_SLIPPAGE } from '@/lib/fees'
import { accountIdError } from '@/lib/validation'
import { toNearKitError } from '@/services/near/errors'
import { HttpError, type Route } from '../api/http'
import { field } from '../api/linkRoutes'
import { btn, copyBtn, keyboard } from '../bot/context'
import { parseSlippage } from '../bot/settings'
import { friendlyError } from '../bot/ui'
import { MAX_ACTIVE_WALLETS_PER_USER, MAX_WALLET_LABEL, walletName } from '../custody/limits'
import type { Intent, IntentKind, TradingWallet } from '../custody/store'
import { SWAP_QUOTE_TTL_MS, type SwapParams, type SwapQuote } from '../custody/swap'
import { createTradingWallet, ownerForNewWallet, readWallet, WalletLimitError, type CustodyDeps } from '../custody/wallets'
import { checkDestinationSyntax, maxNearWithdraw, reviewWithdraw, WITHDRAW_TTL_MS, type WithdrawInput, type WithdrawReview } from '../custody/withdraw'
import type { Store } from '../db/store'
import { randomToken } from '../ids'
import type { Logger } from '../log'
import type { ServerNear } from '../near'
import { bold, esc, plainText, shortAccount } from '../telegram/html'
import type { InlineKeyboard } from '../telegram/types'
import { startRun, WEB_CHAT, WEB_CONCURRENCY } from './execute'
import { latestOf, legStatus, legView, tradeFacts } from './multi'
import type { WebSessions } from './sessions'

/**
 * NearKit web's API for the signed-in Telegram user's NearKit wallets. Every call carries the
 * session token in its JSON body, and the session is the authorization: NearKit web trades and
 * sends on its own, with no Telegram step.
 *
 * The server decides everything a client could claim. A wallet is only ever one of the session
 * user's own active NearKit wallets, looked up by that user; a watch account, another user's
 * wallet, an address or a made-up id is refused before anything is read. The client never says
 * what a wallet is, who signs, which destinations are allowed or what the fee is.
 *
 * Trades and sends run through the engine, as a Confirm in Telegram does: a fresh route with
 * funds, gas and registration checks, the kill switches and freezes, the signer's policy (Rhea's
 * route, NearKit's fee, approved destinations) and the wallet's own key, held by the signer.
 */

export interface WebWallet {
  id: string
  accountId: string
  name: string
  slot: number
  /** The owner wallet it answers to; null: controlled by the user's Telegram account. */
  owner: string | null
  frozen: boolean
  createdAt: number
}

export interface WebApiDeps {
  sessions: WebSessions
  custody: CustodyDeps
  store: Store
  /** Token metadata and balances, read from chain. */
  near: ServerNear
  network: NetworkConfig
  now: () => number
  /** Whether the signer checks this bot's Mini App approvals (wallets with no owner need them). */
  approvalsOn: () => Promise<boolean>
  linkedAccount: (userId: number) => Promise<string | null>
  /** A message to the user in Telegram (security notices only); false when it couldn't be delivered. */
  notify: (userId: number, html: string, markup?: InlineKeyboard) => Promise<boolean>
  log: Logger
}

interface LegInput {
  walletId: string
  amountIn: string
}

/** A trade's legs: 1 to MAX_ACTIVE_WALLETS_PER_USER, each a wallet once, with its amount. Anything else a leg carries is ignored. */
function legsOf(body: unknown): LegInput[] {
  const raw = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).legs : undefined
  const bad = () => new HttpError(400, 'legs', `Choose 1 to ${MAX_ACTIVE_WALLETS_PER_USER} NearKit wallets, each once, each with an amount.`)
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ACTIVE_WALLETS_PER_USER) throw bad()
  const legs = raw.map((l: unknown): LegInput => {
    const o = typeof l === 'object' && l !== null ? (l as Record<string, unknown>) : {}
    const { walletId, amountIn } = o
    if (typeof walletId !== 'string' || !walletId || walletId.length > 64 || typeof amountIn !== 'string' || !amountIn.trim() || amountIn.length > 40) throw bad()
    return { walletId, amountIn: amountIn.trim() }
  })
  if (new Set(legs.map((l) => l.walletId)).size !== legs.length) throw bad()
  return legs
}

/** A token contract, as its NEP-141 metadata on chain describes it; 400 for anything else. */
async function tokenOf(near: ServerNear, raw: string): Promise<{ contract: string; symbol: string; decimals: number }> {
  const contract = raw.trim().toLowerCase()
  if (contract === NATIVE_TOKEN_ID || accountIdError(contract)) throw new HttpError(400, 'token', 'That isn’t a token contract.')
  const meta = await near.ctx.reader.metadata(contract).catch(() => null)
  if (!meta) throw new HttpError(400, 'token', 'NearKit can’t read that token from chain. Check the contract, or try again in a moment.')
  return { contract, symbol: meta.symbol, decimals: meta.decimals }
}

export const webWalletView = (w: TradingWallet): WebWallet => ({
  id: w.id,
  accountId: w.accountId,
  name: walletName(w),
  slot: w.slot,
  owner: w.ownerAccount,
  frozen: w.frozenAt !== null,
  createdAt: w.createdAt,
})

/** A wallet's display name: one line of plain text, at most MAX_WALLET_LABEL characters. Empty or absent: the default name. */
function nameOf(body: unknown): string | null {
  const raw = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).name : undefined
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string' || raw.length > 200) throw new HttpError(400, 'name', `A wallet name is 1 to ${MAX_WALLET_LABEL} characters.`)
  const name = plainText(raw, 200)
  if (!name) return null
  if ([...name].length > MAX_WALLET_LABEL) throw new HttpError(400, 'name', `A wallet name is 1 to ${MAX_WALLET_LABEL} characters.`)
  return name
}

const CREATE_KEY = /^[A-Za-z0-9_-]{8,64}$/

const frozenError = (w: TradingWallet) =>
  new HttpError(
    409,
    'frozen',
    `${walletName(w)} is frozen by NearKit for your protection: it doesn’t trade or send. Its owner wallet can still add the backup key or export the key.`,
  )

/** A send's state for the web; `requoted`: something the review showed changed, so it must be reviewed again. */
function sendStatus(intent: Intent, now: number, requoted: boolean) {
  const s = legStatus(intent, now, requoted)
  return { status: s, message: intent.status === 'failed' ? (intent.result?.message ?? null) : null, hashes: intent.result?.hashes ?? [] }
}

export function webRoutes(deps: WebApiDeps): Record<string, Route> {
  const { custody } = deps
  /** The signed-in user; 401 for a missing, forged, expired or signed-out session. */
  const userOf = async (body: unknown): Promise<number> => {
    const userId = await deps.sessions.userOf(field(body, 'session', 64))
    if (userId === null) throw new HttpError(401, 'session', 'Your NearKit web session has ended. Sign in again: send /web to the NearKit bot.')
    return userId
  }
  /** One of the user's own active NearKit wallets; 403 for anything else. */
  const ownWallet = async (userId: number, walletId: string): Promise<TradingWallet> => {
    const w = await custody.store.ownedWallet(userId, walletId)
    if (!w) throw new HttpError(403, 'not-executable', 'That isn’t one of your NearKit wallets. Watch-only and other accounts can’t be used here.')
    return w
  }
  /** A kill switch for this kind of action, whatever the wallet; 409 when it's on. */
  const notPaused = async (kind: IntentKind) => {
    const blocked = await custody.ops.blocked(kind, null)
    if (blocked) throw new HttpError(409, 'paused', blocked)
  }
  /** The user's intents of a group (404 for anyone else's), each at its latest quote. */
  const groupOf = async (userId: number, body: unknown) => {
    const groupId = field(body, 'groupId', 32)
    const intents = (await custody.store.intentsOfGroup(groupId)).filter((i) => i.userId === userId)
    if (!intents.length) throw new HttpError(404, 'not-found', 'That trade isn’t one of yours, or it’s gone.')
    return { groupId, intents, latest: await Promise.all(intents.map((i) => latestOf(custody.store, i))) }
  }
  /** A send the user reviewed (404 for anyone else's). */
  const sendOf = async (userId: number, body: unknown) => {
    const intent = await custody.store.intent(field(body, 'intentId', 64))
    if (!intent || intent.userId !== userId || intent.kind !== 'withdraw') throw new HttpError(404, 'not-found', 'That send isn’t one of yours, or it’s gone.')
    return intent
  }

  return {
    '/api/web/login': async (body) => {
      const s = await deps.sessions.redeem(field(body, 'code', 64))
      if (!s) throw new HttpError(401, 'login', 'That sign-in link expired or was already used. Get a new one: send /web to the NearKit bot.')
      const user = await deps.store.getUser(s.userId)
      return { token: s.token, expiresAt: s.expiresAt, user: { name: user?.firstName ?? 'NearKit user' } }
    },

    '/api/web/logout': async (body) => {
      await deps.sessions.revoke(field(body, 'session', 64))
      return { ok: true }
    },

    '/api/web/wallets': async (body) => {
      const userId = await userOf(body)
      const wallets = await custody.store.activeWallets(userId, deps.network.id)
      return { wallets: wallets.map(webWalletView), limit: MAX_ACTIVE_WALLETS_PER_USER, canCreate: wallets.length < MAX_ACTIVE_WALLETS_PER_USER }
    },

    '/api/web/wallets/create': async (body) => {
      const userId = await userOf(body)
      const name = nameOf(body)
      const createKey = field(body, 'createKey', 64)
      if (!CREATE_KEY.test(createKey)) throw new HttpError(400, 'bad-request', 'Missing or invalid "createKey"')
      // The bot's owner rule: the user's existing owner, else their linked wallet, else none (Telegram-controlled).
      const owner = await ownerForNewWallet(custody, deps.store, {
        userId,
        network: deps.network.id,
        linked: await deps.linkedAccount(userId),
        approvalsOn: deps.approvalsOn,
      })
      if (owner === undefined) throw new HttpError(409, 'needs-link', 'This NearKit server needs an owner wallet for new NearKit wallets: link one in Telegram first (/link).')
      let created: { wallet: TradingWallet; created: boolean }
      try {
        // Web keys are namespaced: they never collide with a Telegram Create button's.
        created = await createTradingWallet(custody, userId, deps.network.id, deps.now(), owner, `web:${createKey}`)
      } catch (e) {
        if (e instanceof WalletLimitError) throw new HttpError(409, 'limit', e.message)
        throw e
      }
      if (created.created && name) await custody.store.setLabel(created.wallet.id, name)
      const wallet = (await custody.store.ownedWallet(userId, created.wallet.id)) ?? created.wallet
      // A security notice, not a step: nothing waits for it. The address is shortened on screen as plain
      // text (Telegram copies monospace on tap, so <code> would copy the short form); the Copy key is the
      // only copy action and hands Telegram the full account id from the wallet record.
      if (created.created)
        await deps
          .notify(
            userId,
            [
              `🆕 ${bold('NearKit wallet created on NearKit web')}`,
              `${bold(walletName(wallet))} ${esc(shortAccount(wallet.accountId))}`,
              'If this wasn’t you, sign out of NearKit web everywhere.',
            ].join('\n'),
            keyboard([copyBtn('📋 Copy address', wallet.accountId), btn('👛 My wallets', 'cw:list')], [btn('🚪 Sign out of NearKit web everywhere', 'web:out')]),
          )
          .catch(() => undefined)
      return { wallet: webWalletView(wallet) }
    },

    '/api/web/wallets/rename': async (body) => {
      const userId = await userOf(body)
      const wallet = await ownWallet(userId, field(body, 'walletId', 64))
      const name = nameOf(body)
      // Only the label changes: the account, its key, its owner and what the signer allows stay as they are.
      await custody.store.setLabel(wallet.id, name)
      return { wallet: webWalletView({ ...wallet, label: name }) }
    },

    /**
     * A buy or sell from one or more of the user's NearKit wallets: the server quotes each wallet
     * for the review (one intent each). Nothing is signed or sent here.
     */
    '/api/web/trade/quote': async (body) => {
      const userId = await userOf(body)
      const b = body as Record<string, unknown>
      const side = b.side === 'buy' || b.side === 'sell' ? b.side : null
      if (!side) throw new HttpError(400, 'bad-request', 'Missing or invalid "side"')
      const legsIn = legsOf(body)
      // Every leg is one of this user's own NearKit wallets, checked before anything is read or quoted.
      const picked: { leg: LegInput; wallet: TradingWallet }[] = []
      for (const leg of legsIn) picked.push({ leg, wallet: await ownWallet(userId, leg.walletId) })
      // In the wallets' own order, as the Wallets page lists them.
      picked.sort((x, y) => x.wallet.slot - y.wallet.slot)
      const wallets = picked.map((p) => p.wallet)
      const frozen = wallets.find((w) => w.frozenAt !== null)
      if (frozen) throw frozenError(frozen)
      await notPaused(side)
      const slippagePct = typeof b.slippagePct === 'number' && Number.isFinite(b.slippagePct) ? parseSlippage(String(b.slippagePct)) : null
      if (slippagePct === null) throw new HttpError(400, 'slippage', `Slippage is above 0 and at most ${MAX_SLIPPAGE}%, with at most two decimals.`)
      const token = await tokenOf(deps.near, field(body, 'token', 64))
      const inDecimals = side === 'buy' ? NEAR_DECIMALS : token.decimals
      const params = picked.map(({ leg, wallet }): SwapParams => {
        const parsed = tryParseUnits(leg.amountIn, inDecimals)
        if (!parsed.ok || parsed.value <= 0n)
          throw new HttpError(400, 'amount', `${walletName(wallet)}: ${plainText(leg.amountIn, 40)} is not an amount above 0 with at most ${inDecimals} decimals.`)
        return { side, token: token.contract, symbol: token.symbol, decimals: token.decimals, amountIn: leg.amountIn, slippagePct }
      })
      let quotes: SwapQuote[]
      try {
        quotes = await mapLimit(wallets, WEB_CONCURRENCY, (w, i) => custody.swaps.quote(params[i] as SwapParams, w))
      } catch (e) {
        throw new HttpError(502, 'quote', `${friendlyError(e, { network: deps.network.id, side, log: deps.log, context: 'web quote failed' })} Nothing was prepared.`)
      }
      const groupId = randomToken(12)
      const intents: Intent[] = []
      for (const [i, w] of wallets.entries()) {
        // One live quote per wallet, as in the bot: an older quote can't trade any more.
        await custody.store.cancelQuoted(w.id, ['buy', 'sell'])
        intents.push(
          await custody.store.createIntent({ walletId: w.id, userId, chatId: WEB_CHAT, kind: side, params: params[i], quote: quotes[i], ttlMs: SWAP_QUOTE_TTL_MS, groupId }),
        )
      }
      const now = deps.now()
      return {
        groupId,
        side,
        token: token.contract,
        symbol: token.symbol,
        decimals: token.decimals,
        ...tradeFacts(intents),
        legs: intents.map((intent, i) => legView(intent, wallets[i] as TradingWallet, now)),
      }
    },

    /**
     * Runs the quotes the web confirms (by id): each wallet's own trade through the engine,
     * after this returns. A leg whose price moved past its minimum is quoted again, with a new
     * id the web only learns from the status it shows, so a worse price never runs unseen.
     */
    '/api/web/trade/execute': async (body) => {
      const userId = await userOf(body)
      const { latest } = await groupOf(userId, body)
      const raw = (body as Record<string, unknown>).intentIds
      if (!Array.isArray(raw) || raw.length > MAX_ACTIVE_WALLETS_PER_USER || raw.some((x) => typeof x !== 'string'))
        throw new HttpError(400, 'bad-request', 'Missing or invalid "intentIds"')
      const confirmed = new Set(raw as string[])
      const now = deps.now()
      const open = latest.map((l) => l.intent).filter((i) => confirmed.has(i.id) && i.status === 'quoted' && i.expiresAt > now)
      if (!open.length) throw new HttpError(409, 'nothing-open', 'Nothing left to run: it ran, was cancelled, or its quote expired. Get a fresh quote.')
      await notPaused((open[0] as Intent).kind)
      startRun(custody, open, userId, deps.log)
      return { started: open.length }
    },

    /** Cancels a trade's quotes still waiting; nothing was sent from them. */
    '/api/web/trade/cancel': async (body) => {
      const userId = await userOf(body)
      const { groupId, latest } = await groupOf(userId, body)
      let cancelled = await custody.store.cancelGroup(groupId, userId)
      // New quotes of legs whose price moved belong to the trade too.
      for (const l of latest) if (l.requoted && (await custody.store.setStatus(l.intent.id, ['quoted'], 'cancelled'))) cancelled++
      return { cancelled }
    },

    /** Where each wallet's trade stands (read-only). */
    '/api/web/trade/status': async (body) => {
      const userId = await userOf(body)
      const { groupId, intents, latest } = await groupOf(userId, body)
      const now = deps.now()
      const legs = []
      for (const [i, l] of latest.entries()) {
        const wallet = await custody.store.wallet((intents[i] as Intent).walletId)
        if (wallet) legs.push(legView(l.intent, wallet, now, l.requoted))
      }
      const p = (intents[0] as Intent).params as unknown as SwapParams
      return { groupId, side: p.side, token: p.token, symbol: p.symbol, decimals: p.decimals, ...tradeFacts(latest.map((l) => l.intent)), legs }
    },

    /**
     * Reviews a send from a NearKit wallet, as the bot's withdrawal review does, and holds it for
     * the web's Send. Only to the wallet's owner or an address approved for it: the signer
     * enforces that rule itself, and an unapproved address gets how it can be approved.
     */
    '/api/web/send/review': async (body) => {
      const userId = await userOf(body)
      const wallet = await ownWallet(userId, field(body, 'walletId', 64))
      if (wallet.frozenAt !== null) throw frozenError(wallet)
      await notPaused('withdraw')
      const asset = field(body, 'token', 64).trim().toLowerCase()
      const token = asset === NATIVE_TOKEN_ID ? { contract: NATIVE_TOKEN_ID, symbol: 'NEAR', decimals: NEAR_DECIMALS } : await tokenOf(deps.near, asset)
      // "max": the most this wallet can send, decided here from chain (for NEAR, the network fee stays).
      const amountText = field(body, 'amount', 40).trim()
      const wantsMax = amountText.toLowerCase() === 'max'
      const parsed = wantsMax ? null : tryParseUnits(amountText, token.decimals)
      if (parsed && (!parsed.ok || parsed.value <= 0n)) throw new HttpError(400, 'amount', `Send an amount above 0 with at most ${token.decimals} decimals.`)
      let to: string
      try {
        to = checkDestinationSyntax(plainText(field(body, 'to', 128), 128), deps.network, wallet, token.contract)
      } catch (e) {
        throw new HttpError(400, 'to', toNearKitError(e).message)
      }
      const max =
        token.contract === NATIVE_TOKEN_ID
          ? await readWallet(deps.near, wallet).then((v) => (v.near === null ? null : maxNearWithdraw(v.near)))
          : await deps.near.ctx.reader.balanceOf(token.contract, wallet.accountId).catch(() => null)
      if (max === null) throw new HttpError(503, 'chain', 'The NEAR network isn’t answering right now. Try again in a moment.')
      const amount = parsed?.ok ? parsed.value : max
      if (amount <= 0n) throw new HttpError(400, 'amount', `${walletName(wallet)} has no ${token.symbol} it can send.`)
      if (amount > max)
        throw new HttpError(
          400,
          'amount',
          `${walletName(wallet)} can send at most ${formatUnits(max, token.decimals, { maxFraction: 6 })} ${token.symbol}${token.contract === NATIVE_TOKEN_ID ? ' (a little stays for the network fee)' : ''}.`,
        )
      const input: WithdrawInput = {
        asset: token.contract,
        symbol: token.symbol,
        decimals: token.decimals,
        amount: amount.toString(),
        to,
        linked: to === (await deps.linkedAccount(userId)),
      }
      let review: WithdrawReview
      try {
        review = await reviewWithdraw(deps.near, deps.network, wallet, input)
      } catch (e) {
        throw new HttpError(400, 'to', toNearKitError(e).message)
      }
      // The custody rule the signer enforces: the owner, or an address approved for this wallet.
      const approved = to === wallet.ownerAccount || (await custody.signer.destinations(wallet.accountId)).destinations.some((d) => d.destination === to)
      if (!approved) {
        if (wallet.ownerAccount)
          throw new HttpError(
            409,
            'needs-approval',
            `${to} isn’t approved for ${walletName(wallet)} yet. Its owner wallet approves an address once, with a signature on NearKit web.`,
            {
              kind: 'owner',
              owner: wallet.ownerAccount,
              accountId: wallet.accountId,
            },
          )
        const r = await custody.telegram.request(wallet, { kind: 'destination', accountId: wallet.accountId, destination: to })
        throw new HttpError(
          409,
          'needs-approval',
          `${to} isn’t approved for ${walletName(wallet)} yet. This wallet has no owner wallet, so its Telegram account approves a new address once, in NearKit’s mini app (Telegram signs the approval).`,
          { kind: 'telegram', url: custody.telegram.link(r) },
        )
      }
      const intent = await custody.store.createIntent({ walletId: wallet.id, userId, chatId: WEB_CHAT, kind: 'withdraw', params: input, quote: review, ttlMs: WITHDRAW_TTL_MS })
      return {
        intentId: intent.id,
        expiresAt: intent.expiresAt,
        review: {
          walletId: wallet.id,
          from: walletName(wallet),
          accountId: wallet.accountId,
          asset: input.asset,
          symbol: input.symbol,
          decimals: input.decimals,
          amount: input.amount,
          to,
          linked: input.linked,
          feeNear: review.feeNear,
          registration: review.registration,
          fresh: review.fresh,
        },
      }
    },

    /** Sends a reviewed send through the engine, after this returns. */
    '/api/web/send/execute': async (body) => {
      const userId = await userOf(body)
      // Exactly what was reviewed: a review the engine replaced (something changed) is reviewed again first.
      const intent = await sendOf(userId, body)
      await notPaused('withdraw')
      if (intent.status !== 'quoted' || intent.expiresAt <= deps.now())
        throw new HttpError(409, 'nothing-open', 'That send isn’t waiting any more: it ran, or its review expired. Review it again.')
      startRun(custody, [intent], userId, deps.log)
      return { started: true }
    },

    '/api/web/send/status': async (body) => {
      const userId = await userOf(body)
      const { intent, requoted } = await latestOf(custody.store, await sendOf(userId, body))
      return sendStatus(intent, deps.now(), requoted)
    },
  }
}
