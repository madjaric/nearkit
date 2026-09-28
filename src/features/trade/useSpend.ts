import { NATIVE_TOKEN_ID } from '@/config/networks'
import { formatUnits, fractionOf, tryParseUnits } from '@/lib/amounts'
import { GAS_RESERVE_NEAR, GAS_RESERVE_YOCTO } from '@/lib/fees'
import { floorTo, parseAmount, toInputString } from '@/lib/format'
import { useBalance, useRawBalance, useTokens } from '@/services/queries'
import type { TokenId } from '@/types/domain'

const PRESETS = [0.25, 0.5, 0.75, 1] as const

/**
 * Spend-side amount logic shared by the trade tickets. With an exact raw balance
 * (real mode) every check is exact: the amount must fit the token's decimals,
 * 25/50/75/MAX are exact fractions, and MAX on NEAR keeps the gas/storage
 * reserve (never empties the account). Demo balances fall back to display math.
 */
export function useSpend(walletId: string, tokenId: TokenId, amountText: string, connected: boolean) {
  const { data: tokens = [] } = useTokens()
  const token = tokens.find((t) => t.id === tokenId)
  const isNear = tokenId === NATIVE_TOKEN_ID
  const balance = useBalance(walletId, tokenId)
  const raw = useRawBalance(walletId, tokenId)
  const decimals = token?.decimals

  const rawBig = raw !== null ? BigInt(raw) : null
  const maxRaw = rawBig !== null ? (isNear ? (rawBig > GAS_RESERVE_YOCTO ? rawBig - GAS_RESERVE_YOCTO : 0n) : rawBig) : null
  const maxSpend = isNear ? Math.max(0, floorTo(balance - GAS_RESERVE_NEAR, 4)) : balance

  const presetText = (f: number): string =>
    maxRaw !== null && decimals !== undefined
      ? formatUnits(fractionOf(maxRaw, Math.round(f * 100), 100), decimals)
      : toInputString(floorTo(maxSpend * f, isNear ? 4 : 2), isNear ? 4 : 2)

  const amount = parseAmount(amountText) ?? 0
  const trimmed = amountText.trim()
  const parsed = decimals !== undefined && trimmed !== '' ? tryParseUnits(trimmed, decimals) : null
  const precisionError = parsed && !parsed.ok ? parsed.error.message : null
  const exact = parsed?.ok ? parsed.value : null

  const insufficient = connected && (exact !== null && rawBig !== null ? exact > rawBig : amount > balance + 1e-9)
  const eatsGas = isNear && !insufficient && (exact !== null && maxRaw !== null ? exact > maxRaw : amount > maxSpend + 1e-9)
  const activeFraction = amount > 0 && (maxRaw !== null ? maxRaw > 0n : maxSpend > 0) ? (PRESETS.find((f) => presetText(f) === trimmed) ?? null) : null

  return { token, balance, maxSpend: maxRaw !== null ? maxRaw > 0n : maxSpend > 0, amount, precisionError, insufficient, eatsGas, activeFraction, presetText }
}
