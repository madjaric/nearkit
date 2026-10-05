import type { NetworkId } from '@/config/networks'
import type { ValueSample } from '@/lib/valueHistory'
import type { ActivityItem, CopyRule, DcaPlan, LimitOrder, SniperConfig, WalletPreset } from '@/types/domain'
import type { PlannedAction, TxPhase } from '@/types/operations'

/**
 * Local persistence for real mode, scoped per network so testnet and mainnet
 * never mix. Only public information is stored: account IDs and labels, presets,
 * imported token contracts, NearKit's own transaction records and automation
 * drafts. Never keys, seed phrases or signatures.
 */

export interface KeyValue {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

/** localStorage, guarded: storage may be blocked (private mode) and the app must still work. */
export const browserStorage: KeyValue = {
  get(key) {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value)
    } catch {
      // full or blocked: lives for this page only
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key)
    } catch {
      // nothing stored
    }
  },
}

export function memoryStorage(): KeyValue {
  const map = new Map<string, string>()
  return { get: (k) => map.get(k) ?? null, set: (k, v) => void map.set(k, v), remove: (k) => void map.delete(k) }
}

function jsonList<T>(kv: KeyValue, key: string, valid: (v: unknown) => v is T) {
  return {
    read(): T[] {
      const text = kv.get(key)
      if (!text) return []
      try {
        const value: unknown = JSON.parse(text)
        return Array.isArray(value) ? value.filter(valid) : []
      } catch {
        return []
      }
    },
    write(items: T[]) {
      kv.set(key, JSON.stringify(items))
    },
  }
}

const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

// ─── account book ───────────────────────────────────────────────────────────

export interface BookEntry {
  accountId: string
  /** Label the user chose; empty for the default. */
  label: string
  /** `known`: connected through a wallet before. `watch`: added by account ID. */
  origin: 'known' | 'watch'
  addedAt: number
}

const isBookEntry = (v: unknown): v is BookEntry =>
  obj(v) && typeof v.accountId === 'string' && typeof v.label === 'string' && (v.origin === 'known' || v.origin === 'watch') && typeof v.addedAt === 'number'

// ─── activity ───────────────────────────────────────────────────────────────

/** One transaction of a recorded operation: enough to ask the chain about it again. */
export interface ActivityTx {
  hash: string | null
  signerId: string
  receiverId: string
  phase: TxPhase
  /** Last action, which decides how a finished outcome is read (e.g. ft_transfer_call refunds). */
  last: PlannedAction | null
  note: string | null
}

/** A NearKit-originated operation, reconciled with chain status over time. */
export interface ActivityRecord extends ActivityItem {
  origin: 'nearkit'
  network: string
  accountId: string
  txHashes: string[]
  planId: string
  txs: ActivityTx[]
  /** Last time pending transactions were checked on chain. */
  checkedAt: number | null
}

const isActivity = (v: unknown): v is ActivityRecord =>
  obj(v) && v.origin === 'nearkit' && typeof v.id === 'string' && typeof v.planId === 'string' && Array.isArray(v.txHashes) && Array.isArray(v.txs) && typeof v.at === 'number'

const MAX_ACTIVITY = 200

// ─── drafts ─────────────────────────────────────────────────────────────────

const isPreset = (v: unknown): v is WalletPreset => obj(v) && typeof v.id === 'string' && typeof v.name === 'string' && Array.isArray(v.walletIds)
const isContract = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64
const isDraft = (v: unknown): v is { id: string } => obj(v) && typeof v.id === 'string'
const isSample = (v: unknown): v is ValueSample => obj(v) && typeof v.t === 'number' && typeof v.v === 'number' && Number.isFinite(v.v)

export function createStores(kv: KeyValue, network: NetworkId) {
  const key = (name: string) => `nearkit:${network}:${name}`
  const book = jsonList<BookEntry>(kv, key('book'), isBookEntry)
  const presets = jsonList<WalletPreset>(kv, key('presets'), isPreset)
  const tokens = jsonList<string>(kv, key('tokens'), isContract)
  const activity = jsonList<ActivityRecord>(kv, key('activity'), isActivity)
  const dca = jsonList<DcaPlan>(kv, key('drafts:dca'), (v): v is DcaPlan => isDraft(v))
  const copy = jsonList<CopyRule>(kv, key('drafts:copy'), (v): v is CopyRule => isDraft(v))
  const sniper = jsonList<SniperConfig>(kv, key('drafts:sniper'), (v): v is SniperConfig => isDraft(v))
  const orders = jsonList<LimitOrder>(kv, key('drafts:orders'), (v): v is LimitOrder => isDraft(v))

  return {
    book: {
      list: book.read,
      upsert(entry: BookEntry) {
        const list = book.read()
        const index = list.findIndex((e) => e.accountId === entry.accountId)
        if (index >= 0) list[index] = { ...list[index], ...entry, origin: list[index]?.origin === 'known' ? 'known' : entry.origin }
        else list.push(entry)
        book.write(list)
      },
      remove(accountId: string) {
        book.write(book.read().filter((e) => e.accountId !== accountId))
      },
    },
    presets,
    tokens: {
      list: tokens.read,
      add(contract: string) {
        const list = tokens.read()
        if (!list.includes(contract)) tokens.write([...list, contract])
      },
      remove(contract: string) {
        tokens.write(tokens.read().filter((c) => c !== contract))
      },
    },
    activity: {
      list: activity.read,
      upsert(record: ActivityRecord) {
        const list = activity.read().filter((r) => r.id !== record.id)
        activity.write([record, ...list].sort((a, b) => b.at - a.at).slice(0, MAX_ACTIVITY))
      },
    },
    drafts: { dca, copy, sniper, orders },
    /**
     * The NEAR account the user connected for by name (Recover's "Connect <owner>"): the session's
     * account while the wallet shares exactly it, also after a reload. An account id, nothing else.
     */
    walletAccount: {
      get(): string | null {
        const id = kv.get(key('wallet-account'))
        return isContract(id) ? id : null
      },
      set: (accountId: string): void => kv.set(key('wallet-account'), accountId),
      clear: (): void => kv.remove(key('wallet-account')),
    },
    /**
     * The portfolio value history this browser recorded (src/lib/valueHistory.ts), for one set of
     * wallets (`identity`: another sign-in starts its own). Public figures only.
     */
    valueHistory: {
      read(identity: string): ValueSample[] {
        const text = kv.get(key('value-history'))
        if (!text) return []
        try {
          const stored = JSON.parse(text) as { identity?: unknown; points?: unknown }
          return stored.identity === identity && Array.isArray(stored.points) ? stored.points.filter(isSample) : []
        } catch {
          return []
        }
      },
      write: (identity: string, points: readonly ValueSample[]): void => kv.set(key('value-history'), JSON.stringify({ identity, points })),
    },
    /** Per-account PnL ledger cache (public chain data, JSON). */
    ledger: {
      read: (accountId: string): string | null => kv.get(key(`ledger:${accountId}`)),
      write: (accountId: string, text: string): void => kv.set(key(`ledger:${accountId}`), text),
    },
  }
}

export type Stores = ReturnType<typeof createStores>
