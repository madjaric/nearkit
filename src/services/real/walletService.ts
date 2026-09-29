import { NATIVE_TOKEN_ID, NEAR_DECIMALS } from '@/config/networks'
import { formatUnits } from '@/lib/amounts'
import { mapLimit } from '@/lib/async'
import { truncateMiddle } from '@/lib/format'
import { accountIdError, accountKind, isForeignToNetwork } from '@/lib/validation'
import { accountState } from '@/services/near/account'
import { NearKitError, toNearKitError } from '@/services/near/errors'
import { explorerAccountUrl } from '@/services/near/explorer'
import type { WalletSession } from '@/services/near/wallet'
import type { Holding, PresetInput, Session, Wallet, WalletPreset, WalletSnapshot } from '@/types/domain'
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

export function createWalletService(ctx: NearContext, market: Market): WalletService {
  const toSession = async (s: WalletSession): Promise<Session> => {
    const accountId = s.accounts[0] ?? ''
    let issue: Session['issue'] = null
    if (isForeignToNetwork(accountId, ctx.network.id)) issue = 'network-mismatch'
    else {
      const state = await accountState(ctx.rpc, accountId).catch(() => null)
      if (state && !state.exists) issue = 'account-missing'
    }
    for (const id of s.accounts) ctx.stores.book.upsert({ accountId: id, label: '', origin: 'known', addedAt: ctx.now() })
    return {
      accountId,
      walletId: accountId,
      connectedAt: ctx.now(),
      mode: 'near',
      walletName: s.walletName,
      accounts: s.accounts,
      issue,
      explorerUrl: issue === 'network-mismatch' ? null : explorerAccountUrl(ctx.network, accountId),
    }
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

  async function wallets(): Promise<Wallet[]> {
    const session = await currentSession()
    if (!session) return []
    const signers = new Set(session.accounts ?? [session.accountId])
    const book = ctx.stores.book.list()
    const ids = [...new Set([...(session.accounts ?? [session.accountId]), ...book.map((e) => e.accountId)])]
    return ids
      .filter((id) => !isForeignToNetwork(id, ctx.network.id))
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
        }
      })
  }

  async function snapshots(): Promise<WalletSnapshot[]> {
    const list = await wallets()
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

  const validatePreset = (input: PresetInput, known: Wallet[], ignoreId?: string): PresetInput => {
    const name = input.name.trim().toUpperCase()
    if (!name) throw new NearKitError('UNKNOWN', 'Give the preset a name')
    if (name.length > 24) throw new NearKitError('UNKNOWN', 'Keep names to 24 characters')
    if (ctx.stores.presets.read().some((p) => p.id !== ignoreId && p.name.toUpperCase() === name)) throw new NearKitError('UNKNOWN', `A preset named ${name} already exists`)
    const walletIds = [...new Set(input.walletIds)].filter((id) => known.some((w) => w.id === id))
    if (walletIds.length === 0) throw new NearKitError('UNKNOWN', 'Select at least one wallet')
    return { name, walletIds, note: (input.note ?? '').trim() }
  }

  return {
    getSession: currentSession,

    async listWalletOptions() {
      const adapter = await ctx.wallet()
      return adapter.listWallets()
    },

    async connect(walletId) {
      if (!walletId) throw new NearKitError('WALLET_UNAVAILABLE', 'Choose a wallet to connect')
      const adapter = await ctx.wallet()
      try {
        const s = await adapter.connect(walletId)
        ctx.session.restored = true
        ctx.session.current = await toSession(s)
        ctx.balances.invalidate()
        return ctx.session.current
      } catch (e) {
        throw toNearKitError(e)
      }
    },

    async disconnect() {
      const adapter = await ctx.wallet()
      await adapter.disconnect().catch(() => undefined)
      ctx.session.current = null
      ctx.session.restored = true
      ctx.balances.invalidate()
    },

    async signMessage(request) {
      const session = await currentSession()
      if (!session) throw new NearKitError('WALLET_UNAVAILABLE', 'Connect a wallet first')
      if (session.issue === 'network-mismatch')
        throw new NearKitError('NETWORK_MISMATCH', `${session.accountId} belongs to the other network. Connect a ${ctx.network.label.toLowerCase()} account.`)
      const signer = request.accountId ?? session.accountId
      const adapter = await ctx.wallet()
      try {
        return await adapter.signMessage(signer, { message: request.message, recipient: request.recipient, nonce: request.nonce })
      } catch (e) {
        throw toNearKitError(e, 'WALLET_UNAVAILABLE')
      }
    },

    listWallets: wallets,
    listSnapshots: snapshots,

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
