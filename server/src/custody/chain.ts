import { base58Decode } from '@/lib/encoding'
import { accountState } from '@/services/near/account'
import { createRpcClient, RpcError, type RpcClient, type RpcTxResult } from '@/services/near/rpc'

/**
 * What the trading-wallet engine asks the chain: a key's nonce, a block to anchor
 * a transaction to, what a wallet can spend, sending signed bytes, and a
 * transaction's final status.
 *
 * Anchoring: a NEAR transaction stays valid for `transaction_validity_period`
 * blocks (86,400: about a day) after the block it names. NearKit names a final
 * block that is already almost that old, so a transaction that never lands
 * expires about ANCHOR_WINDOW blocks (about ten minutes) after signing. "Not on
 * chain, and past its expiry height" then proves it never will be, and an
 * uncertain send resolves in minutes instead of a day.
 */

export interface Anchor {
  hash: Uint8Array
  height: number
  /** After this height the transaction can no longer be included. */
  expiresHeight: number
}

export type SendResult =
  | { kind: 'executed'; result: RpcTxResult }
  /** A node refused it before forwarding it anywhere: it can never land. */
  | { kind: 'rejected'; reason: string }
  /** No clear answer (timeout, network trouble): it may or may not land. Never re-signed; resolved from chain. */
  | { kind: 'unknown'; reason: string }

export interface ChainAccess {
  /** Nonce of `publicKey` on `accountId`, or null when the key (or the account) doesn't exist. */
  keyNonce(accountId: string, publicKey: string): Promise<bigint | null>
  anchor(): Promise<Anchor>
  finalHeight(): Promise<number>
  /** NEAR the account can spend in the final state (its balance less the storage it must keep), or null when it doesn't exist. */
  available(accountId: string): Promise<bigint | null>
  send(signedBase64: string): Promise<SendResult>
  /** Final status, or null when the chain doesn't know the hash (yet). Throws when it can't be asked. */
  status(hash: string, signerId: string): Promise<RpcTxResult | null>
  /** True when the chain knows the hash at all (included, even if not final). Throws when it can't be asked. */
  seen(hash: string, signerId: string): Promise<boolean>
}

export const ANCHOR_WINDOW_BLOCKS = 600
const DEFAULT_VALIDITY_BLOCKS = 86_400

interface BlockView {
  header: { height: number; hash: string }
}

const finalOutcome = (r: RpcTxResult | null): boolean => {
  const s = r?.status as Record<string, unknown> | undefined
  return Boolean(s && typeof s === 'object' && ('SuccessValue' in s || 'Failure' in s))
}

export function createChainAccess(opts: { rpc: RpcClient; fetch?: typeof fetch; sendTimeoutMs?: number; windowBlocks?: number }): ChainAccess {
  const { rpc } = opts
  const window = opts.windowBlocks ?? ANCHOR_WINDOW_BLOCKS
  // One client per endpoint: a send must know whether any earlier attempt may have reached the network.
  const senders = rpc.urls.map((url) => createRpcClient({ urls: [url], fetch: opts.fetch, timeoutMs: opts.sendTimeoutMs ?? 20_000 }))
  let validity: Promise<number | null> | null = null

  const validityPeriod = () => {
    validity ??= rpc
      .call<{ transaction_validity_period?: unknown }>('EXPERIMENTAL_genesis_config', {})
      .then((g) => (typeof g?.transaction_validity_period === 'number' && g.transaction_validity_period > 0 ? g.transaction_validity_period : null))
      .catch(() => {
        validity = null
        return null
      })
    return validity
  }

  const block = (params: Record<string, unknown>) => rpc.call<BlockView>('block', params)

  return {
    async keyNonce(accountId, publicKey) {
      try {
        const r = await rpc.call<{ nonce?: unknown }>('query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey })
        return typeof r?.nonce === 'number' || typeof r?.nonce === 'string' ? BigInt(r.nonce) : null
      } catch (e) {
        if (e instanceof RpcError && e.kind !== 'transport' && (e.causeName === 'UNKNOWN_ACCESS_KEY' || e.causeName === 'UNKNOWN_ACCOUNT' || /does not exist/i.test(e.message)))
          return null
        throw e
      }
    },

    async anchor() {
      const [head, period] = await Promise.all([block({ finality: 'final' }), validityPeriod()])
      if (period !== null && period > window * 2) {
        const target = head.header.height - (period - window)
        // A height can be skipped (no block there): try the next few.
        for (let h = target; h < target + 5; h++) {
          try {
            const b = await block({ block_id: h })
            const hash = base58Decode(b.header.hash)
            if (hash && hash.length === 32) return { hash, height: b.header.height, expiresHeight: b.header.height + period }
          } catch (e) {
            if (!(e instanceof RpcError) || e.kind === 'transport') break
          }
        }
      }
      const hash = base58Decode(head.header.hash)
      if (!hash || hash.length !== 32) throw new RpcError('handler', 'The RPC returned a malformed block hash')
      return { hash, height: head.header.height, expiresHeight: head.header.height + (period ?? DEFAULT_VALIDITY_BLOCKS) }
    },

    async finalHeight() {
      return (await block({ finality: 'final' })).header.height
    },

    async available(accountId) {
      const state = await accountState(rpc, accountId, 'final')
      return state.exists ? state.availableYocto : null
    },

    async send(signedBase64) {
      let mayHaveLanded = false
      let last = 'no RPC endpoint configured'
      for (const client of senders) {
        try {
          const result = await client.call<RpcTxResult>('send_tx', { signed_tx_base64: signedBase64, wait_until: 'EXECUTED_OPTIMISTIC' })
          return { kind: 'executed', result }
        } catch (e) {
          last = e instanceof Error ? e.message : String(e)
          if (e instanceof RpcError && e.kind === 'handler') {
            // Refused outright (invalid, or bytes the node can't even parse), and nothing earlier may have
            // reached the network: it can never land.
            if ((e.causeName === 'INVALID_TRANSACTION' || e.causeName === 'PARSE_ERROR') && !mayHaveLanded) return { kind: 'rejected', reason: last }
            return { kind: 'unknown', reason: last }
          }
          // A timeout or transport failure: this node may have forwarded it. The next endpoint gets the
          // same signed bytes (same hash and nonce), which the chain executes at most once.
          mayHaveLanded = true
        }
      }
      return { kind: 'unknown', reason: last }
    },

    async seen(hash, signerId) {
      try {
        await rpc.txStatus(hash, signerId, 'NONE')
        return true
      } catch (e) {
        if (e instanceof RpcError && e.causeName === 'UNKNOWN_TRANSACTION') return false
        throw e
      }
    },

    async status(hash, signerId) {
      try {
        const r = await rpc.txStatus(hash, signerId, 'FINAL')
        return finalOutcome(r) ? r : null
      } catch (e) {
        if (e instanceof RpcError && (e.causeName === 'UNKNOWN_TRANSACTION' || e.causeName === 'TIMEOUT_ERROR')) return null
        throw e
      }
    },
  }
}
