import { deletionVerdict, type DeletionVerdict } from '@/lib/walletDust'
import { RpcError } from '@/services/near/rpc'
import { PolicyViolation } from './policy'
import type { ServerNear } from '../near'
import type { ChainAccess } from './chain'
import type { Engine } from './engine'
import type { RecoveryService } from './recovery'
import type { SwapService } from './swap'
import type { TradingSigner } from './signer'
import type { TelegramApprovals } from './telegramApprovals'
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
  /** Approvals in NearKit's Mini App, for wallets with no owner wallet (Telegram signs them). */
  telegram: TelegramApprovals
  /** The kill switches: checked before a quote or a withdrawal is offered, and by the engine at Confirm. */
  ops: OpsSwitches
}

export class WalletLimitError extends Error {
  constructor(readonly kind: 'active' | 'day' | 'used') {
    super(
      kind === 'active'
        ? `You have ${MAX_ACTIVE_WALLETS_PER_USER} NEARKITS wallets, the most at once. Delete an empty one (🔐 Recovery) to make room.`
        : kind === 'day'
          ? 'Too many NEARKITS wallets created today. Try again tomorrow.'
          : 'That Create button was already used, and the wallet it made is closed. Tap ➕ New wallet to make another.',
    )
    this.name = 'WalletLimitError'
  }
}

/**
 * A new NearKit wallet in the user's next free slot (up to MAX_ACTIVE_WALLETS_PER_USER).
 * `owner`: the linked wallet (and its verified key) the new wallet answers to for export,
 * backup key and revoke; null for a wallet with no owner wallet, controlled by the user's
 * Telegram account. `createKey`: the Create button's one-time key, so a double tap (or a
 * replayed update) makes one wallet.
 */
export async function createTradingWallet(
  c: CustodyDeps,
  userId: number,
  network: string,
  now: number,
  owner: { accountId: string; publicKey: string } | null,
  createKey: string | null = null,
): Promise<{ wallet: TradingWallet; created: boolean }> {
  if (createKey) {
    const same = await c.store.walletByCreateKey(userId, createKey)
    if (same) return live(same, false)
  }
  if ((await c.store.activeWallets(userId, network)).length >= MAX_ACTIVE_WALLETS_PER_USER) throw new WalletLimitError('active')
  if ((await c.store.countWalletsSince(userId, now - 86_400_000)) >= MAX_WALLET_CREATIONS_PER_DAY) throw new WalletLimitError('day')
  // Each wallet gets its own key, made and sealed by the signer (bound to its owner, or with none
  // to the user's Telegram account): no master key, so one exported key reveals nothing about another wallet.
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
 * The owner wallet a user's new NearKit wallet answers to: the same rule wherever it is
 * created (the bot, NearKit web).
 * - All of a user's owned NearKit wallets answer to one owner: the wallet the first was created
 *   with (or bound to). A wallet linked later (perhaps by someone holding this Telegram account)
 *   never becomes the owner of a new one; that owner does.
 * - With no owner yet, the user's linked wallet becomes the owner.
 * - With none linked, the new wallet has no owner wallet (linking is optional): allowed only when
 *   the signer checks approvals in the bot's Mini App, or nothing could ever be withdrawn.
 * `undefined`: no owner and none allowed; the user must link a wallet first.
 */
export async function ownerForNewWallet(
  c: Pick<CustodyDeps, 'store'>,
  links: { linkOf(network: string, accountId: string): Promise<{ accountId: string; userId: number; publicKey: string } | null> },
  input: { userId: number; network: string; linked: string | null; approvalsOn: () => Promise<boolean> },
): Promise<{ accountId: string; publicKey: string } | null | undefined> {
  const link = input.linked ? await links.linkOf(input.network, input.linked) : null
  const existing = (await c.store.activeWallets(input.userId, input.network)).find((w) => w.ownerAccount)
  if (existing?.ownerAccount) {
    const ownerLink = await links.linkOf(input.network, existing.ownerAccount)
    return { accountId: existing.ownerAccount, publicKey: ownerLink?.userId === input.userId ? ownerLink.publicKey : (existing.ownerKey ?? link?.publicKey ?? '') }
  }
  if (link && link.userId === input.userId) return { accountId: link.accountId, publicKey: link.publicKey }
  return (await input.approvalsOn()) ? null : undefined
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
  /** Staked NEAR; null when it couldn't be read. */
  lockedNear: bigint | null
  storageNear: bigint | null
  tokens: { contract: string; raw: bigint; verified: boolean }[]
  /** True only when every token the wallet may hold was read on chain. */
  tokensKnown: boolean
  /** The token contracts read on chain (zero balances included): the signer reads them again before erasing a key. */
  checkedTokens: string[]
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
    lockedNear: state ? state.lockedYocto : null,
    storageNear: state ? state.storageYocto : null,
    tokens: b?.fts ?? [],
    tokensKnown: b?.ftComplete ?? false,
    checkedTokens: b?.ftChecked ?? [],
    keys,
  }
}

/** Whether a wallet may be deleted (src/lib/walletDust.ts): never funded, or holding only NEAR dust, and no tokens. */
export function deletionOf(view: WalletView): DeletionVerdict {
  return deletionVerdict({ exists: view.exists, nearYocto: view.totalNear, lockedYocto: view.lockedNear ?? 0n, tokens: view.tokens, tokensKnown: view.tokensKnown })
}

/**
 * Deletes a NEARKITS wallet that holds nothing of value: never funded, or only NEAR dust (under
 * 0.05 NEAR, what sending everything out leaves behind), and no tokens. The one way, for the bot's
 * 🗑 and NEARKITS web alike. The chain is read again now (a deposit may have just arrived); the
 * signer reads the balance and every token found itself before it erases the key; then the wallet
 * is closed, which frees its slot. Dust stays on chain, out of anyone's reach. A wallet holding
 * 0.05 NEAR or more, or any token, is never deleted here.
 */
export async function deleteWallet(c: Pick<CustodyDeps, 'signer' | 'store'>, near: ServerNear, wallet: TradingWallet): Promise<DeletionVerdict> {
  const view = await readWallet(near, wallet)
  const verdict = deletionOf(view)
  if (!verdict.ok) return verdict
  try {
    await c.signer.eraseKey({ accountId: wallet.accountId, reason: 'deleted', tokens: view.checkedTokens })
  } catch (e) {
    if (e instanceof PolicyViolation) return { ok: false, reason: /tokens/.test(e.message) ? 'tokens' : 'near' }
    throw e
  }
  await c.store.closeWallet(wallet.id, 'deleted', verdict.dustYocto > 0n ? { reason: 'dust', dust: verdict.dustYocto.toString() } : { reason: 'never funded' })
  return verdict
}

/** Why a wallet can't be deleted, in the words the web and the bot show. */
export function undeletableText(name: string, reason: 'near' | 'tokens' | 'unknown'): string {
  switch (reason) {
    case 'near':
      return `${name} holds 0.05 NEAR or more, so it isn’t deleted. Send its NEAR out first: what sending everything leaves behind is dust (under 0.05 NEAR), and a wallet holding only dust can be deleted.`
    case 'tokens':
      return `${name} holds tokens, so it isn’t deleted. Send or sell them first: tokens are never treated as dust.`
    case 'unknown':
      return `NEARKITS couldn’t read everything ${name} holds right now, so it isn’t deleted. Try again in a moment.`
  }
}
