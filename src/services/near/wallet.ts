import { NearConnector, type DataStorage, type NearConnectorOptions, type NearWalletBase, type WalletManifest } from '@hot-labs/near-connect'
import type { NetworkConfig, NetworkId } from '@/config/networks'
import { WALLET_MANIFEST } from '@/config/walletManifest'
import { providerAccounts } from '@/lib/walletDetails'
import type { WalletAccountDetail } from '@/types/domain'
import { NearKitError } from './errors'

/**
 * Wallet boundary. The rest of NearKit talks to wallets only through this
 * interface; the production implementation wraps NEAR Connect (docs.near.org's
 * current recommendation), and a scripted adapter exists only in e2e builds.
 * Wallets hold the keys: nothing here ever sees a seed phrase or private key.
 */

export interface WalletOption {
  id: string
  name: string
  /** Remote URL or data URL from the wallet manifest. */
  icon: string | null
  description: string
  website: string
  /** Delivered by a browser extension rather than the shared manifest. */
  injected: boolean
}

export interface WalletSession {
  walletId: string
  walletName: string
  accounts: string[]
  /** The wallet signs several transactions in one approval. */
  batch: boolean
  /** What the wallet returned for its accounts, for the user to see (src/lib/walletDetails.ts). Never used to decide anything. */
  provider?: WalletAccountDetail[]
}

export type ConnectorAction =
  { type: 'FunctionCall'; params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string } } | { type: 'Transfer'; params: { deposit: string } }

export interface ConnectorTransaction {
  receiverId: string
  actions: ConnectorAction[]
}

/** A NEP-413 message for the wallet to sign (see nep413.ts). */
export interface SignMessageRequest {
  message: string
  recipient: string
  /** 32 bytes. */
  nonce: Uint8Array
}

export interface SignedMessageResult {
  accountId: string
  /** `ed25519:<base58>` */
  publicKey: string
  /** Base64 (NEP-413); a few wallets send base58. */
  signature: string
}

export interface WalletAdapter {
  readonly kind: 'near-connect' | 'e2e-test'
  listWallets(): Promise<WalletOption[]>
  connect(walletId: string): Promise<WalletSession>
  /** Session left by a previous visit, or null. */
  restore(): Promise<WalletSession | null>
  /** Re-reads the wallet's accounts right now; null when the session is gone. */
  session(): Promise<WalletSession | null>
  disconnect(): Promise<void>
  /**
   * Ask the wallet to sign and send. Resolves with the wallet's raw results, which
   * the executor validates; never trusted as proof of success on their own.
   */
  signAndSendTransactions(signerId: string, transactions: ConnectorTransaction[]): Promise<unknown[]>
  /**
   * Ask the wallet to sign a NEP-413 message: a signature, no transaction, no
   * funds. The caller verifies it; the wallet's answer is never trusted as-is.
   */
  signMessage(signerId: string, request: SignMessageRequest): Promise<SignedMessageResult>
}

/** Refuse to run inside another site's frame: NEAR Connect accepts injected wallets from any parent. */
export function assertTopLevel(): void {
  if (typeof window !== 'undefined' && window.top !== window.self) {
    throw new NearKitError('WALLET_UNAVAILABLE', 'NearKit can’t connect a wallet while it is embedded in another page. Open NearKit directly.')
  }
}

/** Keeps each network's wallet session in its own localStorage namespace. */
class NamespacedStorage implements DataStorage {
  private readonly prefix: string
  constructor(prefix: string) {
    this.prefix = prefix
  }
  async get(key: string): Promise<string | null> {
    try {
      return localStorage.getItem(this.prefix + key)
    } catch {
      return null
    }
  }
  async set(key: string, value: string): Promise<void> {
    try {
      localStorage.setItem(this.prefix + key, value)
    } catch {
      // Storage blocked (private mode): the session simply won't survive a reload.
    }
  }
  async remove(key: string): Promise<void> {
    try {
      localStorage.removeItem(this.prefix + key)
    } catch {
      // nothing stored, nothing to remove
    }
  }
}

function toOption(manifest: WalletManifest): WalletOption {
  return {
    id: manifest.id,
    name: manifest.name,
    icon: manifest.icon || null,
    description: manifest.description ?? '',
    website: manifest.website ?? '',
    injected: manifest.type === 'injected',
  }
}

function accountsOf(list: { accountId?: string }[] | undefined): string[] {
  return [...new Set((list ?? []).map((a) => a.accountId ?? '').filter((id) => id.length > 0))]
}

/** Identifies the vendored manifest: wallet IDs and their pinned executor URLs. */
const MANIFEST_PIN = WALLET_MANIFEST.wallets.map((w) => `${w.id}=${w.executor}`).join('|')

/**
 * NEAR Connect caches wallet code in IndexedDB by wallet ID and version, not by URL,
 * and runs the cached copy first. When the pinned manifest changes (or on first use),
 * clear that cache so only code from the pinned URLs can run.
 */
