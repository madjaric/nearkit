import { NATIVE_TOKEN_ID, NEAR_DECIMALS } from '@/config/networks'
import { formatUnits } from '@/lib/amounts'
import { mapLimit } from '@/lib/async'
import { truncateMiddle } from '@/lib/format'
import { checkOwnerControl, ownerControlProblem, signedKeyProblem, walletAccounts } from '@/lib/ownerAccount'
import { accountIdError, accountKind, isForeignToNetwork } from '@/lib/validation'
import { accountState } from '@/services/near/account'
import { NearKitError, NoNearAccountError, toNearKitError } from '@/services/near/errors'
import { explorerAccountUrl } from '@/services/near/explorer'
import { accessKeyPermission } from '@/services/near/nep413'
import type { SignedMessageResult, WalletSession } from '@/services/near/wallet'
import type { Holding, PresetInput, Session, Wallet, WalletPreset, WalletSnapshot } from '@/types/domain'
import { canExecute, executableWallets } from '@/lib/wallets'
import type { NearKitWeb } from '../nearkitWeb'
import type { WalletService } from '../types'
import type { NearContext } from './context'
import type { Market } from './market'

/** Default label: "Main" for the connected account, else the first name segment or a short hex. */
function defaultLabel(accountId: string, isMain: boolean): string {
  if (isMain) return 'Main'
  if (accountKind(accountId) !== 'named') return truncateMiddle(accountId, 6, 4)
  return accountId.split('.')[0] ?? accountId
}

const display = (raw: bigint, decimals: number) => Number(formatUnits(raw, decimals))

