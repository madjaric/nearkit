import { useState } from 'react'
import type { BridgeChain } from '@/config/bridge'
import { tryParseUnits } from '@/lib/amounts'
import { sourceAddressError } from '@/lib/bridge/addresses'
import type { BridgeOrderView } from '@/lib/bridge/types'
import { useDebouncedValue } from '@/lib/hooks'
import { useBridgeClient } from './useBridge'
import { useSourceWallet, type SourceWallet } from './useSourceWallet'
import { ensureEvmChain, sendEvmNative, SourceWalletError } from './wallets/evm'
import { sendSol } from './wallets/solana'

/**
 * The source side's state for both bridge products (SourceFields.tsx draws it): the wallet that
 * sends, the amount, the balance checks, and the review's send to the deposit address.
 */

/**
 * Everything the form needs from the source side: the chain, its wallet (or a pasted address), the
 * amount as typed and as base units, the balance checks.
 */
export function useSourceSide(chain: BridgeChain) {
  const client = useBridgeClient()
  const source = useSourceWallet(chain, client.solanaBalance)
  const [amountText, setAmountText] = useState('')
  const [manual, setManual] = useState(false)
  const [manualAddress, setManualAddress] = useState('')
  const manualError = manual && manualAddress.trim() ? sourceAddressError(chain, manualAddress) : null
  const sourceAddress = source.connection?.address ?? (manual && manualAddress.trim() && !manualError ? manualAddress.trim() : null)
  const settled = useDebouncedValue(amountText.trim(), 400)
  const parsed = settled ? tryParseUnits(settled, chain.decimals) : null
  const amountRaw = parsed?.ok ? parsed.value : null
  const precision = parsed && !parsed.ok ? `At most ${chain.decimals} decimals for ${chain.symbol}.` : null
  const balance = source.balance
  const insufficient = balance !== null && amountRaw !== null && amountRaw > balance
  const leavesNoFee = balance !== null && amountRaw !== null && !insufficient && balance - amountRaw < chain.maxReserve
  return {
    source,
    amountText,
    setAmountText,
    settled,
    amountRaw,
    precision,
    balance,
    insufficient,
    leavesNoFee,
    manual,
    setManual,
    manualAddress,
    setManualAddress,
    manualError,
    sourceAddress,
  }
}

export type SourceSide = ReturnType<typeof useSourceSide>

/**
 * The review's Confirm: the user's own wallet sends exactly the order's amount to its deposit
 * address (an EVM wallet on the right chain, checked right before sending; a Solana wallet signs a
 * plain transfer NEARKITS built), then NEARKITS records the transaction. Without a connected wallet,
 * the user says they sent it (with its hash, optionally). Nothing is ever sent twice from here.
 */
export function useSendToDeposit(order: BridgeOrderView, chain: BridgeChain, source: SourceWallet | null, onSent: (orderId: string) => void) {
  const client = useBridgeClient()
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [manualHash, setManualHash] = useState('')
  const q = order.quote

  const send = async (expired: boolean) => {
    if (!source || expired || sending) return
    setError(null)
    setSending(true)
    let hash: string
    try {
      if (source.family === 'evm') {
        await ensureEvmChain(source.wallet.provider, chain.evmChainId as number)
        hash = await sendEvmNative(source.wallet.provider, { from: order.sourceAddress, to: order.depositAddress, value: BigInt(q.amountIn), chainId: chain.evmChainId as number })
      } else {
        const blockhash = await client.solanaBlockhash()
        hash = await sendSol(source.wallet, { from: order.sourceAddress, to: order.depositAddress, lamports: BigInt(q.amountIn), recentBlockhash: blockhash })
      }
    } catch (e) {
      setError(e instanceof SourceWalletError ? e.message : 'Your wallet couldn’t send it. Check your wallet before trying again.')
      setSending(false)
      return
    }
    // Sent: whatever happens to this call, the order follows the deposit address itself.
    await client.deposit(order.id, hash).catch(() => undefined)
    onSent(order.id)
  }

  const sentManually = async () => {
    const hash = manualHash.trim()
    if (hash) {
      try {
        await client.deposit(order.id, hash)
      } catch (e) {
        setError((e as Error).message)
        return
      }
    }
    onSent(order.id)
  }

  return { send, sentManually, sending, error, manualHash, setManualHash }
}
