import { Coins, ScanSearch, SquareSlash, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { isKitToken, KIT, type KitConfig } from '@/config/kit'
import { isComingSoon } from '@/config/release'
import { rankTokenList, type RankOptions } from '@/lib/tokenRanking'
import { tokenMatchRank } from '@/lib/tokenSearch'
import { looksLikeContract } from '@/lib/validation'
import type { TokenListing } from '@/types/domain'
import { ALL_NAV, COMMANDS, SEARCH_ONLY_NAV } from './nav'

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

/** $KIT before launch: its page, never a trade (it has no contract yet). */
const kitTeaser = (kit: Pick<KitConfig, 'name' | 'launchVenue'>): Result => ({
  id: 'kit',
  group: 'Tokens',
  label: '$KIT',
  detail: `${kit.name} · launches on ${kit.launchVenue}`,
  to: '/kit',
  icon: Coins,
  soon: true,
})

export interface SearchContext {
  /** NEARKITS' token order, besides the query (src/lib/tokenRanking.ts). */
  rank?: Omit<RankOptions, 'query' | 'selectedId'>
  kit?: Pick<KitConfig, 'name' | 'symbol' | 'launchVenue' | 'status'>
}

/**
 * The search box reads what you type: a symbol, name or contract finds the token, also a
 * contract no list has yet (read from chain, like the swap selector), and opens the token's
 * own page; a contract also offers a scan, and a leading "/" lists the same commands the
 * Telegram bot takes. Finding a token never opens the swap: trading starts from its page.
 * Tokens come in NEARKITS' one order ($KIT, NEAR, what the wallets hold, popular tokens);
 * while $KIT is Coming Soon its page is offered instead, since there is nothing to trade yet.
 */
export function buildResults(raw: string, tokens: TokenListing[], found: ContractLookup | null = null, context: SearchContext = {}): Result[] {
  const q = raw.trim().toLowerCase()
  const kit = context.kit ?? KIT
  const kitSoon = kit.status === 'coming-soon' && !tokens.some((t) => isKitToken(t.id))
  if (!q) {
    const suggested = rankTokenList(tokens, context.rank)
      .filter((t) => !t.isNative)
      .slice(0, kitSoon ? 3 : 4)
      .map((t) => ({ id: `t-${t.id}`, group: 'Tokens' as const, label: t.symbol, detail: tokenDetail(t), to: tokenPage(t.id), token: t }))
    return kitSoon ? [kitTeaser(kit), ...suggested] : suggested
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
  const results: Result[] = rankTokenList(tokens, { ...context.rank, query: q }).map((t) => ({
    id: `t-${t.id}`,
    group: 'Tokens',
    label: t.symbol,
    detail: tokenDetail(t),
    to: tokenPage(t.id),
    token: t,
  }))
  // $KIT's page takes its place by how closely it matches, like any token.
  const kitRank = kitSoon ? tokenMatchRank({ symbol: kit.symbol, name: kit.name, contract: null }, q) : null
  if (kitRank !== null) {
    const after = results.findIndex((r) => r.token !== undefined && (tokenMatchRank(r.token, q) ?? Infinity) > kitRank)
    results.splice(after === -1 ? results.length : after, 0, kitTeaser(kit))
  }
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
  for (const item of [...ALL_NAV, ...SEARCH_ONLY_NAV]) {
    if (results.some((r) => r.to === item.to)) continue
    if (item.label.toLowerCase().includes(q) || item.keywords?.some((k) => k.includes(q))) {
      results.push({ id: `p-${item.to}`, group: 'Go to', label: item.label, to: item.to, icon: item.icon, soon: isComingSoon(item.to) })
    }
  }
  return results.slice(0, 9)
}
