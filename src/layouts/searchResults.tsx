import { ScanSearch, SquareSlash, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { isComingSoon } from '@/config/release'
import { rankTokens } from '@/lib/tokenSearch'
import { looksLikeContract } from '@/lib/validation'
import type { TokenListing } from '@/types/domain'
import { ALL_NAV, COMMANDS } from './nav'

export interface Result {
  id: string
  group: 'Tokens' | 'Scan' | 'Commands' | 'Go to'
  label: ReactNode
  detail?: ReactNode
  to: string
  icon?: LucideIcon
  token?: TokenListing
  /** Leads to a feature the public beta holds back. */
  soon?: boolean
}

/** A pasted contract no list has yet, as read from chain: the token, or why it isn't one (or "checking"). */
export interface ContractLookup {
  token: TokenListing | null
  note: string | null
  state: 'checking' | 'found' | 'not-found'
}

/** A token's own page: price, chart, activity, and Buy / Sell / Send from there. */
const tokenPage = (id: string) => `/token/${encodeURIComponent(id)}`

/** The name, and the contract the token is (native NEAR has none). */
const tokenDetail = (t: TokenListing) => (t.isNative || !t.contract ? 'Native NEAR' : `${t.name} · ${t.contract}`)

/**
 * The search box reads what you type: a symbol, name or contract finds the token, also a
 * contract no list has yet (read from chain, like the swap selector), and opens the token's
 * own page; a contract also offers a scan, and a leading "/" lists the same commands the
 * Telegram bot takes. Finding a token never opens the swap: trading starts from its page.
 */
export function buildResults(raw: string, tokens: TokenListing[], found: ContractLookup | null = null): Result[] {
  const q = raw.trim().toLowerCase()
  if (!q) {
    return tokens
      .filter((t) => !t.isNative)
      .slice(0, 4)
      .map((t) => ({ id: `t-${t.id}`, group: 'Tokens' as const, label: t.symbol, detail: tokenDetail(t), to: tokenPage(t.id), token: t }))
  }
  if (q.startsWith('/')) {
    return COMMANDS.filter((c) => c.command.startsWith(q) || c.label.toLowerCase().includes(q.slice(1))).map((c) => ({
      id: `c-${c.command}`,
      group: 'Commands' as const,
      label: <span className="num">{c.command}</span>,
      detail: c.label,
      to: c.to,
      icon: SquareSlash,
      soon: isComingSoon(c.to.split('?')[0] ?? c.to),
    }))
  }
  // Closest match first: an exact symbol or name before a token whose contract merely contains the query.
  const results: Result[] = rankTokens(tokens, q).map((t) => ({ id: `t-${t.id}`, group: 'Tokens', label: t.symbol, detail: tokenDetail(t), to: tokenPage(t.id), token: t }))
  if (looksLikeContract(q)) {
    // A token read from chain that is in no list of this browser's: its page shows its market like any other's.
    const token = found?.token
    if (token && !results.some((r) => r.token?.id === token.id)) {
      results.push({
        id: `l-${token.id}`,
        group: 'Tokens',
        label: token.symbol,
        detail: `${token.name} · ${token.decimals} decimals · not in your list`,
        to: tokenPage(token.id),
        token,
      })
    }
    // Read and not a token: said so, never a made-up token.
    if (!results.some((r) => r.token) && found?.state === 'not-found') {
      results.push({ id: `n-${q}`, group: 'Tokens', label: 'Token not found', detail: found.note ?? 'No NEP-141 token at this address', to: tokenPage(q) })
    }
    results.push({
      id: `s-${q}`,
      group: 'Scan',
      label: `Scan ${q}`,
      detail: found?.note ?? 'Contract indicators and risk flags',
      to: `/scanner?q=${encodeURIComponent(q)}`,
      icon: ScanSearch,
    })
  }
  for (const item of ALL_NAV) {
    if (item.label.toLowerCase().includes(q) || item.keywords?.some((k) => k.includes(q))) {
      results.push({ id: `p-${item.to}`, group: 'Go to', label: item.label, to: item.to, icon: item.icon, soon: isComingSoon(item.to) })
    }
  }
  return results.slice(0, 9)
}
