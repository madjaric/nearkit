import { RpcError } from '@/services/near/rpc'
import type { ServerNear } from '../near'
import type { ChainAccess } from './chain'
import type { Engine } from './engine'
import type { RecoveryService } from './recovery'
import type { SwapService } from './swap'
import type { TradingSigner } from './signer'
import type { CustodyStore, TradingWallet } from './store'

/**
 * Trading wallets as the bot uses them: create one (idempotently), and read one
 * from chain. Everything a screen shows comes from a fresh chain read; what
 * can't be read is unknown, never zero.
 */

export interface CustodyDeps {
  store: CustodyStore
  signer: TradingSigner
  engine: Engine
  chain: ChainAccess
  /** Quotes for Buy/Sell from the NearKit wallet (the same router the engine re-checks with). */
  swaps: SwapService
  /** Key export requests (the web app signs them with the linked wallet). */
  recovery: RecoveryService
}

/** Wallets one Telegram user may create in a day: abuse protection, not a trading limit. */
export const MAX_WALLETS_PER_DAY = 3

export class WalletLimitError extends Error {
  constructor() {
    super('Too many NearKit wallets created today. Try again tomorrow.')
    this.name = 'WalletLimitError'
  }
}

/** `owner`: the linked wallet (and its verified key) the new wallet answers to for export, backup key and revoke. */
export async function createTradingWallet(
  c: CustodyDeps,
  userId: number,
  network: string,
  now: number,
  owner: { accountId: string; publicKey: string },
): Promise<{ wallet: TradingWallet; created: boolean }> {
  const existing = await c.store.activeWallet(userId, network)
  if (existing) return { wallet: existing, created: false }
  if ((await c.store.countWalletsSince(userId, now - 86_400_000)) >= MAX_WALLETS_PER_DAY) throw new WalletLimitError()
  // Two presses at once each make a key; the store keeps one wallet and the other key is never saved.
  const key = await c.signer.createKey(network)
  return c.store.createWallet({ userId, network, ...key, keyRef: c.signer.keyRef, owner })
}

export interface WalletView {
  /** False until the address first receives NEAR: it then holds nothing (a real zero). */
  exists: boolean | null
  /** Spendable NEAR, or null when it couldn't be read. */
  near: bigint | null
  totalNear: bigint | null
  storageNear: bigint | null
  tokens: { contract: string; raw: bigint; verified: boolean }[]
  /** Full-access keys on the account; null when they couldn't be read. */
  keys: string[] | null
}

export async function accessKeys(near: ServerNear, accountId: string): Promise<string[] | null> {
  try {
    const r = await near.ctx.rpc.call<{ keys?: { public_key?: unknown; access_key?: { permission?: unknown } }[] }>('query', {
      request_type: 'view_access_key_list',
      finality: 'final',
      account_id: accountId,
    })
    return (r?.keys ?? []).filter((k) => k.access_key?.permission === 'FullAccess').map((k) => String(k.public_key))
  } catch (e) {
    if (e instanceof RpcError && e.causeName === 'UNKNOWN_ACCOUNT') return []
    return null
  }
}

export async function readWallet(near: ServerNear, wallet: TradingWallet): Promise<WalletView> {
  near.ctx.balances.invalidate(wallet.accountId)
  const [b, keys] = await Promise.all([near.ctx.balances.get(wallet.accountId).catch(() => null), accessKeys(near, wallet.accountId)])
  const state = b?.state ?? null
  return {
    exists: state ? state.exists : null,
    near: state ? state.availableYocto : null,
    totalNear: state ? state.totalYocto : null,
    storageNear: state ? state.storageYocto : null,
    tokens: b?.fts ?? [],
    keys,
  }
}