export function createWalletService(ctx: NearContext, market: Market, nearkit: NearKitWeb | null = null): WalletService {
  /**
   * The session for what the wallet shared: its NEAR accounts only (EVM addresses are never one);
   * null when it shared none. Its account is the one the user connected for by name while the
   * wallet shares exactly it (Connect <owner>), else the wallet's first NEAR account.
   */
  const toSession = async (s: WalletSession): Promise<Session | null> => {
    const accounts = walletAccounts(s.accounts).near
    const chosen = ctx.stores.walletAccount.get()
    const accountId = chosen !== null && accounts.includes(chosen) ? chosen : accounts[0]
    if (accountId === undefined) return null
    let issue: Session['issue'] = null
    if (isForeignToNetwork(accountId, ctx.network.id)) issue = 'network-mismatch'
    else {
      const state = await accountState(ctx.rpc, accountId).catch(() => null)
      if (state && !state.exists) issue = 'account-missing'
    }
    for (const id of accounts) ctx.stores.book.upsert({ accountId: id, label: '', origin: 'known', addedAt: ctx.now() })
    return {
      accountId,
      walletId: accountId,
      connectedAt: ctx.now(),
      mode: 'near',
      walletName: s.walletName,
      accounts,
      ...(s.provider ? { walletDetails: s.provider } : {}),
      issue,
      explorerUrl: issue === 'network-mismatch' ? null : explorerAccountUrl(ctx.network, accountId),
    }
  }

  /** A key's permission on an account, read on chain now. */
  const keyPermission = (account: string, publicKey: string) => accessKeyPermission(ctx.rpc, account, publicKey)

  /** The owner check on what the wallet shares right now: its accounts, and the key it says each signs with. */
  const ownerControl = async (owner: string) => {
    const adapter = await ctx.wallet()
    const live = await adapter.session().catch(() => null)
    return checkOwnerControl({ accounts: live?.accounts ?? [], keys: live?.keys }, owner, keyPermission)
  }

  /** One restore for every caller: reads that start together on page load all wait for it. */
  let restoring: Promise<void> | null = null

  async function currentSession(): Promise<Session | null> {
    if (!ctx.session.restored) {
      restoring ??= (async () => {
        const adapter = await ctx.wallet()
        const restored = await adapter.restore().catch(() => null)
        const session = restored ? await toSession(restored) : null
        // A connect or disconnect that finished meanwhile is newer: keep it.
        if (!ctx.session.restored) {
          ctx.session.current = session
          ctx.session.restored = true
        }
      })().finally(() => {
        restoring = null
      })
      await restoring
    }
    return ctx.session.current
  }

  /**
   * The signed-in Telegram user's NearKit wallets, as NearKit's server lists them (it decides
   * which are the user's). None when signed out, or while the server can't be reached.
   */
  async function nearkitWallets(): Promise<Wallet[]> {
    const list = nearkit ? await nearkit.wallets().catch(() => null) : null
    return (list?.wallets ?? [])
      .filter((w) => !isForeignToNetwork(w.accountId, ctx.network.id))
      .map((w) => ({
        id: w.accountId,
        label: w.name,
        accountId: w.accountId,
        kind: accountKind(w.accountId) === 'named' ? 'named' : 'implicit',
        isMain: false,
        access: 'signer',
        source: 'nearkit',
        nearkitId: w.id,
        owner: w.owner,
        frozen: w.frozen,
      }))
  }

  async function wallets(): Promise<Wallet[]> {
    const [session, own] = await Promise.all([currentSession(), nearkitWallets()])
    if (!session) return own
    // A NearKit wallet also in the account book (added to watch it before) is listed once, as what it is.
    const mine = new Set(own.map((w) => w.accountId))
    const signers = new Set(session.accounts ?? [session.accountId])
    const book = ctx.stores.book.list()
    const ids = [...new Set([...(session.accounts ?? [session.accountId]), ...book.map((e) => e.accountId)])]
    const others: Wallet[] = ids
      .filter((id) => !isForeignToNetwork(id, ctx.network.id) && !mine.has(id))
      .map((accountId) => {
        const isMain = accountId === session.accountId
        const entry = book.find((e) => e.accountId === accountId)
        return {
          id: accountId,
          label: entry?.label || defaultLabel(accountId, isMain),
          accountId,
          kind: accountKind(accountId) === 'named' ? 'named' : 'implicit',
          isMain,
          access: signers.has(accountId) ? 'signer' : 'watch',
          source: signers.has(accountId) ? 'external' : 'watch',
        }
      })
    return [...own, ...others]
  }

  /** Balances of exactly these wallets, read from chain. */
  async function snapshotsOf(list: Wallet[]): Promise<WalletSnapshot[]> {
    const [balances, tokens] = await Promise.all([mapLimit(list, 3, (w) => ctx.balances.get(w.accountId)), market.listTokens()])
    const byId = new Map(tokens.map((t) => [t.id, t]))
    // Tokens held but not yet listed (discovered): fetch their metadata once.
    const missing = [...new Set(balances.flatMap((b) => b.fts.map((f) => f.contract)).filter((c) => !byId.has(c)))]
    const extra = missing.length ? await market.listTokens(missing) : []
    for (const t of extra) byId.set(t.id, t)
    return list.map((w, i) => {
      const b = balances[i]
      const nearRaw = b?.state?.availableYocto ?? 0n
      const holdings: Holding[] = [
        ...(nearRaw > 0n ? [{ walletId: w.id, tokenId: NATIVE_TOKEN_ID, amount: display(nearRaw, NEAR_DECIMALS), raw: nearRaw.toString(), verified: b?.state !== null }] : []),
        ...(b?.fts ?? []).flatMap((f) => {
          const token = byId.get(f.contract)
          return token ? [{ walletId: w.id, tokenId: f.contract, amount: display(f.raw, token.decimals), raw: f.raw.toString(), verified: f.verified }] : []
        }),
      ]
      const priced = holdings.map((h) => {
        const price = byId.get(h.tokenId)?.market?.priceUsd
        return price === undefined ? null : h.amount * price
      })
      const valueUsd = ctx.capabilities.prices ? priced.reduce<number>((s, v) => s + (v ?? 0), 0) : null
      return { ...w, nearBalance: display(nearRaw, NEAR_DECIMALS), holdings, valueUsd }
    })
  }
  const snapshots = async () => snapshotsOf(await wallets())
  /** The portfolio's wallets, filtered before any balance is read: watch-only wallets are left out here, not subtracted later. */
  const portfolioSnapshots = async () => snapshotsOf(executableWallets(await wallets()))

  const validatePreset = (input: PresetInput, known: Wallet[], ignoreId?: string): PresetInput => {
    const name = input.name.trim().toUpperCase()
    if (!name) throw new NearKitError('UNKNOWN', 'Give the preset a name')
    if (name.length > 24) throw new NearKitError('UNKNOWN', 'Keep names to 24 characters')
    if (ctx.stores.presets.read().some((p) => p.id !== ignoreId && p.name.toUpperCase() === name)) throw new NearKitError('UNKNOWN', `A preset named ${name} already exists`)
    const walletIds = [...new Set(input.walletIds)].filter((id) => known.some((w) => w.id === id))
    // A preset is a group that trades together: watch-only wallets can't be in one.
    const watch = known.find((w) => walletIds.includes(w.id) && !canExecute(w))
    if (watch) throw new NearKitError('NOT_EXECUTABLE', `${watch.label} is watch-only: presets hold wallets that can trade. Remove it, or connect it first.`)
    if (walletIds.length === 0) throw new NearKitError('UNKNOWN', 'Select at least one wallet')
    return { name, walletIds, note: (input.note ?? '').trim() }
  }

  return {
    getSession: currentSession,

    async listWalletOptions() {
      const adapter = await ctx.wallet()
      return adapter.listWallets()
    },

    async connect(walletId, options = {}) {
      if (!walletId) throw new NearKitError('WALLET_UNAVAILABLE', 'Choose a wallet to connect')
      const adapter = await ctx.wallet()
      try {
        const s = await adapter.connect(walletId)
        // Connected for an account by name (Connect <owner>): the session's account only if the
        // wallet shares exactly it. A plain connect is the wallet's own first account.
        const wanted = options.account
        if (wanted !== undefined && walletAccounts(s.accounts).near.includes(wanted)) ctx.stores.walletAccount.set(wanted)
        else ctx.stores.walletAccount.clear()
        const session = await toSession(s)
        ctx.session.restored = true
        ctx.session.current = session
        ctx.balances.invalidate()
        if (!session) {
          // Only EVM addresses: NearKit keeps no wallet session it can't use as a NEAR account.
          await adapter.disconnect().catch(() => undefined)
          throw new NoNearAccountError(walletAccounts(s.accounts).evm)
        }
        return session
      } catch (e) {
        throw toNearKitError(e)
      }
    },

    async disconnect() {
      const adapter = await ctx.wallet()
      await adapter.disconnect().catch(() => undefined)
      ctx.stores.walletAccount.clear()
      ctx.session.current = null
      ctx.session.restored = true
      ctx.balances.invalidate()
    },

    async signMessage(request) {
      const session = await currentSession()
      if (!session) throw new NearKitError('WALLET_UNAVAILABLE', 'Connect a wallet first')
      if (session.issue === 'network-mismatch')
        throw new NearKitError('NETWORK_MISMATCH', `${session.accountId} belongs to the other network. Connect a ${ctx.network.label.toLowerCase()} account.`)
      const adapter = await ctx.wallet()
      // An owner's request: asked of the wallet only while it can sign for the owner (the owner
      // account itself, or an account whose reported key is a full-access key of the owner on
      // chain right now), and kept only if the key that actually signed is one. A wallet signs with
      // whichever account is active in it, whatever it was asked, so the account it names proves
      // nothing: the key does. No account is taken for another. NearKit's signer checks all of it
      // again, and decides.
      const owner = request.accountId
      let signer = session.accountId
      if (owner !== undefined) {
        const control = await ownerControl(owner)
        if (!control.ok) throw new NearKitError('WALLET_UNAVAILABLE', ownerControlProblem(control, owner))
        signer = control.account
      }
      let signed: SignedMessageResult
      try {
        signed = await adapter.signMessage(signer, { message: request.message, recipient: request.recipient, nonce: request.nonce })
      } catch (e) {
        throw toNearKitError(e, 'WALLET_UNAVAILABLE')
      }
      if (owner !== undefined) {
        const problem = await signedKeyProblem(signed.publicKey, owner, keyPermission)
        if (problem) throw new NearKitError('WALLET_UNAVAILABLE', problem)
      }
      return signed
    },

    ownerControl,

    listWallets: wallets,
    listSnapshots: snapshots,
    listPortfolioSnapshots: portfolioSnapshots,

    async listHoldings() {
      return (await snapshots()).flatMap((s) => s.holdings)
    },

    async addAccount(input) {
      const accountId = input.accountId.trim()
      const error = accountIdError(accountId)
      if (error) throw new NearKitError('INVALID_ACCOUNT', error)
      if (isForeignToNetwork(accountId, ctx.network.id))
        throw new NearKitError('NETWORK_MISMATCH', `${accountId} belongs to another network; NearKit is on ${ctx.network.label.toLowerCase()}`)
      if ((await wallets()).some((w) => w.accountId === accountId)) throw new NearKitError('INVALID_ACCOUNT', `${accountId} is already in your wallets`)
      const state = await accountState(ctx.rpc, accountId, 'final')
      if (!state.exists && accountKind(accountId) === 'named') throw new NearKitError('INVALID_ACCOUNT', `${accountId} does not exist on ${ctx.network.label.toLowerCase()}`)
      ctx.stores.book.upsert({ accountId, label: input.label?.trim() ?? '', origin: 'watch', addedAt: ctx.now() })
      const added = (await wallets()).find((w) => w.accountId === accountId)
      if (!added) throw new NearKitError('UNKNOWN', 'Could not add the account')
      return added
    },

    async removeAccount(id) {
      const session = await currentSession()
      if (session?.accounts?.includes(id)) throw new NearKitError('INVALID_ACCOUNT', 'Disconnect the wallet to remove an account it signs for')
      ctx.stores.book.remove(id)
      ctx.stores.presets.write(ctx.stores.presets.read().map((p) => ({ ...p, walletIds: p.walletIds.filter((w) => w !== id) })))
    },

    async listPresets() {
      return ctx.stores.presets.read()
    },

    async createPreset(input) {
      const clean = validatePreset(input, await wallets())
      const at = ctx.now()
      const preset: WalletPreset = { id: `preset-${at.toString(36)}`, name: clean.name, walletIds: clean.walletIds, note: clean.note ?? '', createdAt: at, updatedAt: at }
      ctx.stores.presets.write([...ctx.stores.presets.read(), preset])
      return preset
    },

    async updatePreset(id, input) {
      const list = ctx.stores.presets.read()
      const current = list.find((p) => p.id === id)
      if (!current) throw new NearKitError('UNKNOWN', 'Preset not found')
      const clean = validatePreset(input, await wallets(), id)
      const updated = { ...current, name: clean.name, walletIds: clean.walletIds, note: clean.note ?? '', updatedAt: ctx.now() }
      ctx.stores.presets.write(list.map((p) => (p.id === id ? updated : p)))
      return updated
    },

    async duplicatePreset(id) {
      const list = ctx.stores.presets.read()
      const source = list.find((p) => p.id === id)
      if (!source) throw new NearKitError('UNKNOWN', 'Preset not found')
      let name = `${source.name} COPY`
      for (let n = 2; list.some((p) => p.name === name); n++) name = `${source.name} COPY ${n}`
      const at = ctx.now()
      const copy: WalletPreset = { ...source, id: `preset-${at.toString(36)}`, name: name.slice(0, 24), walletIds: [...source.walletIds], createdAt: at, updatedAt: at }
      ctx.stores.presets.write([...list, copy])
      return copy
    },

    async deletePreset(id) {
      ctx.stores.presets.write(ctx.stores.presets.read().filter((p) => p.id !== id))
    },
  }
}
