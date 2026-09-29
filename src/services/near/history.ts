import type { LedgerEvent } from '@/lib/pnl'
import { accountLegs, flowsOf, fromFastnear, type Flow, type NormalizedTx } from './flows'

/**
 * An account's history as PnL ledger events, from the chain's own record: FastNEAR's
 * transaction index lists every transaction the account took part in (as signer,
 * receiver, action argument or event log), each is read in full, and flows.ts says
 * what the account gained and gave up. Classification, per token:
 *
 * - gained a token and gave up NEAR (and/or a USD stablecoin): a BUY valued at what
 *   was paid, plus the gas the account paid as signer;
 * - gave up a token and got NEAR (and/or a stablecoin): a SELL valued at what was
 *   received, less that gas;
 * - token for another token: a buy and a sell whose value is unknown (no price for
 *   that moment), flagged instead of guessed;
 * - gained with nothing given up: TRANSFER IN (cost unknown); given up with nothing
 *   gained: TRANSFER OUT.
 * Storage deposits and the 1 yoctoNEAR security deposit are not trade value.
 */

export interface TxRef {
  hash: string
  blockHeight: number
  timestampMs: number
}

export interface LedgerOptions {
  wrapContract: string
  stables: readonly { contract: string; decimals: number }[]
  /** NEAR/USD at a past moment, or null. */
  nearUsdAt: (ms: number) => number | null
}

async function postJson<T>(fetchImpl: typeof fetch, url: string, body: unknown): Promise<T> {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`The transaction index answered ${res.status}`)
  return (await res.json()) as T
}

const defaultPace = () => new Promise<void>((r) => setTimeout(r, 300))

/** The account's transactions, newest first, up to `max`. `complete` is false when there were more. */
export async function fetchAccountTxs(
  fetchImpl: typeof fetch,
  txUrl: string,
  accountId: string,
  options: { max?: number; pageSize?: number; pace?: () => Promise<void> } = {},
): Promise<{ txs: TxRef[]; complete: boolean }> {
  const max = options.max ?? 600
  const pageSize = options.pageSize ?? 200
  const pace = options.pace ?? defaultPace
  const txs: TxRef[] = []
  let resume: string | undefined
  for (;;) {
    const page = await postJson<{ account_txs?: { transaction_hash?: string; tx_block_height?: number; tx_block_timestamp?: string }[]; resume_token?: unknown }>(
      fetchImpl,
      `${txUrl}/v0/account`,
      { account_id: accountId, limit: Math.min(pageSize, max - txs.length), ...(resume ? { resume_token: resume } : {}) },
    )
    for (const t of page.account_txs ?? []) {
      if (typeof t.transaction_hash !== 'string' || typeof t.tx_block_height !== 'number') continue
      const ts = typeof t.tx_block_timestamp === 'string' && /^\d+$/.test(t.tx_block_timestamp) ? Number(BigInt(t.tx_block_timestamp) / 1_000_000n) : 0
      txs.push({ hash: t.transaction_hash, blockHeight: t.tx_block_height, timestampMs: ts })
    }
    const next = typeof page.resume_token === 'string' || typeof page.resume_token === 'number' ? String(page.resume_token) : undefined
    if (!next || !(page.account_txs ?? []).length) return { txs, complete: true }
    if (txs.length >= max) return { txs, complete: false }
    resume = next
    await pace()
  }
}

/** Full transactions for these refs, in batches of 20; ones the index can't serve are skipped. */
export async function fetchFullTxs(fetchImpl: typeof fetch, txUrl: string, refs: readonly TxRef[], pace: () => Promise<void> = defaultPace): Promise<NormalizedTx[]> {
  const out: NormalizedTx[] = []
  const byHash = new Map(refs.map((r) => [r.hash, r]))
  for (let i = 0; i < refs.length; i += 20) {
    if (i > 0) await pace()
    const body = await postJson<{ transactions?: { transaction?: { hash?: string } }[] }>(fetchImpl, `${txUrl}/v0/transactions`, {
      tx_hashes: refs.slice(i, i + 20).map((r) => r.hash),
    })
    for (const t of body.transactions ?? []) {
      const ref = t.transaction?.hash ? byHash.get(t.transaction.hash) : undefined
      if (!ref) continue
      out.push(fromFastnear({ ...t, block_height: ref.blockHeight, block_timestamp: String(BigInt(ref.timestampMs) * 1_000_000n) }))
    }
  }
  return out
}

