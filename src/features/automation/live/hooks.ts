import { useState } from 'react'
import { NATIVE_TOKEN_ID } from '@/config/networks'
import { useKitsFirstToken } from '@/features/trade/useDefaultToken'
import type { TokenRef } from '@/lib/automation/config'
import { useNearKitWallets, useTokens } from '@/services/queries'
import type { TokenListing } from '@/types/domain'
import { tokenRefOf } from './model'

/** The wallet a form starts on: the one chosen, else the first NEARKITS wallet that trades (never a browser wallet). */
export function useWalletChoice(): [string, (id: string) => void] {
  const { data } = useNearKitWallets()
  const [picked, setPicked] = useState<string | null>(null)
  const first = (data?.wallets ?? []).find((w) => !w.frozen)?.id ?? ''
  return [picked ?? first, setPicked]
}

/** The token picker of a NEAR ↔ token automation (NEAR itself is the other side, never the token). */
export function useTokenChoice(): { tokenId: string; setTokenId: (id: string) => void; token: TokenRef | null; listing: TokenListing | undefined } {
  const { data: tokens = [] } = useTokens()
  const fallback = useKitsFirstToken()
  const [picked, setTokenId] = useState<string | null>(null)
  const tokenId = picked ?? (fallback === NATIVE_TOKEN_ID ? '' : fallback)
  const listing = tokens.find((t) => t.id === tokenId)
  return { tokenId, setTokenId, token: tokenRefOf(listing), listing }
}
