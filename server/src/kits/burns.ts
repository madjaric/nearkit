import { KIT_LAUNCHPAD, KITS_CONTRACT } from '@/config/kit'
import type { NetworkConfig } from '@/config/networks'
import { fromFastnear, isComplete, type NormalizedTx } from '@/services/near/flows'
import type { RpcClient } from '@/services/near/rpc'
import type { KitsBurn, KitsBurnKind, KitsBurnView } from '@/services/kitsBurns'
import type { Logger } from '../log'

/**
 * $KITS' Buyback & Burn, read from NEAR mainnet the way Nearly itself accounts it, and checked.
 *
 * How the burn works on chain (read from the contracts and their transactions, 2026-10-08):
 * kits.nearlytrade.near takes its 2% buy and sell tax in KITS and holds it (`get_tax`: `pending`).
 * Its tax admin, Nearly's launchpad nearlytrade.near, collects it (`collect_tax` → the token's
 * `tax_take`, an ft_transfer to the launchpad, memo "tax", and a `tax_collected` event), then
 * `process_tax` burns the Buyback & Burn share with the token's `burn` (an NEP-141 ft_burn event,
 * owner nearlytrade.near, and the launchpad's own `tax_burned` event for the launch) and hands the
 * rest to its tax seller for NEAR. The tax is already KITS, so the burn needs no market buyback.
 *
 * What is served, from where:
 * - totals from chain state (RPC views): the launchpad's `get_tax({launch_id})` (`burned`: what
 *   Nearly's own pages show), the launch's minted supply (`get_launch_by_token`), and the token's
 *   `ft_total_supply`. Every burn lowers the supply, so launch supply − supply is all ever burned.
 * - the burns themselves: NearBlocks lists the token's `burn` calls; each one is then checked on its
 *   transaction (FastNEAR's record of it): an ft_burn event the token contract itself emitted, in a
 *   receipt that succeeded, of exactly the listed amount. The verified burns must add up to the supply
 *   burned for the history to count as complete.
 * Nothing is taken from the client: the route takes no input, and only kits.nearlytrade.near on
 * mainnet is ever read.
 */

export interface BurnCandidate {
  tx: string
  /** When the burn receipt executed (ms). */
  at: number
  /** The amount the `burn` call asked for (raw). */
  amount: string
  /** Who called `burn`. */
  by: string
}

const DIGITS = /^\d{1,40}$/
const HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/
/** How many burns the history keeps and serves (newest first). */
export const MAX_BURNS = 50
const PAGE = 25
const MAX_PAGES = 8

/** The token's `burn` calls NearBlocks lists: successful calls on the token itself, with a positive amount and a time. */
export function nearblocksBurns(json: unknown, token: string): BurnCandidate[] {
  const txns = (json as { txns?: unknown } | null)?.txns
  if (!Array.isArray(txns)) throw new Error('NearBlocks answered without a transaction list')
  const out: BurnCandidate[] = []
  const seen = new Set<string>()
  for (const raw of txns) {
    const t = (raw ?? {}) as {
      transaction_hash?: unknown
      receiver_account_id?: unknown
      predecessor_account_id?: unknown
      outcomes?: { status?: unknown }
      actions?: { method?: unknown; args?: unknown }[]
      receipt_block?: { block_timestamp?: unknown }
      block_timestamp?: unknown
    }
    if (typeof t.transaction_hash !== 'string' || !HASH.test(t.transaction_hash) || seen.has(t.transaction_hash)) continue
    if (t.receiver_account_id !== token || t.outcomes?.status !== true) continue
    const call = Array.isArray(t.actions) ? t.actions.find((a) => a?.method === 'burn') : undefined
    if (!call || typeof call.args !== 'string') continue
    let amount: unknown
    try {
      amount = (JSON.parse(call.args) as { amount?: unknown }).amount
    } catch {
      continue
    }
    if (typeof amount !== 'string' || !DIGITS.test(amount) || BigInt(amount) === 0n) continue
    const ns = t.receipt_block?.block_timestamp ?? t.block_timestamp
    const at = typeof ns === 'string' && /^\d+$/.test(ns) ? Number(BigInt(ns) / 1_000_000n) : typeof ns === 'number' && Number.isFinite(ns) ? Math.floor(ns / 1e6) : 0
    if (at <= 0) continue
    seen.add(t.transaction_hash)
    out.push({ tx: t.transaction_hash, at, amount, by: typeof t.predecessor_account_id === 'string' ? t.predecessor_account_id : '' })
  }
  return out
}

interface EventJson {
  standard?: unknown
  event?: unknown
  data?: unknown
}

function eventsOf(logs: readonly string[]): EventJson[] {
  const out: EventJson[] = []
  for (const line of logs) {
    if (!line.startsWith('EVENT_JSON:')) continue
    try {
      const e = JSON.parse(line.slice('EVENT_JSON:'.length)) as EventJson
      if (e && typeof e === 'object') out.push(e)
    } catch {
      // not an event this reads
    }
  }
  return out
}

