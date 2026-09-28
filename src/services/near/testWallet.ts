import type { NetworkConfig } from '@/config/networks'
import type { ConnectorTransaction, WalletAdapter, WalletSession } from './wallet'

/**
 * Scripted wallet for end-to-end tests. It is only reachable from a
 * `vite --mode e2e` build (compile-time `__NEARKIT_E2E__`), so a normal build
 * never contains it. It signs nothing: it returns fake hashes, and the e2e
 * harness answers the RPC status calls for them.
 */

interface E2EScript {
  accounts: string[]
  walletName?: string
  /** Make the next connect or sign attempt fail as a user rejection. */
  reject?: 'connect' | 'sign' | null
  /** Fail signing with a non-rejection error (outcome unknown). */
  crash?: boolean
  /** Hashes to hand out, in order; generated when empty. */
  hashes?: string[]
}

declare global {
  interface Window {
    /**
     * Test script. Deliberately not named after the compile-time `__NEARKIT_E2E__`
     * flag: Vite's dev server installs every define as a global and would overwrite it.
     */
    __NEARKIT_E2E_WALLET__?: E2EScript
    __NEARKIT_E2E_SIGNED__?: { signerId: string; transactions: ConnectorTransaction[]; hashes: string[] }[]
  }
}

const KEY = 'nearkit:e2e:session'
let counter = 0

export function createTestWalletAdapter(network: NetworkConfig): WalletAdapter {
  const fallback: E2EScript = { accounts: [`e2e-user.${network.id === 'mainnet' ? 'near' : 'testnet'}`] }
  const script = (): E2EScript => {
    const s = window.__NEARKIT_E2E_WALLET__
    return s && Array.isArray(s.accounts) && s.accounts.every((a) => typeof a === 'string') ? s : fallback
  }
  const read = (): string[] | null => {
    try {
      const value: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? 'null')
      return Array.isArray(value) ? value.filter((a): a is string => typeof a === 'string') : null
    } catch {
      return null
    }
  }
  const session = (): WalletSession | null => {
    const accounts = read()
    return accounts && accounts.length ? { walletId: 'e2e-wallet', walletName: script().walletName ?? 'E2E Test Wallet', accounts, batch: true } : null
  }
  return {
    kind: 'e2e-test',
    async listWallets() {
      return [{ id: 'e2e-wallet', name: 'E2E Test Wallet', icon: null, description: 'Scripted wallet for automated tests', website: '', injected: false }]
    },
    async connect() {
      if (script().reject === 'connect') throw new Error('User rejected')
      sessionStorage.setItem(KEY, JSON.stringify(script().accounts))
      const s = session()
      if (!s) throw new Error('No accounts')
      return s
    },
    restore: async () => session(),
    session: async () => session(),
    async disconnect() {
      sessionStorage.removeItem(KEY)
    },
    async signAndSendTransactions(signerId, transactions) {
      const s = script()
      if (s.reject === 'sign') throw new Error('User rejected the transaction')
      if (s.crash) throw new Error('Network request failed')
      const hashes = transactions.map(() => {
        counter += 1
        return s.hashes?.shift() ?? `E2EHASH${String(counter).padStart(4, '0')}`
      })
      // The e2e harness reads this to answer transaction-status calls for these hashes.
      window.__NEARKIT_E2E_SIGNED__ = [...(window.__NEARKIT_E2E_SIGNED__ ?? []), { signerId, transactions, hashes }]
      return hashes.map((hash) => ({ transaction: { hash, signer_id: signerId } }))
    },
  }
}
