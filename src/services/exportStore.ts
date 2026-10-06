/**
 * This browser's held key exports. An export waits up to 24 hours before NEARKITS releases it,
 * so the key it will be sealed to has to outlive the page that asked for it. Each export's own
 * P-256 key is kept here as a CryptoKey that can't be extracted: it can open that one export in
 * this browser and nothing else, and it is forgotten once the key is collected or the export is
 * over. Without IndexedDB (a private window that refuses it, say) it lives as long as the page,
 * and `persistent` says so.
 */

export interface StoredExport {
  exportId: string
  network: string
  accountId: string
  ownerAccount: string
  /** The fingerprint of `privateKey`'s public half, as the owner signed it. */
  browserKey: string
  releaseAt: number
  expiresAt: number
  createdAt: number
  /** Not extractable: it can only be used here, to open this export. */
  privateKey: CryptoKey
}

export interface ExportStore {
  /** Whether a held export survives closing this page. */
  readonly persistent: boolean
  save(r: StoredExport): Promise<void>
  get(exportId: string): Promise<StoredExport | null>
  list(network: string): Promise<StoredExport[]>
  /** The newest export this browser holds for one wallet. */
  ofWallet(network: string, accountId: string): Promise<StoredExport | null>
  remove(exportId: string): Promise<void>
}

const DB = 'nearkits-exports'
const STORE = 'exports'

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'))
  })
}

function memoryStore(): ExportStore {
  const all = new Map<string, StoredExport>()
  return {
    persistent: false,
    async save(r) {
      all.set(r.exportId, r)
    },
    async get(id) {
      return all.get(id) ?? null
    },
    async list(network) {
      return [...all.values()].filter((r) => r.network === network).sort((a, b) => a.createdAt - b.createdAt)
    },
    async ofWallet(network, accountId) {
      return (await this.list(network)).filter((r) => r.accountId === accountId).at(-1) ?? null
    },
    async remove(id) {
      all.delete(id)
    },
  }
}

function indexedStore(idb: IDBFactory): ExportStore {
  let opened: Promise<IDBDatabase> | null = null
  const db = () => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = idb.open(DB, 1)
      r.onupgradeneeded = () => void r.result.createObjectStore(STORE, { keyPath: 'exportId' })
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error ?? new Error('IndexedDB unavailable'))
    })
    return opened
  }
  const tx = async (mode: IDBTransactionMode) => (await db()).transaction(STORE, mode).objectStore(STORE)
  return {
    persistent: true,
    async save(r) {
      await request((await tx('readwrite')).put(r))
    },
    async get(id) {
      return ((await request((await tx('readonly')).get(id))) as StoredExport | undefined) ?? null
    },
    async list(network) {
      const rows = (await request((await tx('readonly')).getAll())) as StoredExport[]
      return rows.filter((r) => r.network === network).sort((a, b) => a.createdAt - b.createdAt)
    },
    async ofWallet(network, accountId) {
      return (await this.list(network)).filter((r) => r.accountId === accountId).at(-1) ?? null
    },
    async remove(id) {
      await request((await tx('readwrite')).delete(id))
    },
  }
}

/** IndexedDB where the browser has it (and lets this page use it), else this page's memory. */
export function createExportStore(idb: IDBFactory | null | undefined = typeof indexedDB === 'undefined' ? null : indexedDB): ExportStore {
  if (!idb) return memoryStore()
  const persistent = indexedStore(idb)
  const memory = memoryStore()
  // A browser that refuses IndexedDB at the first use (private mode) falls back to memory for the page's life.
  let fallback = false
  async function withStore<R>(act: (s: ExportStore) => Promise<R>): Promise<R> {
    if (!fallback) {
      try {
        return await act(persistent)
      } catch {
        fallback = true
      }
    }
    return act(memory)
  }
  return {
    get persistent() {
      return !fallback
    },
    save: (r) => withStore((s) => s.save(r)),
    get: (id) => withStore((s) => s.get(id)),
    list: (network) => withStore((s) => s.list(network)),
    ofWallet: (network, accountId) => withStore((s) => s.ofWallet(network, accountId)),
    remove: (id) => withStore((s) => s.remove(id)),
  }
}

/** The page's store: one per tab. */
export const exportStore: ExportStore = createExportStore()