const entries = (e: EventJson): Record<string, unknown>[] => (Array.isArray(e.data) ? e.data.filter((d): d is Record<string, unknown> => !!d && typeof d === 'object') : [])

/**
 * A listed burn, checked on its transaction: the ft_burn events the token contract emitted in receipts
 * that succeeded must add up to exactly the listed amount. A tax burn is one the launchpad made and
 * recorded for this launch (its `tax_burned` event, same amount). Null: not proven, so not served.
 */
export function verifyBurn(tx: NormalizedTx, c: BurnCandidate, ids: { token: string; launchpad: string; launchId: string }): KitsBurn | null {
  if (tx.hash !== c.tx || !isComplete(tx)) return null
  const burned = tx.receipts
    .filter((r) => r.executorId === ids.token && r.receiverId === ids.token && r.success)
    .flatMap((r) => eventsOf(r.logs))
    .filter((e) => e.standard === 'nep141' && e.event === 'ft_burn')
    .flatMap(entries)
  if (!burned.length || burned.some((b) => typeof b.amount !== 'string' || !DIGITS.test(b.amount) || typeof b.owner_id !== 'string')) return null
  const total = burned.reduce((s, b) => s + BigInt(b.amount as string), 0n)
  if (total !== BigInt(c.amount)) return null
  const byLaunchpad = burned.every((b) => b.owner_id === ids.launchpad)
  const recorded = tx.receipts
    .filter((r) => r.executorId === ids.launchpad && r.success)
    .flatMap((r) => eventsOf(r.logs))
    .filter((e) => e.standard === 'nearpad' && e.event === 'tax_burned')
    .flatMap(entries)
    .some((d) => String(d.id) === ids.launchId && d.amount === c.amount)
  const kind: KitsBurnKind = byLaunchpad && recorded ? 'tax' : 'other'
  return { tx: c.tx, at: c.at, amount: c.amount, kind }
}

interface ChainState {
  launchId: string
  decimals: number
  launchSupply: string
  supply: string
  burnedByTax: string
  readAt: number
}

export interface KitsBurnTrackerDeps {
  rpc: Pick<RpcClient, 'viewFunction'>
  fetch: typeof fetch
  network: Pick<NetworkConfig, 'id' | 'kitsContract' | 'discovery'>
  now?: () => number
  log?: Pick<Logger, 'warn'>
  /** How long chain state is served before it is read again. */
  stateTtlMs?: number
  /** How long the burn list is served before NearBlocks is asked again. */
  historyTtlMs?: number
}

const digits = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !DIGITS.test(v)) throw new Error(`${what} is not a whole number`)
  return v
}

