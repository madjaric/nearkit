import { RpcError } from '@/services/near/rpc'
import type { ServerNear } from '../near'
import type { ChainAccess } from './chain'
import type { Engine } from './engine'
import type { RecoveryService } from './recovery'
import type { SwapService } from './swap'
import type { TradingSigner } from './signer'
import type { OpsSwitches } from '../ops/switches'
import { MAX_ACTIVE_WALLETS_PER_USER, MAX_WALLET_CREATIONS_PER_DAY } from './limits'
import { ActiveWalletLimitError, type CustodyStore, type TradingWallet } from './store'

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
  /** The kill switches: checked before a quote or a withdrawal is offered, and by the engine at Confirm. */
  ops: OpsSwitches
}

export class WalletLimitError extends Error {
  constructor(readonly kind: 'active' | 'day' | 'used') {
    super(
      kind === 'active'
        ? `You have ${MAX_ACTIVE_WALLETS_PER_USER} NearKit wallets, the most at once. Delete an empty one (🔐 Recovery) to make room.`
        : kind === 'day'
          ? 'Too many NearKit wallets created today. Try again tomorrow.'
          : 'That Create button was already used, and the wallet it made is closed. Tap ➕ New wallet to make another.',
    )
    this.name = 'WalletLimitError'
  }
}

/**
 * A new NearKit wallet in the user's next free slot (up to MAX_ACTIVE_WALLETS_PER_USER).
 * `owner`: the linked wallet (and its verified key) the new wallet answers to for export,
 * backup key and revoke. `createKey`: the Create button's one-time key, so a double tap
 * (or a replayed update) makes one wallet.
 */
export async function createTradingWallet(
  c: CustodyDeps,
  userId: number,
  network: string,
  now: number,
  owner: { accountId: string; publicKey: string },
  createKey: string | null = null,
): Promise<{ wallet: TradingWallet; created: boolean }> {
  if (createKey) {
    const same = await c.store.walletByCreateKey(userId, createKey)
    if (same) return live(same, false)
  }
  if ((await c.store.activeWallets(userId, network)).length >= MAX_ACTIVE_WALLETS_PER_USER) throw new WalletLimitError('active')
  if ((await c.store.countWalletsSince(userId, now - 86_400_000)) >= MAX_WALLET_CREATIONS_PER_DAY) throw new WalletLimitError('day')
  // Each wallet gets its own key, made and sealed by the signer (bound to its owner): no master
  // key, so one exported key reveals nothing about another wallet.
  const key = await c.signer.createKey({ userId, owner })
  // A key that ends up unused (a lost race, a double tap) is erased: its account was never funded.
  const discard = () => c.signer.eraseKey({ accountId: key.accountId, reason: 'deleted' }).catch(() => false)
  let r: { wallet: TradingWallet; created: boolean }
  try {
    r = await c.store.createWallet({ userId, network, accountId: key.accountId, publicKey: key.publicKey, keyRef: key.keyRef, owner, createKey })
  } catch (e) {
    await discard()
    if (e instanceof ActiveWalletLimitError) throw new WalletLimitError('active')
    throw e
  }
  if (!r.created) await discard()
  return live(r.wallet, r.created)
}

/**
 * A button's key stays bound to the wallet it made, even once that wallet is closed:
 * never hand a closed wallet back as if it were usable (its key is erased, so NEAR sent
 * to it now would be out of reach).
 */
function live(wallet: TradingWallet, created: boolean): { wallet: TradingWallet; created: boolean } {
  if (wallet.status !== 'active') throw new WalletLimitError('used')
  return { wallet, created }
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
