import { NATIVE_TOKEN_ID, NEAR_DECIMALS, type NetworkConfig } from '@/config/networks'
import { formatUnits } from '@/lib/amounts'
import { explorerTxUrl } from '@/services/near/explorer'
import { detectTrades, fromRpc, type Trade } from '@/services/near/flows'
import { RpcError, type RpcClient, type RpcTxResult } from '@/services/near/rpc'
import type { Database } from '../db/database'
import { randomToken } from '../ids'
import { bold, esc, link } from '../telegram/html'
import { appFeeEarned } from '@/services/near/outcome'

/**
 * A trade prepared in Telegram and signed in the NearKit web app. The bot hands
 * the user a link carrying the trade's parameters and a random handoff ID; the
 * web app re-quotes, shows its usual review, and the user's wallet signs. The web
 * app then reports the transaction hashes here, and the server believes nothing
 * it is told: each transaction is read from the chain, must be signed by the
 * linked account the handoff was made for, and the amounts are read from the
 * chain's own record (flows.ts). Only then does the bot tell the user.
 */

export const HANDOFF_TTL_MS = 30 * 60_000
/** Results may arrive until then (a slow wallet, a retry). */
const REPORT_WINDOW_MS = 24 * 3_600_000
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/

export type HandoffStatus = 'open' | 'confirmed' | 'failed'

export interface Handoff {
  id: string
  userId: number
  chatId: number
  network: string
  accountId: string
  side: 'buy' | 'sell' | 'swap'
  tokenIn: string
  tokenOut: string
  /** Exact decimal string, as quoted in Telegram. */
  amountIn: string
  slippagePct: number
  createdAt: number
  expiresAt: number
  status: HandoffStatus
  txHashes: string[]
  result: HandoffResult | null
}

export interface HandoffResult {
  outcome: 'traded' | 'no-trade' | 'failed'
  /** What the account received and gave up, from the chain (raw units). */
  trade: { amount: string; token: string; paid: { asset: string; amount: string }[]; received: { asset: string; amount: string }[] } | null
}

export class HandoffError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HandoffError'
  }
}

interface Row {
  id: string
  user_id: number
  chat_id: number
  network: string
  account_id: string
  side: Handoff['side']
  token_in: string
  token_out: string
  amount_in: string
  slippage_pct: number
  created_at: number
  expires_at: number
  status: HandoffStatus
  tx_hashes: string | null
  result: string | null
}

const toHandoff = (r: Row): Handoff => ({
  id: r.id,
  userId: r.user_id,
  chatId: r.chat_id,
  network: r.network,
  accountId: r.account_id,
  side: r.side,
  tokenIn: r.token_in,
  tokenOut: r.token_out,
  amountIn: r.amount_in,
  slippagePct: r.slippage_pct,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  status: r.status,
  txHashes: r.tx_hashes ? (JSON.parse(r.tx_hashes) as string[]) : [],
  result: r.result ? (JSON.parse(r.result) as HandoffResult) : null,
})

/** The swap page link that carries a prepared trade. */
export function handoffUrl(webUrl: string, h: Pick<Handoff, 'id' | 'tokenIn' | 'tokenOut' | 'amountIn' | 'slippagePct'>): string {
  const q = new URLSearchParams({ from: h.tokenIn, to: h.tokenOut, amount: h.amountIn, slippage: String(h.slippagePct), tg: h.id })
  return `${webUrl}/swap?${q.toString()}`
}

