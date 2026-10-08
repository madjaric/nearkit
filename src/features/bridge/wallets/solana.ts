import { base58Encode } from '@/lib/encoding'
import { unsignedSolTransfer } from '@/lib/bridge/solanaTx'
import { SourceWalletError } from './evm'

/**
 * Solana wallets for Bridge & Buy's source, through the Wallet Standard (Phantom, Solflare,
 * Backpack and the rest register themselves on the page): a wallet that offers Solana mainnet,
 * `standard:connect` and `solana:signAndSendTransaction`. NEARKITS builds the transfer's bytes
 * (lib/bridge/solanaTx.ts); the wallet shows it, signs and sends it. No key reaches NEARKITS.
 */

const MAINNET = 'solana:mainnet'

interface StandardAccount {
  address: string
  publicKey: Uint8Array
  chains: readonly string[]
}

interface StandardWallet {
  name: string
  icon: string
  chains: readonly string[]
  accounts: readonly StandardAccount[]
  features: Record<string, unknown>
}

export interface SolanaWallet {
  id: string
  name: string
  icon: string | null
  wallet: StandardWallet
}

const usable = (w: StandardWallet) =>
  typeof w?.name === 'string' &&
  Array.isArray(w.chains) &&
  w.chains.includes(MAINNET) &&
  typeof w.features === 'object' &&
  w.features !== null &&
  'standard:connect' in w.features &&
  'solana:signAndSendTransaction' in w.features

/** Listens for Wallet Standard wallets offering Solana mainnet; calls back with the list as it grows. */
export function discoverSolanaWallets(onChange: (wallets: SolanaWallet[]) => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  const found = new Map<string, SolanaWallet>()
  const api = {
    register: (...wallets: StandardWallet[]) => {
      for (const w of wallets) {
        if (!usable(w)) continue
        const icon = typeof w.icon === 'string' && /^data:image\/(svg\+xml|png|webp|jpeg);/.test(w.icon) ? w.icon : null
        found.set(w.name, { id: w.name, name: w.name.slice(0, 40), icon, wallet: w })
      }
      onChange([...found.values()])
      return () => undefined
    },
  }
  const onRegister = (e: Event) => {
    const callback = (e as CustomEvent<(a: typeof api) => void>).detail
    if (typeof callback === 'function') callback(api)
  }
  window.addEventListener('wallet-standard:register-wallet', onRegister)
  window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }))
  return () => window.removeEventListener('wallet-standard:register-wallet', onRegister)
}

const rejected = (e: unknown) => {
  const code = (e as { code?: unknown } | null)?.code
  const message = String((e as { message?: unknown } | null)?.message ?? '')
  return code === 4001 || /reject|declin|cancel/i.test(message)
}

export async function connectSolana(w: SolanaWallet): Promise<string> {
  const connect = (w.wallet.features['standard:connect'] as { connect: () => Promise<{ accounts: readonly StandardAccount[] }> }).connect
  let accounts: readonly StandardAccount[]
  try {
    accounts = (await connect()).accounts
  } catch (e) {
    if (rejected(e)) throw new SourceWalletError('You declined in your wallet.', true)
    throw new SourceWalletError('Your Solana wallet couldn’t connect.')
  }
  const account = accounts.find((a) => a.chains?.includes(MAINNET)) ?? accounts[0]
  if (!account || typeof account.address !== 'string') throw new SourceWalletError('Your Solana wallet returned no account.')
  return account.address
}

/** Signs and sends a transfer of exactly `lamports` to `to` in the wallet; returns its signature (the transaction id). */
export async function sendSol(w: SolanaWallet, t: { from: string; to: string; lamports: bigint; recentBlockhash: string }): Promise<string> {
  const account = w.wallet.accounts.find((a) => a.address === t.from)
  if (!account) throw new SourceWalletError('Your Solana wallet changed accounts. Nothing was sent: connect it again.')
  const transaction = unsignedSolTransfer(t)
  const send = (
    w.wallet.features['solana:signAndSendTransaction'] as {
      signAndSendTransaction: (
        ...inputs: { account: StandardAccount; chain: string; transaction: Uint8Array; options?: Record<string, unknown> }[]
      ) => Promise<{ signature: Uint8Array }[]>
    }
  ).signAndSendTransaction
  let out: { signature: Uint8Array }[]
  try {
    out = await send({ account, chain: MAINNET, transaction, options: { preflightCommitment: 'confirmed' } })
  } catch (e) {
    if (rejected(e)) throw new SourceWalletError('You declined in your wallet. Nothing was sent.', true)
    throw new SourceWalletError('Your Solana wallet couldn’t send it. Check the wallet before trying again.')
  }
  const sig = out?.[0]?.signature
  if (!(sig instanceof Uint8Array) || sig.length !== 64) throw new SourceWalletError('Your Solana wallet returned no signature. Check it before sending again.')
  return base58Encode(sig)
}
