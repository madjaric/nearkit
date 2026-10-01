import { detectTrades, type NormalizedTx } from '@/services/near/flows'
import { fetchAccountTxs, fetchFullTxs } from '@/services/near/history'
import type { TokenTrade } from '@/types/domain'
import type { NearContext } from './context'

/**
 * A token's recent buys and sells, from the chain's own record: FastNEAR's transaction index
 * lists the latest transactions that touched the token's contract, each is read in full, and
 * flows.ts (the same code as positions, PnL and the buy bot) says who bought or sold the token
 * in it. Only trades against NEAR (or wNEAR) are shown, with what each actually paid or got:
 * a transfer, a mint, or a trade against another token is never labelled a buy or a sell.
 */

/** The latest transactions read per refresh. */
const LATEST = 40
/** Transactions remembered across refreshes, so each is read once. */
const REMEMBERED = 600

type Read = Omit<TokenTrade, 'hash' | 'at'>[]

/** The token's trades against NEAR in one transaction (none when it isn't one). */
export function nearTrades(tx: NormalizedTx, token: string, wrapContract: string): Read {
  return detectTrades(tx, token, { wrapContract }).flatMap((t) => {
    // The other side of the trade: NEAR alone (wNEAR folded in); anything else isn't priced in NEAR.
    const other = t.side === 'buy' ? t.paid : t.received
    const near = other.length === 1 && other[0]?.asset === 'near' ? other[0].amount : null
    return near === null ? [] : [{ side: t.side, account: t.account, amount: t.amount.toString(), near: near.toString() }]
  })
}

export function createTokenActivity(ctx: NearContext) {
  const read = new Map<string, Read>()
  const noPause = () => Promise.resolve()

  return {
    /** Newest first; empty when none of the latest transactions is a trade. Throws when the index can't be read. */
    async recent(token: string, txUrl: string): Promise<TokenTrade[]> {
      const { txs } = await fetchAccountTxs(ctx.fetch, txUrl, token, { max: LATEST, pageSize: LATEST, pace: noPause })
      const fresh = txs.filter((t) => !read.has(`${token}|${t.hash}`))
      if (fresh.length) {
        const full = await fetchFullTxs(ctx.fetch, txUrl, fresh)
        for (const tx of full) read.set(`${token}|${tx.hash}`, nearTrades(tx, token, ctx.network.wrapContract))
      }
      // Forget the oldest reads.
      for (const key of [...read.keys()].slice(0, Math.max(0, read.size - REMEMBERED))) read.delete(key)
      return txs.flatMap((t) => (read.get(`${token}|${t.hash}`) ?? []).map((trade) => ({ hash: t.hash, at: t.timestampMs, ...trade }))).sort((a, b) => b.at - a.at)
    },
  }
}