export function createHandoffs(deps: {
  db: Database
  network: NetworkConfig
  rpc: RpcClient
  webUrl: string
  now?: () => number
  describeToken: (id: string) => Promise<{ symbol: string; decimals: number }>
  notify: (userId: number, html: string) => Promise<void>
  /** A handoff that traded: the fee NearKit's account received on chain, if any (referral accounting). */
  onTraded?: (t: { handoff: Handoff; fee: { token: string; raw: string; recipient: string } | null; txHash: string }) => Promise<void>
}) {
  const now = deps.now ?? Date.now
  const get = async (id: string): Promise<Handoff | null> => {
    const r = await deps.db.get<Row>('SELECT * FROM handoffs WHERE id = ?', [id])
    return r ? toHandoff(r) : null
  }

  async function amountText(asset: string, raw: bigint): Promise<string> {
    const t = asset === 'near' || asset === NATIVE_TOKEN_ID ? { symbol: 'NEAR', decimals: NEAR_DECIMALS } : await deps.describeToken(asset)
    return `${formatUnits(raw, t.decimals, { maxFraction: 6, group: true })} ${t.symbol}`
  }

  async function readTx(h: Handoff, hash: string): Promise<RpcTxResult> {
    try {
      return await deps.rpc.txStatus(hash, h.accountId, 'FINAL')
    } catch (e) {
      if (e instanceof RpcError && e.causeName === 'UNKNOWN_TRANSACTION')
        throw new HandoffError(409, 'unknown-tx', `Transaction ${hash} signed by ${h.accountId} isn’t on chain (yet). Try again in a moment.`)
      throw new HandoffError(503, 'rpc', 'Couldn’t reach NEAR to check the transaction. Try again in a moment.')
    }
  }

  return {
    get,

    async create(input: Omit<Handoff, 'id' | 'createdAt' | 'expiresAt' | 'status' | 'txHashes' | 'result' | 'network'>): Promise<{ handoff: Handoff; url: string }> {
      const id = randomToken(16)
      const t = now()
      await deps.db.run(
        `INSERT INTO handoffs (id, user_id, chat_id, network, account_id, side, token_in, token_out, amount_in, slippage_pct, created_at, expires_at, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
        [id, input.userId, input.chatId, deps.network.id, input.accountId, input.side, input.tokenIn, input.tokenOut, input.amountIn, input.slippagePct, t, t + HANDOFF_TTL_MS, t],
      )
      const handoff = (await get(id)) as Handoff
      return { handoff, url: handoffUrl(deps.webUrl, handoff) }
    },

    /** What the web app shows about a handoff: who it's for. Nothing else is needed from here. */
    async describe(id: string): Promise<{ accountId: string; network: string; status: HandoffStatus; expiresAt: number }> {
      const h = await get(id)
      if (!h) throw new HandoffError(404, 'unknown', 'This Telegram trade link is unknown.')
      return { accountId: h.accountId, network: h.network, status: h.status, expiresAt: h.expiresAt }
    },

    /** The web app reports what the wallet signed. Idempotent: a settled handoff answers with its outcome. */
    async report(id: string, hashes: unknown): Promise<{ status: HandoffStatus; outcome: HandoffResult['outcome'] | null }> {
      const h = await get(id)
      if (!h) throw new HandoffError(404, 'unknown', 'This Telegram trade link is unknown.')
      if (h.status !== 'open') return { status: h.status, outcome: h.result?.outcome ?? null }
      if (now() - h.createdAt > REPORT_WINDOW_MS) throw new HandoffError(410, 'expired', 'This Telegram trade link is too old to report on.')
      if (!Array.isArray(hashes) || hashes.length === 0 || hashes.length > 8 || !hashes.every((x) => typeof x === 'string' && TX_HASH.test(x)))
        throw new HandoffError(400, 'bad-hashes', 'Send the transaction hashes the wallet returned.')

      const txs = []
      for (const hash of hashes as string[]) {
        const result = await readTx(h, hash)
        if (result.transaction.signer_id !== h.accountId) throw new HandoffError(403, 'signer', `That transaction wasn’t signed by ${h.accountId}.`)
        txs.push({ hash, raw: result, tx: fromRpc(result), failed: !('SuccessValue' in (result.status as object)) })
      }
      // The swap is the last transaction (registrations come first). Read what the account got from it.
      const last = txs[txs.length - 1] as (typeof txs)[number]
      const token = h.side === 'sell' ? h.tokenIn : h.tokenOut
      const trade: Trade | undefined = detectTrades(last.tx, token, { wrapContract: deps.network.wrapContract }).find((t) => t.account === h.accountId)
      const failed = txs.some((t) => t.failed)
      const outcome: HandoffResult['outcome'] = trade ? 'traded' : failed ? 'failed' : 'no-trade'
      const result: HandoffResult = {
        outcome,
        trade: trade
          ? {
              amount: trade.amount.toString(),
              token: trade.token,
              paid: trade.paid.map((l) => ({ asset: l.asset, amount: l.amount.toString() })),
              received: trade.received.map((l) => ({ asset: l.asset, amount: l.amount.toString() })),
            }
          : null,
      }
      const status: HandoffStatus = outcome === 'traded' ? 'confirmed' : 'failed'
      const changed = await deps.db.run(`UPDATE handoffs SET status = ?, tx_hashes = ?, result = ?, updated_at = ? WHERE id = ? AND status = 'open'`, [
        status,
        JSON.stringify(hashes),
        JSON.stringify(result),
        now(),
        id,
      ])
      // Another report settled it first: don't message twice.
      if (changed === 0) {
        const settled = (await get(id)) as Handoff
        return { status: settled.status, outcome: settled.result?.outcome ?? null }
      }

      const links = txs.map((t, i) => link(explorerTxUrl(deps.network, t.hash), txs.length > 1 ? `Transaction ${i + 1}` : 'Transaction')).join(' · ')
      let html: string
      if (trade) {
        const got = await amountText(trade.token, trade.amount)
        const legs = trade.side === 'buy' ? trade.paid : trade.received
        const other = (await Promise.all(legs.map((l) => amountText(l.asset, l.amount)))).join(' + ')
        html =
          trade.side === 'buy'
            ? `✅ ${bold(`Bought ${got}`)} for ${esc(other)}\nAccount ${esc(h.accountId)}\n${links}`
            : `✅ ${bold(`Sold ${got}`)} for ${esc(other)}\nAccount ${esc(h.accountId)}\n${links}`
      } else if (failed) {
        html = `❌ ${bold('The swap failed')} on chain. Nothing was bought or sold; any refund is in the transaction.\n${links}`
      } else {
        html = `⚠️ ${bold('Confirmed, but no swap went through')}: the route was refunded, so the tokens stayed where they were.\n${links}`
      }
      await deps.notify(h.userId, html).catch(() => undefined)
      if (trade && deps.onTraded) {
        const agg = deps.network.rhea.aggregator
        const fee = agg ? appFeeEarned(last.raw, agg.contract) : null
        await deps.onTraded({ handoff: h, fee, txHash: last.hash }).catch(() => undefined)
      }
      return { status, outcome }
    },
  }
}

export type Handoffs = ReturnType<typeof createHandoffs>
