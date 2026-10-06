import { accountState } from '@/services/near/account'
import { accessKeyPermission, type AccessKeyPermission } from '@/services/near/nep413'
import { createRpcClient, RpcError, type RpcClient } from '@/services/near/rpc'

/**
 * What the signer asks NEAR itself before it lets a key out of its hands, approves a
 * destination, adds a backup key or erases a key: is this key a full-access key of that
 * account, does that account exist. It asks each RPC provider separately and needs
 * `quorum` of them to give the same answer, with none disagreeing: one lying or lagging
 * provider can't make it export a key, approve a destination or erase a key.
 */

export interface SignerChain {
  permission(accountId: string, publicKey: string): Promise<AccessKeyPermission>
  accountExists(accountId: string): Promise<boolean>
  /** The account's full-access keys (sorted); empty when the account doesn't exist. */
  fullAccessKeys(accountId: string): Promise<string[]>
  /** The account's NEAR (liquid) and stake at final; both zero, `exists` false, when it doesn't exist. */
  accountBalance(accountId: string): Promise<{ exists: boolean; amount: bigint; locked: bigint }>
  /** What `accountId` holds of a NEP-141 token (ft_balance_of at final). */
  tokenBalance(contract: string, accountId: string): Promise<bigint>
}

/** The providers disagreed, or too few answered: nothing is decided, and nothing happens. */
export class ChainUncertainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChainUncertainError'
  }
}

export function createSignerChain(opts: { rpcUrls: readonly string[]; quorum: number; fetch?: typeof fetch; timeoutMs?: number }): SignerChain {
  if (opts.quorum < 1 || opts.quorum > opts.rpcUrls.length) throw new Error(`The signer's RPC quorum (${opts.quorum}) needs at least that many RPC providers`)
  const clients: RpcClient[] = opts.rpcUrls.map((url) => createRpcClient({ urls: [url], fetch: opts.fetch, timeoutMs: opts.timeoutMs ?? 8000 }))

  async function agree<T>(what: string, ask: (rpc: RpcClient) => Promise<T>): Promise<T> {
    const answers = (await Promise.allSettled(clients.map(ask))).flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
    const distinct = new Set(answers.map((a) => JSON.stringify(a)))
    if (distinct.size > 1) throw new ChainUncertainError(`NEAR RPC providers disagree about ${what}`)
    if (answers.length < opts.quorum) throw new ChainUncertainError(`Too few NEAR RPC providers answered about ${what} (${answers.length} of ${opts.quorum} needed)`)
    return answers[0] as T
  }

  return {
    permission: (accountId, publicKey) => agree(`a key of ${accountId}`, (rpc) => accessKeyPermission(rpc, accountId, publicKey)),
    accountExists: (accountId) => agree(`whether ${accountId} exists`, async (rpc) => (await accountState(rpc, accountId, 'final')).exists),
    fullAccessKeys: (accountId) =>
      agree(`the keys of ${accountId}`, async (rpc) => {
        try {
          const r = await rpc.call<{ keys?: { public_key?: unknown; access_key?: { permission?: unknown } }[] }>('query', {
            request_type: 'view_access_key_list',
            finality: 'final',
            account_id: accountId,
          })
          return (r?.keys ?? [])
            .filter((k) => k.access_key?.permission === 'FullAccess')
            .map((k) => String(k.public_key))
            .sort()
        } catch (e) {
          if (e instanceof RpcError && e.causeName === 'UNKNOWN_ACCOUNT') return []
          throw e
        }
      }),
    accountBalance: async (accountId) => {
      const r = await agree(`the balance of ${accountId}`, async (rpc) => {
        const s = await accountState(rpc, accountId, 'final')
        return { exists: s.exists, amount: s.totalYocto.toString(), locked: s.lockedYocto.toString() }
      })
      return { exists: r.exists, amount: BigInt(r.amount), locked: BigInt(r.locked) }
    },
    tokenBalance: async (contract, accountId) => {
      const raw = await agree(`${accountId}'s ${contract} balance`, async (rpc) => {
        const v = await rpc.viewFunction<unknown>(contract, 'ft_balance_of', { account_id: accountId }, 'final')
        if (typeof v !== 'string' || !/^\d{1,40}$/.test(v)) throw new Error(`${contract} answered ft_balance_of with something that isn't a balance`)
        return v
      })
      return BigInt(raw)
    },
  }
}