export function createKitsBurnTracker(deps: KitsBurnTrackerDeps) {
  const { rpc, network } = deps
  if (network.id !== 'mainnet' || network.kitsContract !== KITS_CONTRACT) throw new Error(`$KITS burns are read on NEAR mainnet, for ${KITS_CONTRACT} only`)
  const token = KITS_CONTRACT
  const launchpad = KIT_LAUNCHPAD
  const now = deps.now ?? Date.now
  const stateTtl = deps.stateTtlMs ?? 60_000
  const historyTtl = deps.historyTtlMs ?? 120_000
  const nearblocks = network.discovery.nearblocksUrl
  const fastnear = network.discovery.fastnearTxUrl

  let state: ChainState | null = null
  /** Verified burns by transaction; a transaction checked and refused is kept as null so it isn't fetched again. */
  const checked = new Map<string, KitsBurn | null>()
  let historyAt: number | null = null
  let last: KitsBurnView | null = null
  let inflight: Promise<KitsBurnView> | null = null

  /** Chain state, validated: the launchpad is the token's tax admin, the launch is this token's, and the figures hold together. */
  async function readState(): Promise<ChainState> {
    const [tax, launch, supply, metadata] = await Promise.all([
      rpc.viewFunction<{ tax?: { admin?: unknown } }>(token, 'get_tax', {}, 'final'),
      rpc.viewFunction<{ id?: unknown; token?: unknown; total_supply?: unknown }>(launchpad, 'get_launch_by_token', { token }, 'final'),
      rpc.viewFunction<unknown>(token, 'ft_total_supply', {}, 'final'),
      rpc.viewFunction<{ decimals?: unknown; symbol?: unknown }>(token, 'ft_metadata', {}, 'final'),
    ])
    if (tax?.tax?.admin !== launchpad) throw new Error(`${launchpad} is not ${token}'s tax admin`)
    if (!launch || launch.token !== token || (typeof launch.id !== 'number' && typeof launch.id !== 'string') || !/^\d+$/.test(String(launch.id)))
      throw new Error(`${launchpad} has no launch for ${token}`)
    const launchId = String(launch.id)
    const accounts = await rpc.viewFunction<{ burned?: unknown }>(launchpad, 'get_tax', { launch_id: launchId }, 'final')
    const decimals = metadata?.decimals
    if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 36 || metadata?.symbol !== 'KITS')
      throw new Error(`${token}'s metadata is not $KITS'`)
    const launchSupply = digits(launch.total_supply, 'the launch supply')
    const now_ = digits(supply, 'the supply')
    const burnedByTax = digits(accounts?.burned, 'the tax burned')
    if (BigInt(now_) > BigInt(launchSupply)) throw new Error('the supply is above the launch supply')
    if (BigInt(burnedByTax) > BigInt(launchSupply) - BigInt(now_)) throw new Error('the launchpad reports more burned than the supply lost')
    return { launchId, decimals, launchSupply, supply: now_, burnedByTax, readAt: now() }
  }

  /** NearBlocks' newest burn calls, paging back until it reaches burns already checked (or runs out). */
  async function candidates(): Promise<BurnCandidate[]> {
    const out: BurnCandidate[] = []
    let cursor: string | null = null
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = `${nearblocks}/v1/account/${token}/txns?method=burn&per_page=${PAGE}&order=desc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const res = await deps.fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
      if (!res.ok) throw new Error(`NearBlocks answered ${res.status}`)
      const json = (await res.json()) as { cursor?: unknown }
      const list = nearblocksBurns(json, token)
      out.push(...list)
      const known = list.some((c) => checked.has(c.tx))
      cursor = typeof json.cursor === 'string' || typeof json.cursor === 'number' ? String(json.cursor) : null
      if (known || !cursor || list.length === 0 || out.length >= MAX_BURNS) break
    }
    return out
  }

  /** Checks every burn not checked yet on its transaction (FastNEAR), 20 at a time. */
  async function verifyNew(list: readonly BurnCandidate[], launchId: string) {
    const fresh = list.filter((c) => !checked.has(c.tx))
    for (let i = 0; i < fresh.length; i += 20) {
      const batch = fresh.slice(i, i + 20)
      const res = await deps.fetch(`${fastnear}/v0/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tx_hashes: batch.map((c) => c.tx) }),
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) throw new Error(`FastNEAR answered ${res.status}`)
      const body = (await res.json()) as { transactions?: unknown[] }
      const txs = new Map<string, NormalizedTx>()
      for (const raw of body.transactions ?? []) {
        try {
          const tx = fromFastnear(raw)
          txs.set(tx.hash, tx)
        } catch {
          // a record this can't read: its burn stays unchecked
        }
      }
      for (const c of batch) {
        const tx = txs.get(c.tx)
        // Not served yet (still executing, or not indexed): asked again next time.
        if (!tx || !isComplete(tx)) continue
        checked.set(c.tx, verifyBurn(tx, c, { token, launchpad, launchId }))
      }
    }
  }

  async function refresh(): Promise<KitsBurnView> {
    const t = now()
    if (!state || t - state.readAt >= stateTtl) state = await readState()
    const s = state
    if (historyAt === null || t - historyAt >= historyTtl) {
      try {
        await verifyNew(await candidates(), s.launchId)
        historyAt = t
      } catch (e) {
        deps.log?.warn('kits burns: history not read', { error: e instanceof Error ? e.message : String(e) })
      }
    }
    const burns = [...checked.values()].filter((b): b is KitsBurn => b !== null).sort((a, b) => b.at - a.at)
    const burnedTotal = (BigInt(s.launchSupply) - BigInt(s.supply)).toString()
    const verifiedSum = burns.reduce((sum, b) => sum + BigInt(b.amount), 0n)
    return {
      network: 'mainnet',
      token,
      launchpad,
      launchId: s.launchId,
      decimals: s.decimals,
      launchSupply: s.launchSupply,
      supply: s.supply,
      burnedTotal,
      burnedByTax: s.burnedByTax,
      burns: burns.slice(0, MAX_BURNS),
      burnCount: burns.length,
      historyComplete: historyAt !== null && verifiedSum === BigInt(burnedTotal),
      readAt: s.readAt,
      historyReadAt: historyAt,
    }
  }

  return {
    /** The latest reading: read again once its interval has passed (one read at a time); the last good one while the chain doesn't answer. */
    async view(): Promise<KitsBurnView> {
      inflight ??= refresh()
        .then((v) => (last = v))
        .catch((e: unknown) => {
          if (last) {
            deps.log?.warn('kits burns: chain not read, serving the last reading', { error: e instanceof Error ? e.message : String(e) })
            return last
          }
          throw e
        })
        .finally(() => {
          inflight = null
        })
      return inflight
    },
  }
}

export type KitsBurnTracker = ReturnType<typeof createKitsBurnTracker>
