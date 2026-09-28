import { NATIVE_TOKEN_ID } from '@/config/networks'
import { formatUnits } from '@/lib/amounts'
import { formatPrice } from '@/lib/format'
import { accountKind } from '@/lib/validation'
import { accountState } from '@/services/near/account'
import { getJson } from '@/services/near/discovery'
import { NearKitError, toNearKitError } from '@/services/near/errors'
import type { ChainScan, RiskFlag, ScanFact } from '@/types/domain'
import type { NearContext } from './context'
import type { Market } from './market'

/**
 * Token scanner on real data. Every figure says how NearKit knows it: read from
 * chain (verified), reported or computed from an indexer or price feed
 * (derived), or not knowable from public data (unknown). Observations are
 * neutral pointers; there is no safe/scam verdict.
 */

interface AccessKeyList {
  keys?: { public_key: string; access_key: { permission: unknown } }[]
}

/** The all-zeros implicit account: tokens sent there can never move again. */
const BURN_ACCOUNT = '0'.repeat(64)

const pctOf = (part: bigint, whole: bigint) => (whole > 0n ? Number((part * 1_000_000n) / whole) / 10_000 : 0)
const shortHash = (hash: string) => (hash.length > 16 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash)
const DAY_MS = 86_400_000

export function createScanner(ctx: NearContext, market: Market) {
  const indexer = ctx.network.discovery.nearblocksUrl

  async function indexed<T>(path: string, pick: (body: unknown) => T | null): Promise<T | null> {
    try {
      return pick(await getJson(ctx.fetch, `${indexer}${path}`))
    } catch {
      return null
    }
  }

  async function resolve(query: string): Promise<string | null> {
    const q = query.trim().replace(/^\$/, '')
    if (!q) return null
    if (accountKind(q) !== null && q !== NATIVE_TOKEN_ID) return q
    const bySymbol = (await market.listTokens()).find((t) => !t.isNative && t.symbol.toLowerCase() === q.toLowerCase())
    return bySymbol?.contract ?? null
  }

  async function scan(query: string): Promise<ChainScan | null> {
    const contract = await resolve(query)
    if (!contract) return null

    let state
    try {
      state = await accountState(ctx.rpc, contract, 'final')
    } catch (e) {
      throw toNearKitError(e, 'RPC_ERROR')
    }
    if (!state.exists) return null
    if (!state.hasContract) throw new NearKitError('INVALID_TOKEN', `${contract} is an account without a contract, not a token`)

    const [meta, supply] = await Promise.all([ctx.reader.metadata(contract), ctx.reader.totalSupply(contract)])
    const enc = encodeURIComponent(contract)
    const [view, keys, holders, top, created, quote] = await Promise.all([
      ctx.rpc.viewAccount(contract, 'final').catch(() => null),
      ctx.rpc.call<AccessKeyList>('query', { request_type: 'view_access_key_list', finality: 'final', account_id: contract }).catch(() => null),
      indexed(`/v1/fts/${enc}/holders/count`, (b) => {
        const count = (b as { holders?: { count?: unknown }[] }).holders?.[0]?.count
        return typeof count === 'string' && /^\d+$/.test(count) ? Number(count) : null
      }),
      // Eleven, so ten remain when the burn address is among them.
      indexed(`/v1/fts/${enc}/holders?page=1&per_page=11`, (b) => {
        const rows = (b as { holders?: { account?: unknown; amount?: unknown }[] }).holders
        if (!Array.isArray(rows)) return null
        return rows.flatMap((r) =>
          typeof r.account === 'string' && typeof r.amount === 'string' && /^\d+$/.test(r.amount) ? [{ accountId: r.account, raw: BigInt(r.amount) }] : [],
        )
      }),
      indexed(`/v1/account/${enc}`, (b) => {
        const ns = (b as { account?: { created?: { block_timestamp?: unknown } }[] }).account?.[0]?.created?.block_timestamp
        return typeof ns === 'number' && ns > 0 ? Math.floor(ns / 1e6) : null
      }),
      market.quoteFor(contract).catch(() => null),
    ])

    const fullKeys = keys?.keys ? keys.keys.filter((k) => k.access_key.permission === 'FullAccess').length : null
    // Indexer balances must fit inside the on-chain supply; if they don't (lag, bad data), they are not shown.
    // The burn address is listed but not counted as a holder: its tokens can't move.
    const listed = top ? top.slice(0, 11) : null
    const burned = listed?.find((h) => h.accountId === BURN_ACCOUNT) ?? null
    const ranked = listed ? listed.filter((h) => h.accountId !== BURN_ACCOUNT).slice(0, 10) : null
    const topSum = ranked ? ranked.reduce((s, h) => s + h.raw, 0n) : null
    const consistent = listed !== null && listed.length > 0 && topSum !== null && topSum + (burned?.raw ?? 0n) <= supply
    const topHolders = consistent && listed ? listed.slice(0, 10).map((h) => ({ accountId: h.accountId, pct: pctOf(h.raw, supply), burn: h.accountId === BURN_ACCOUNT })) : null
    const top10 = consistent && topSum !== null ? pctOf(topSum, supply) : null
    const burnedPct = consistent && burned ? pctOf(burned.raw, supply) : null
    const age = created !== null ? ctx.now() - created : null

    const rpc = (method: string) => `RPC · ${method}`
    const facts: ScanFact[] = [
      { id: 'contract', label: 'Contract', value: view ? `Deployed · code ${shortHash(view.code_hash)}` : 'Deployed', kind: 'verified', source: rpc('view_account') },
      {
        id: 'upgrade',
        label: 'Full-access keys',
        value: fullKeys === null ? null : fullKeys === 0 ? 'None' : String(fullKeys),
        kind: fullKeys === null ? 'unknown' : 'verified',
        source: rpc('view_access_key_list'),
        note:
          fullKeys === null
            ? 'The key list could not be read'
            : fullKeys === 0
              ? 'The code can only change through the contract’s own methods'
              : 'Whoever holds these keys can deploy new code',
      },
      {
        id: 'supply',
        label: 'Total supply',
        value: `${formatUnits(supply, meta.decimals, { maxFraction: 2, group: true })} ${meta.symbol}`,
        kind: 'verified',
        source: rpc('ft_total_supply'),
      },
      { id: 'decimals', label: 'Decimals', value: String(meta.decimals), kind: 'verified', source: rpc('ft_metadata') },
      {
        id: 'holders',
        label: 'Holders',
        value: holders !== null ? holders.toLocaleString('en-US') : null,
        kind: holders !== null ? 'derived' : 'unknown',
        source: 'NearBlocks indexer',
        note: holders === null ? 'The indexer did not answer' : undefined,
      },
      {
        id: 'top10',
        label: 'Top 10 share',
        value: top10 !== null ? `${top10.toFixed(2)}%` : null,
        kind: top10 !== null ? 'derived' : 'unknown',
        source: 'NearBlocks ranking ÷ on-chain supply',
        note:
          top10 !== null
            ? `Supply held by the ten largest holders${burnedPct !== null ? `, not counting the burn address (the burn address holds ${burnedPct.toFixed(2)}%)` : ''}; pools, bridges and exchanges count as holders`
            : top && top.length
              ? 'NearBlocks’ holder balances don’t add up against the on-chain supply, so they are not shown'
              : 'The indexer did not answer',
      },
      {
        id: 'created',
        label: 'Contract created',
        value: created !== null ? new Date(created).toISOString().slice(0, 10) : null,
        kind: created !== null ? 'derived' : 'unknown',
        source: 'NearBlocks indexer',
      },
      {
        id: 'price',
        label: 'Price',
        value: quote ? `$${formatPrice(quote.priceUsd)}` : null,
        kind: quote ? 'derived' : 'unknown',
        source: ctx.network.rhea.indexerUrl ? 'Rhea price list' : 'No price source on testnet',
        note: quote ? undefined : ctx.network.rhea.indexerUrl ? 'Rhea lists no price for this token' : undefined,
      },
      {
        id: 'liquidity',
        label: 'Pool liquidity',
        value: null,
        kind: 'unknown',
        source: 'Not read yet',
        note: 'NearKit does not read pool depth; a quote shows the price impact for your size',
      },
      {
        id: 'mint',
        label: 'Minting after launch',
        value: null,
        kind: 'unknown',
        source: 'Needs contract source',
        note: 'Compiled code on chain does not say which methods can mint',
      },
      {
        id: 'controls',
        label: 'Pause or blocklist controls',
        value: null,
        kind: 'unknown',
        source: 'Needs contract source',
        note: 'Same limit: only the source code or an audit can tell',
      },
    ]

    const observations: RiskFlag[] = []
    if (fullKeys !== null && fullKeys > 0) {
      observations.push({
        id: 'upgradeable',
        level: 'elevated',
        label: 'Upgradeable by key holders',
        detail: `The contract account has ${fullKeys} full-access ${fullKeys === 1 ? 'key' : 'keys'}. The holder can deploy new code at any time, including code that changes balances or transfers.`,
      })
    }
    if (top10 !== null && top10 >= 50) {
      observations.push({
        id: 'concentrated',
        level: 'elevated',
        label: 'Concentrated supply',
        detail: `Per NearBlocks, the ten largest holders own ${top10.toFixed(1)}% of supply. Check who they are: pools and bridges are common.`,
      })
    }
    if (age !== null && age < 7 * DAY_MS)
      observations.push({ id: 'new', level: 'info', label: 'New contract', detail: `Created ${Math.max(1, Math.round(age / 3_600_000))} hours ago per NearBlocks.` })
    if (holders !== null && holders < 100)
      observations.push({ id: 'few-holders', level: 'info', label: 'Few holders', detail: `NearBlocks counts ${holders} ${holders === 1 ? 'holder' : 'holders'}.` })

    return {
      kind: 'chain',
      query,
      network: ctx.network.id,
      contract,
      symbol: meta.symbol,
      name: meta.name,
      icon: meta.icon,
      decimals: meta.decimals,
      facts,
      topHolders,
      observations,
      scannedAt: ctx.now(),
    }
  }

  async function suggestions(): Promise<{ query: string; label: string }[]> {
    const tokens = await market.listTokens().catch(() => [])
    return tokens
      .filter((t) => !t.isNative && t.contract && t.contract !== ctx.network.wrapContract)
      .slice(0, 4)
      .map((t) => ({ query: t.contract ?? t.id, label: t.symbol }))
  }

  return { scan, suggestions }
}