async function resetCodeCacheIfUnpinned(storage: DataStorage): Promise<void> {
  if ((await storage.get('manifest-pin')) === MANIFEST_PIN) return
  if (typeof indexedDB === 'undefined') return
  const cleared = await new Promise<boolean>((resolve) => {
    const req = indexedDB.deleteDatabase('hot-connector')
    req.onsuccess = () => resolve(true)
    req.onerror = () => resolve(false)
    req.onblocked = () => resolve(false)
  })
  // If another tab holds the database open, try again next time.
  if (cleared) await storage.set('manifest-pin', MANIFEST_PIN)
}

export function createNearConnectAdapter(network: NetworkConfig): WalletAdapter {
  const networkId: NetworkId = network.id
  const storage = new NamespacedStorage(`nearkit:${networkId}:wallet:`)
  let connector: Promise<NearConnector> | null = null

  // Created lazily and exactly once: the constructor registers wallets and adds window listeners.
  const get = (): Promise<NearConnector> => {
    // Never listen for wallet injections while framed by another site.
    assertTopLevel()
    connector ??= (async () => {
      // NearKit never registers debug wallets; drop any a previous page or script left behind.
      await storage.remove('debug-wallets')
      await resetCodeCacheIfUnpinned(storage)
      return new NearConnector({
        network: networkId,
        providers: { [networkId]: [...network.rpcUrls] },
        storage,
        footerBranding: null,
        // Reviewed snapshot with commit-pinned executors, never the mutable live manifest.
        // The published manifest is looser than the library's declared types (it reads it as JSON), so it is passed as data.
        manifest: structuredClone(WALLET_MANIFEST) as unknown as NearConnectorOptions['manifest'],
        // A wallet injected by another window must not become the selected wallet on its own.
        autoConnect: false,
      })
    })()
    return connector
  }

  const sessionOf = async (wallet: NearWalletBase): Promise<WalletSession | null> => {
    const list = await wallet.getAccounts({ network: networkId })
    const accounts = accountsOf(list)
    if (accounts.length === 0) return null
    return {
      walletId: wallet.manifest.id,
      walletName: wallet.manifest.name,
      accounts,
      batch: Boolean(wallet.manifest.features?.signAndSendTransactions),
      provider: providerAccounts(list ?? []),
    }
  }

  const current = async (): Promise<WalletSession | null> => {
    try {
      const { wallet } = await (await get()).getConnectedWallet()
      return await sessionOf(wallet)
    } catch {
      return null
    }
  }

  return {
    kind: 'near-connect',

    async listWallets() {
      assertTopLevel()
      const c = await get()
      await c.whenManifestLoaded.catch(() => undefined)
      return c.availableWallets.map((w) => toOption(w.manifest))
    },

    async connect(walletId) {
      assertTopLevel()
      const c = await get()
      try {
        const wallet = await c.connect({ walletId })
        const session = await sessionOf(wallet)
        if (!session) throw new NearKitError('WALLET_UNAVAILABLE', 'The wallet connected but did not share an account')
        return session
      } catch (e) {
        await storage.remove('selected-wallet')
        throw e
      }
    },

    restore: current,
    session: current,

    async disconnect() {
      try {
        await (await get()).disconnect()
      } finally {
        await storage.remove('selected-wallet')
      }
    },

    async signAndSendTransactions(signerId, transactions) {
      assertTopLevel()
      const c = await get()
      const { wallet } = await c.getConnectedWallet().catch(() => {
        throw new NearKitError('WALLET_UNAVAILABLE', 'Your wallet session ended. Connect the wallet again to continue.')
      })
      const session = await sessionOf(wallet)
      if (!session || !session.accounts.includes(signerId)) {
        throw new NearKitError('WALLET_UNAVAILABLE', `${signerId} is not available in the connected wallet. Switch to that account to sign.`)
      }
      if (transactions.length > 1 && !session.batch) throw new NearKitError('WALLET_UNAVAILABLE', `${session.walletName} signs one transaction at a time`)
      if (transactions.length === 1) {
        const [tx] = transactions
        if (!tx) return []
        return [await wallet.signAndSendTransaction({ network: networkId, signerId, receiverId: tx.receiverId, actions: tx.actions })]
      }
      return await wallet.signAndSendTransactions({ network: networkId, signerId, transactions })
    },

    async signMessage(signerId, request) {
      assertTopLevel()
      const c = await get()
      const { wallet } = await c.getConnectedWallet().catch(() => {
        throw new NearKitError('WALLET_UNAVAILABLE', 'Your wallet session ended. Connect the wallet again to continue.')
      })
      if (wallet.manifest.features && wallet.manifest.features.signMessage === false) {
        throw new NearKitError('WALLET_UNAVAILABLE', `${wallet.manifest.name} can’t sign messages. Connect a wallet that can (Meteor, HOT, Intear or MyNearWallet).`)
      }
      const signed = await wallet.signMessage({ message: request.message, recipient: request.recipient, nonce: new Uint8Array(request.nonce), network: networkId, signerId })
      if (!signed || typeof signed.accountId !== 'string' || typeof signed.publicKey !== 'string' || typeof signed.signature !== 'string') {
        throw new NearKitError('WALLET_UNAVAILABLE', 'The wallet returned an incomplete signature')
      }
      return { accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature }
    },
  }
}
