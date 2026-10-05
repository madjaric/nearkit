import { U128_MAX } from '@/lib/amounts'
import { NearKitError, toNearKitError } from './errors'
import { readJson, writeJson } from './localStore'
import { RpcError, type RpcClient } from './rpc'

/**
 * NEP-141 reads. A contract is only a token to NearKit if its `ft_metadata`
 * validates (NEP-148: name, symbol, integer decimals 0–255); anything else is an
 * INVALID_TOKEN error for that one contract, never a crash of the list.
 * Decimals always come from here, never from a hardcoded table.
 */

export interface FtMetadata {
  spec: string
  name: string
  symbol: string
  decimals: number
  /** Image data URL only (NEP-148 requires data URLs); anything else is dropped. */
  icon: string | null
}

export const MAX_ICON_LENGTH = 65_536
const ICON = /^data:image\/(svg\+xml|png|jpeg|webp|gif)(;[a-z0-9=;+-]*)?,/i
/** An https image URL as a token's metadata may name one: no spaces, quotes or angle brackets. */
const HTTPS_ICON = /^https:\/\/[^\s"'<>`]+$/i
const MAX_ICON_URL_LENGTH = 2_048
// C0/C1 controls, zero-width and bidi overrides: never trust display text from a contract.
const UNSAFE_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
]

function stripUnsafe(text: string): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (!UNSAFE_RANGES.some(([lo, hi]) => code >= lo && code <= hi)) out += ch
  }
  return out
}

/** A token's icon: an inline image (data URL), or a plain https image URL. Shown in an <img> only, never as markup. */
export function sanitizeIcon(icon: unknown): string | null {
  if (typeof icon !== 'string' || icon.length > MAX_ICON_LENGTH) return null
  if (ICON.test(icon)) return icon
  return icon.length <= MAX_ICON_URL_LENGTH && HTTPS_ICON.test(icon) ? icon : null
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const text = stripUnsafe(value).trim()
  return text ? text.slice(0, max) : null
}

export function validateMetadata(raw: unknown): { ok: true; value: FtMetadata } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'ft_metadata returned no metadata object' }
  const m = raw as Record<string, unknown>
  const name = cleanText(m.name, 64)
  if (!name) return { ok: false, error: 'ft_metadata has no name' }
  const symbol = cleanText(m.symbol, 32)
  if (!symbol) return { ok: false, error: 'ft_metadata has no symbol' }
  const decimals = m.decimals
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 255)
    return { ok: false, error: 'ft_metadata decimals must be an integer from 0 to 255' }
  return { ok: true, value: { spec: typeof m.spec === 'string' ? m.spec.slice(0, 32) : '', name, symbol, decimals, icon: sanitizeIcon(m.icon) } }
}

/** U128 as NEP-141 returns it: a base-10 string. */
export function parseU128(value: unknown): bigint {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value) || value.length > 39) throw new Error(`Not a U128 string: ${String(value).slice(0, 60)}`)
  const n = BigInt(value)
  if (n > U128_MAX) throw new Error('U128 overflow')
  return n
}

export interface TokenReader {
  /** `fresh` skips every cache: plans use it so decimals always come from chain at signing time. */
  metadata(contract: string, options?: { fresh?: boolean }): Promise<FtMetadata>
  balanceOf(contract: string, accountId: string): Promise<bigint>
  totalSupply(contract: string): Promise<bigint>
}

const METADATA_TTL_MS = 24 * 60 * 60 * 1000

interface CachedMetadata {
  at: number
  value: FtMetadata
}

const isCached = (v: unknown): v is CachedMetadata =>
  typeof v === 'object' && v !== null && typeof (v as CachedMetadata).at === 'number' && validateMetadata((v as CachedMetadata).value).ok

function invalid(contract: string, reason: string, cause?: unknown): NearKitError {
  return new NearKitError('INVALID_TOKEN', `${contract} is not a valid NEP-141 token`, { detail: reason, cause })
}

/** Transport problems stay RPC errors; everything the contract itself says makes it an invalid token. */
function viewError(contract: string, e: unknown): NearKitError {
  if (e instanceof RpcError && e.kind === 'transport') return toNearKitError(e)
  if (e instanceof RpcError && e.causeName === 'UNKNOWN_ACCOUNT') return invalid(contract, 'No such account on this network', e)
  return invalid(contract, e instanceof Error ? e.message : String(e), e)
}

export function createTokenReader(rpc: RpcClient, options: { network: string; persist: boolean }): TokenReader {
  const memory = new Map<string, FtMetadata>()
  const key = (contract: string) => `nearkit:${options.network}:ftmeta:${contract}`

  const view = async <T>(contract: string, method: string, args: Record<string, unknown> = {}) => {
    try {
      return await rpc.viewFunction<T>(contract, method, args)
    } catch (e) {
      throw viewError(contract, e)
    }
  }

  return {
    async metadata(contract, { fresh = false } = {}) {
      const hot = fresh ? undefined : memory.get(contract)
      if (hot) return hot
      if (options.persist && !fresh) {
        const cached = readJson(key(contract), isCached)
        const age = cached ? Date.now() - cached.at : -1
        // A timestamp in the future is forged or broken: never trust it.
        if (cached && age >= 0 && age < METADATA_TTL_MS) {
          memory.set(contract, cached.value)
          return cached.value
        }
      }
      const raw = await view<unknown>(contract, 'ft_metadata')
      const checked = validateMetadata(raw)
      if (!checked.ok) throw invalid(contract, checked.error)
      memory.set(contract, checked.value)
      if (options.persist) writeJson(key(contract), { at: Date.now(), value: checked.value } satisfies CachedMetadata)
      return checked.value
    },

    async balanceOf(contract, accountId) {
      const raw = await view<unknown>(contract, 'ft_balance_of', { account_id: accountId })
      try {
        return parseU128(raw)
      } catch (e) {
        throw invalid(contract, `ft_balance_of: ${e instanceof Error ? e.message : String(e)}`)
      }
    },

    async totalSupply(contract) {
      const raw = await view<unknown>(contract, 'ft_total_supply')
      try {
        return parseU128(raw)
      } catch (e) {
        throw invalid(contract, `ft_total_supply: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  }
}
