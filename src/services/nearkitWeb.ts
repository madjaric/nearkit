import type { BotDetail, BotSummary } from '@/lib/volumeBot/api'
import type { BotConfig } from '@/lib/volumeBot/types'
import { apiPost, LinkRequestError } from './telegramLink'

/**
 * NearKit web's side of the user's NearKit wallets (custody; the server half is
 * server/src/web/). The bot's /web command sends a one-time link; the code in its fragment
 * becomes a session kept in this browser, per network. With it the page lists the user's
 * NearKit wallets, creates and renames them, and trades and sends from them directly.
 *
 * The session is the authorization, and the server decides the rest: which wallets are the
 * user's (watch accounts and other users' wallets are refused), the quote, the fee, the
 * destinations allowed. NearKit's server executes each wallet's own transactions with that
 * wallet's key, held by its signer. Nothing here holds or sees a key, and nothing needs Telegram.
 */

export interface NearKitWebSession {
  token: string
  expiresAt: number
  userName: string
  /** The Telegram @username the session belongs to, when the account has one. */
  userHandle: string | null
}

export interface NearKitWebWallet {
  /** The server's id for it (every call names the wallet by this). */
  id: string
  accountId: string
  name: string
  slot: number
  /** The owner wallet it answers to; null: controlled by the user's Telegram account. */
  owner: string | null
  frozen: boolean
  createdAt: number
}

export interface NearKitWalletList {
  wallets: NearKitWebWallet[]
  limit: number
  canCreate: boolean
}

export type WebLegStatus = 'quoted' | 'requoted' | 'executing' | 'processing' | 'done' | 'failed' | 'cancelled' | 'expired'

export interface WebTradeLeg {
  /** This wallet's current quote: what Execute confirms (a new price has a new id). */
  intentId: string
  walletId: string
  accountId: string
  name: string
  amountIn: string
  /** Raw units of the output token. */
  amountOut: string
  minOut: string
  need: string | null
  available: string | null
  /** Yocto for registrations the trade makes first. */
  registration: string
  status: WebLegStatus
  received: string | null
  message: string | null
  hashes: string[]
  expiresAt: number
}

export interface WebTradeGroup {
  groupId: string
  side: 'buy' | 'sell'
  token: string
  symbol: string
  decimals: number
  /** NearKit's fee on this route (none on testnet). */
  fee: { charged: boolean; bps: number }
  path: string[]
  networkFeeNear: string
  priceImpactPct: number | null
  busy: boolean
  expiresAt: number
  legs: WebTradeLeg[]
}

export interface WebSendReview {
  walletId: string
  from: string
  accountId: string
  asset: string
  symbol: string
  decimals: number
  /** Raw units. */
  amount: string
  to: string
  linked: boolean
  /** The destination is another of the user's NEARKITS wallets under the same owner (its name): no approval is needed. */
  sibling?: string | null
  feeNear: string
  registration: string | null
  fresh: boolean
}

export interface WebSendStatus {
  status: WebLegStatus
  message: string | null
  hashes: string[]
}

export interface WebTradeInput {
  side: 'buy' | 'sell'
  token: string
  slippagePct: number
  /** The server's wallet ids, each with an exact decimal amount (NEAR for a buy, the token for a sell). */
  legs: { walletId: string; amountIn: string }[]
}

export interface WebSendInput {
  walletId: string
  /** 'near' or a token contract. */
  token: string
  /** An exact decimal amount, or 'max': the most the wallet can send, decided by the server. */
  amount: string
  to: string
}

/** Why a send can't go to an address yet, and how it gets approved (the signer enforces it). */
export type SendApproval = { kind: 'owner'; owner: string; accountId: string } | { kind: 'telegram'; url: string }