/** Who the account got a token from (or sent it to), for transfer events. */
function counterparty(flows: readonly Flow[], token: string, account: string, direction: 'in' | 'out'): string | null {
  const f = flows.find((x) => x.asset === token && (direction === 'in' ? x.to === account && x.from : x.from === account && x.to))
  return (direction === 'in' ? f?.from : f?.to) ?? null
}

export function ledgerEvents(tx: NormalizedTx, account: string, options: LedgerOptions): { token: string; event: LedgerEvent }[] {
  const flows = flowsOf(tx, { wrapContract: options.wrapContract })
  const legs = accountLegs(flows, account, options.wrapContract)
  const at = tx.timestampMs ?? tx.blockHeight ?? 0
  const gas = tx.signerId === account ? tx.gasBurnt : 0n
  const stable = new Map(options.stables.map((s) => [s.contract, s.decimals]))
  const nearDelta = legs.get('near') ?? 0n
  const tokens = [...legs.keys()].filter((a) => a !== 'near')
  const gained = tokens.filter((t) => (legs.get(t) as bigint) > 0n)
  const lost = tokens.filter((t) => (legs.get(t) as bigint) < 0n)
  const nearUsd = tx.timestampMs ? options.nearUsdAt(tx.timestampMs) : null
  const events: { token: string; event: LedgerEvent }[] = []
  const base = (token: string) => ({ at, tx: tx.hash, amount: (legs.get(token) as bigint) < 0n ? -(legs.get(token) as bigint) : (legs.get(token) as bigint) })

  /** What the other side of the trade was worth: exact NEAR, NEAR × the hour's price, stablecoins at face. */
  function value(near: bigint, stables: string[], gasSign: 1n | -1n): { near: bigint | null; usd: number | null } {
    const face = stables.reduce((s, t) => {
      const d = legs.get(t) as bigint
      return s + Number(d < 0n ? -d : d) / 10 ** (stable.get(t) as number)
    }, 0)
    const nearTotal = near + gasSign * gas
    const nearPart = near !== 0n ? (nearUsd === null ? null : (Number(nearTotal) / 1e24) * nearUsd) : (Number(gasSign * gas) / 1e24) * (nearUsd ?? 0)
    return {
      near: stables.length ? null : nearTotal,
      usd: near !== 0n && nearPart === null ? null : (nearPart ?? 0) + face,
    }
  }

  // Tokens gained with something given up: buys. Several gained at once can't share one price.
  const paidStables = lost.filter((t) => stable.has(t))
  const paidTokens = lost.filter((t) => !stable.has(t))
  const gotStables = gained.filter((t) => stable.has(t))
  const gotTokens = gained.filter((t) => !stable.has(t))

  if (gained.length && (nearDelta < 0n || lost.length)) {
    const priced = gained.length === 1 && !paidTokens.length
    for (const t of gained) {
      // A stablecoin bought with NEAR: priced like any buy. Paid with a stablecoin: USD at face.
      const v = priced ? value(nearDelta < 0n ? -nearDelta : 0n, paidStables, 1n) : { near: null, usd: null }
      events.push({ token: t, event: { kind: 'buy', ...base(t), value: v } })
    }
    for (const t of lost) {
      // What was given up is itself sold: at face for a stablecoin, otherwise at an unknown price.
      const v = stable.has(t) && gotTokens.length <= 1 ? { near: null, usd: Number(-(legs.get(t) as bigint)) / 10 ** (stable.get(t) as number) } : { near: null, usd: null }
      events.push({ token: t, event: { kind: 'sell', ...base(t), value: v } })
    }
    return events
  }
  if (lost.length && (nearDelta > 0n || gained.length)) {
    const priced = lost.length === 1 && !gotTokens.length
    for (const t of lost) {
      const v = priced ? value(nearDelta > 0n ? nearDelta : 0n, gotStables, -1n) : { near: null, usd: null }
      events.push({ token: t, event: { kind: 'sell', ...base(t), value: v } })
    }
    return events
  }
  for (const t of gained) events.push({ token: t, event: { kind: 'transfer-in', ...base(t), counterparty: counterparty(flows, t, account, 'in') } })
  for (const t of lost) events.push({ token: t, event: { kind: 'transfer-out', ...base(t), counterparty: counterparty(flows, t, account, 'out') } })
  return events
}
