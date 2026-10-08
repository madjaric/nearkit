import { useCallback, useEffect, useState } from 'react'
import type { BridgeChain } from '@/config/bridge'
import { connectEvm, discoverEvmWallets, ensureEvmChain, evmBalance, SourceWalletError, type EvmWallet } from './wallets/evm'
import { connectSolana, discoverSolanaWallets, type SolanaWallet } from './wallets/solana'

/**
 * The user's wallet on the source chain: the wallets this browser has (found, not assumed), the one
 * connected, its address and balance. Ethereum and BNB Chain share the EVM wallet; switching chains
 * asks the wallet to switch. An account or network change in the wallet drops the connection, so a
 * transfer is never sent from an account or chain the page didn't show.
 */

export type SourceWallet = { family: 'evm'; wallet: EvmWallet } | { family: 'solana'; wallet: SolanaWallet }

export interface SourceConnection {
  family: 'evm' | 'solana'
  walletId: string
  name: string
  address: string
}

export function useSourceWallets() {
  const [evm, setEvm] = useState<EvmWallet[]>([])
  const [solana, setSolana] = useState<SolanaWallet[]>([])
  useEffect(() => discoverEvmWallets(setEvm), [])
  useEffect(() => discoverSolanaWallets(setSolana), [])
  return { evm, solana }
}

/** `solanaBalance`: a Solana address's lamports (NEARKITS' server reads them); an EVM balance comes from the wallet itself. */
export function useSourceWallet(chain: BridgeChain, solanaBalance: (address: string) => Promise<bigint>) {
  const { evm, solana } = useSourceWallets()
  const [connection, setConnection] = useState<SourceConnection | null>(null)
  const [balance, setBalance] = useState<bigint | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const wallets: SourceWallet[] = chain.family === 'evm' ? evm.map((w) => ({ family: 'evm', wallet: w })) : solana.map((w) => ({ family: 'solana', wallet: w }))
  const current = connection && connection.family === chain.family ? (wallets.find((w) => w.wallet.id === connection.walletId) ?? null) : null

  // A connection belongs to its family: Solana's doesn't carry over to Ethereum.
  const active = connection && connection.family === chain.family ? connection : null

  const readBalance = useCallback(
    async (w: SourceWallet, address: string) => {
      setBalance(null)
      try {
        setBalance(w.family === 'evm' ? await evmBalance(w.wallet.provider, address) : await solanaBalance(address))
      } catch {
        setBalance(null)
      }
    },
    [solanaBalance],
  )

  const connect = async (w: SourceWallet) => {
    setError(null)
    setBusy(true)
    try {
      let address: string
      if (w.family === 'evm') {
        address = await connectEvm(w.wallet.provider)
        if (chain.evmChainId) await ensureEvmChain(w.wallet.provider, chain.evmChainId)
      } else address = await connectSolana(w.wallet)
      setConnection({ family: w.family, walletId: w.wallet.id, name: w.wallet.name, address })
      void readBalance(w, address)
    } catch (e) {
      setError(e instanceof SourceWalletError ? e.message : 'Your wallet couldn’t connect.')
    } finally {
      setBusy(false)
    }
  }

  // The EVM wallet on the chain chosen now (Ethereum ↔ BNB Chain): ask it to switch, then read again.
  useEffect(() => {
    if (!active || active.family !== 'evm' || !chain.evmChainId || current?.family !== 'evm') return
    let gone = false
    ensureEvmChain(current.wallet.provider, chain.evmChainId)
      .then(() => {
        if (!gone) void readBalance(current, active.address)
      })
      .catch((e: unknown) => {
        if (!gone) setError(e instanceof SourceWalletError ? e.message : 'Switch your wallet to this network.')
      })
    return () => {
      gone = true
    }
  }, [chain.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // The wallet changed account or network on its own: drop the connection rather than act on a stale one.
  useEffect(() => {
    if (current?.family !== 'evm') return
    const provider = current.wallet.provider
    const drop = () => {
      setConnection(null)
      setBalance(null)
      setError('Your wallet changed account or network. Connect it again.')
    }
    provider.on?.('accountsChanged', drop)
    provider.on?.('chainChanged', drop)
    return () => {
      provider.removeListener?.('accountsChanged', drop)
      provider.removeListener?.('chainChanged', drop)
    }
  }, [current])

  return {
    wallets,
    connection: active,
    current,
    balance: active ? balance : null,
    error,
    busy,
    connect,
    disconnect: () => {
      setConnection(null)
      setBalance(null)
      setError(null)
    },
    refreshBalance: () => (active && current ? readBalance(current, active.address) : undefined),
    /** While a transfer is being sent: its own chain/account events are expected, not a reason to drop. */
    setError,
  }
}