export interface NearKitWeb {
  /** A NearKit server is configured for this build. */
  readonly available: boolean
  session(): NearKitWebSession | null
  login(code: string): Promise<NearKitWebSession>
  /**
   * Redeems a sign-in link's code without signing this browser in: the link may be someone
   * else's, so its owner first sees whose account it opens (`adopt` or `discard`).
   */
  redeem(code: string): Promise<NearKitWebSession>
  /** Signs in with a redeemed session; the one it replaces is ended on the server. */
  adopt(s: NearKitWebSession): Promise<void>
  /** Ends a redeemed session on the server, unused; this browser keeps its own. */
  discard(s: NearKitWebSession): Promise<void>
  /** Ends the session on the server when it can, and here always. */
  logout(): Promise<void>
  /** Null when signed out. */
  wallets(): Promise<NearKitWalletList | null>
  createWallet(name: string, createKey: string): Promise<NearKitWebWallet>
  renameWallet(walletId: string, name: string): Promise<NearKitWebWallet>
  /** Deletes a wallet holding nothing of value (never funded, or only NEAR dust); answers the dust left on chain, in yoctoNEAR. */
  deleteWallet(walletId: string): Promise<{ dustYocto: string }>
  /** Lists the user's NearKit wallets in this order (exactly their wallets, each once); returns them so. */
  orderWallets(walletIds: readonly string[]): Promise<NearKitWebWallet[]>
  /** The server's quote for each wallet: what the review shows. Nothing is signed. */
  prepareTrade(input: WebTradeInput): Promise<WebTradeGroup>
  /** Runs the quotes the user confirmed (by id); the server executes each wallet's own trade. */
  executeTrade(groupId: string, intentIds: readonly string[]): Promise<{ started: number }>
  cancelTrade(groupId: string): Promise<{ cancelled: number }>
  tradeStatus(groupId: string): Promise<WebTradeGroup>
  /** The server's review of a send (amount, destination, fee); nothing is sent. */
  reviewSend(input: WebSendInput): Promise<{ intentId: string; expiresAt: number; review: WebSendReview }>
  /** Sends exactly what was reviewed. */
  executeSend(intentId: string): Promise<{ started: boolean }>
  sendStatus(intentId: string): Promise<WebSendStatus>
  /** The user's Volume Bots on this network. */
  bots(): Promise<BotSummary[]>
  /** Creates a bot (no id) or changes a stopped one's configuration; nothing trades until Start. Refusals carry `detail.issues`, field by field. */
  saveBot(config: BotConfig, botId?: string): Promise<BotSummary>
  botDetail(botId: string): Promise<BotDetail>
  startBot(botId: string): Promise<BotSummary>
  pauseBot(botId: string): Promise<BotSummary>
  resumeBot(botId: string): Promise<BotSummary>
  /** Nothing new is sent from now on; trades already sent are settled, then it ends stopped. */
  stopBot(botId: string, emergency: boolean): Promise<BotSummary>
  deleteBot(botId: string): Promise<void>
  /** Called whenever the session starts or ends. */
  subscribe(listener: () => void): () => void
}

/** `#login=<code>` → code; anything else → null. The fragment never reaches a server log. */
export function readLoginCode(hash: string): string | null {
  const m = /^#login=([A-Za-z0-9_-]{43})$/.exec(hash)
  return m ? (m[1] as string) : null
}

/** One Create press's key: the server makes one wallet for it, however often it arrives. */
export function newCreateKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** How long a wallet list is reused: every page and service asks, the server rate-limits. */
const LIST_TTL_MS = 10_000

/** Where the session is kept (the real services' key-value store has this shape). */
export interface SessionStore {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

/** localStorage, guarded: storage may be blocked (private mode); then the session lasts as long as the page. */
function localStore(): SessionStore {
  const memory = new Map<string, string>()
  const ls = (): Storage | null => {
    try {
      return globalThis.localStorage ?? null
    } catch {
      return null
    }
  }
  return {
    get(key) {
      try {
        return ls()?.getItem(key) ?? memory.get(key) ?? null
      } catch {
        return memory.get(key) ?? null
      }
    },
    set(key, value) {
      memory.set(key, value)
      try {
        ls()?.setItem(key, value)
      } catch {
        // kept in memory
      }
    },
    remove(key) {
      memory.delete(key)
      try {
        ls()?.removeItem(key)
      } catch {
        // gone from memory
      }
    },
  }
}

export function createNearKitWeb(options: { apiUrl: string | null; network: string; fetchImpl?: typeof fetch; store?: SessionStore; now?: () => number }): NearKitWeb {
  const { apiUrl } = options
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const now = options.now ?? Date.now
  const store = options.store ?? localStore()
  const key = `nearkit:web-session:${options.network}`
  const listeners = new Set<() => void>()
  let listed: { token: string; at: number; value: Promise<NearKitWalletList> } | null = null

  const emit = () => {
    for (const l of listeners) l()
  }
  const save = (s: NearKitWebSession | null) => {
    listed = null
    if (s) store.set(key, JSON.stringify(s))
    else store.remove(key)
    emit()
  }

  // The same object while nothing changed: React reads it as an external store's snapshot.
  let read: { raw: string | null; expiresAt: number; value: NearKitWebSession | null } = { raw: null, expiresAt: Infinity, value: null }
  function session(): NearKitWebSession | null {
    const raw = store.get(key)
    if (raw === read.raw && now() < read.expiresAt) return read.value
    const value = parse(raw)
    read = { raw, expiresAt: value?.expiresAt ?? Infinity, value }
    return value
  }

  function parse(raw: string | null): NearKitWebSession | null {
    if (!raw) return null
    try {
      const s = JSON.parse(raw) as Partial<NearKitWebSession>
      if (typeof s.token !== 'string' || typeof s.expiresAt !== 'number' || s.expiresAt <= now()) return null
      return {
        token: s.token,
        expiresAt: s.expiresAt,
        userName: typeof s.userName === 'string' ? s.userName : 'NEARKITS user',
        userHandle: typeof s.userHandle === 'string' ? s.userHandle : null,
      }
    } catch {
      return null
    }
  }

  const unavailable = () => new LinkRequestError(0, 'unavailable', 'This NEARKITS build has no NEARKITS server, so NEARKITS wallets aren’t available here.')

  async function redeem(code: string): Promise<NearKitWebSession> {
    if (!apiUrl) throw unavailable()
    const r = await apiPost<{ token: string; expiresAt: number; user: { name: string; username?: string | null } }>(apiUrl, '/api/web/login', { code }, fetchImpl)
    return { token: r.token, expiresAt: r.expiresAt, userName: r.user.name, userHandle: typeof r.user.username === 'string' ? r.user.username : null }
  }

  async function adopt(s: NearKitWebSession): Promise<void> {
    const replaced = session()
    save(s)
    if (apiUrl && replaced && replaced.token !== s.token) await apiPost(apiUrl, '/api/web/logout', { session: replaced.token }, fetchImpl).catch(() => undefined)
  }
  const signedOut = () => new LinkRequestError(401, 'session', 'Sign in to NEARKITS web first: send /web to the NEARKITS bot in Telegram.')

  /** A call with the session; a session the server ended is forgotten here at once. */
  async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    if (!apiUrl) throw unavailable()
    const s = session()
    if (!s) throw signedOut()
    try {
      return await apiPost<T>(apiUrl, path, { session: s.token, ...body }, fetchImpl)
    } catch (e) {
      if (e instanceof LinkRequestError && e.status === 401) save(null)
      throw e
    }
  }

  return {
    available: apiUrl !== null,
    session,

    async login(code) {
      const s = await redeem(code)
      await adopt(s)
      return s
    },

    redeem,
    adopt,

    async discard(s) {
      if (apiUrl) await apiPost(apiUrl, '/api/web/logout', { session: s.token }, fetchImpl).catch(() => undefined)
    },

    async logout() {
      const s = session()
      if (apiUrl && s) await apiPost(apiUrl, '/api/web/logout', { session: s.token }, fetchImpl).catch(() => undefined)
      save(null)
    },

    async wallets() {
      const s = apiUrl ? session() : null
      if (!s) return null
      if (listed && listed.token === s.token && now() - listed.at < LIST_TTL_MS) return listed.value
      const value = call<NearKitWalletList>('/api/web/wallets', {})
      listed = { token: s.token, at: now(), value }
      value.catch(() => {
        if (listed?.value === value) listed = null
      })
      return value
    },

    async createWallet(name, createKey) {
      const r = await call<{ wallet: NearKitWebWallet }>('/api/web/wallets/create', { name, createKey })
      listed = null
      return r.wallet
    },

    async renameWallet(walletId, name) {
      const r = await call<{ wallet: NearKitWebWallet }>('/api/web/wallets/rename', { walletId, name })
      listed = null
      return r.wallet
    },

    async deleteWallet(walletId) {
      const r = await call<{ deleted: boolean; dustYocto?: string }>('/api/web/wallets/delete', { walletId })
      listed = null
      return { dustYocto: r.dustYocto ?? '0' }
    },

    async orderWallets(walletIds) {
      const r = await call<{ wallets: NearKitWebWallet[] }>('/api/web/wallets/order', { walletIds: [...walletIds] })
      listed = null
      return r.wallets
    },

    prepareTrade: (input) => call<WebTradeGroup>('/api/web/trade/quote', { ...input }),
    executeTrade: (groupId, intentIds) => call<{ started: number }>('/api/web/trade/execute', { groupId, intentIds: [...intentIds] }),
    cancelTrade: (groupId) => call<{ cancelled: number }>('/api/web/trade/cancel', { groupId }),
    tradeStatus: (groupId) => call<WebTradeGroup>('/api/web/trade/status', { groupId }),
    reviewSend: (input) => call<{ intentId: string; expiresAt: number; review: WebSendReview }>('/api/web/send/review', { ...input }),
    executeSend: (intentId) => call<{ started: boolean }>('/api/web/send/execute', { intentId }),
    sendStatus: (intentId) => call<WebSendStatus>('/api/web/send/status', { intentId }),

    bots: async () => (await call<{ bots: BotSummary[] }>('/api/web/bots', {})).bots,
    saveBot: async (config, botId) => (await call<{ bot: BotSummary }>('/api/web/bots/save', botId ? { config, botId } : { config })).bot,
    botDetail: (botId) => call<BotDetail>('/api/web/bots/detail', { botId }),
    startBot: async (botId) => (await call<{ bot: BotSummary }>('/api/web/bots/start', { botId })).bot,
    pauseBot: async (botId) => (await call<{ bot: BotSummary }>('/api/web/bots/pause', { botId })).bot,
    resumeBot: async (botId) => (await call<{ bot: BotSummary }>('/api/web/bots/resume', { botId })).bot,
    stopBot: async (botId, emergency) => (await call<{ bot: BotSummary }>('/api/web/bots/stop', { botId, emergency })).bot,
    deleteBot: async (botId) => void (await call<{ deleted: boolean }>('/api/web/bots/delete', { botId })),

    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}
