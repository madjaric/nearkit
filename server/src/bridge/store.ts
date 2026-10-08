import type { BridgeChainId } from '@/config/bridge'
import type { BridgeOrderStatus, BridgeQuoteView, BridgeTx } from '@/lib/bridge/types'
import type { Database } from '../db/database'
import { randomToken } from '../ids'

/**
 * Bridge & Buy orders (table bridge_orders): one per deposit address. Created when the user asks
 * for a deposit address, moved by the worker as NEAR Intents reports it, and by the purchase after
 * it. A row holds no key or secret: addresses, amounts, hashes, and 1Click's signed quote.
 */

export interface BridgeStage2 {
  /** The unwrap (wNEAR → NEAR) and the buy, each an engine intent, created once and followed. */
  unwrapIntent?: string | null
  buyIntent?: string | null
  /** NEAR spent on the buy (yocto). */
  nearIn?: string | null
  attempts?: number
}

export interface BridgeOrder {
  id: string
  network: string
  kind: 'nearkits' | 'connected'
  userId: number | null
  walletId: string | null
  recipient: string
  chain: BridgeChainId
  originAsset: string
  sourceAddress: string
  amountIn: string
  depositAddress: string
  depositDeadline: number
  signBy: number
  quote: BridgeQuoteView
  oneclick: Record<string, unknown>
  /** Stage 2's bound: the least raw KITS per whole NEAR the user accepted at review; null: no estimate then. */
  kitsMinPerNear: string | null
  kitsSlippage: number
  status: BridgeOrderStatus
  intentsStatus: string | null
  depositTx: string | null
  delivered: { amount: string; asset: 'wnear' | 'near'; txs: BridgeTx[] } | null
  kits: { amount: string; txs: BridgeTx[] } | null
  refund: { amount: string | null; reason: string | null; txs: BridgeTx[] } | null
  stage2: BridgeStage2
  message: string | null
  nextCheckAt: number | null
  checks: number
  createdAt: number
  updatedAt: number
}

interface Row {
  id: string
  network: string
  kind: 'nearkits' | 'connected'
  user_id: number | string | null
  wallet_id: string | null
  recipient: string
  chain: BridgeChainId
  origin_asset: string
  source_address: string
  amount_in: string
  deposit_address: string
  deposit_deadline: number | string
  sign_by: number | string
  quote: string
  oneclick: string
  kits_min_per_near: string | null
  kits_slippage: number | string
  status: BridgeOrderStatus
  intents_status: string | null
  deposit_tx: string | null
  delivered: string | null
  kits: string | null
  refund: string | null
  stage2: string | null
  message: string | null
  next_check_at: number | string | null
  checks: number | string
  created_at: number | string
  updated_at: number | string
}

const json = <T>(v: string | null): T | null => (v === null ? null : (JSON.parse(v) as T))
const n = (v: number | string): number => Number(v)

function fromRow(r: Row): BridgeOrder {
  return {
    id: r.id,
    network: r.network,
    kind: r.kind,
    userId: r.user_id === null ? null : n(r.user_id),
    walletId: r.wallet_id,
    recipient: r.recipient,
    chain: r.chain,
    originAsset: r.origin_asset,
    sourceAddress: r.source_address,
    amountIn: r.amount_in,
    depositAddress: r.deposit_address,
    depositDeadline: n(r.deposit_deadline),
    signBy: n(r.sign_by),
    quote: JSON.parse(r.quote) as BridgeQuoteView,
    oneclick: JSON.parse(r.oneclick) as Record<string, unknown>,
    kitsMinPerNear: r.kits_min_per_near,
    kitsSlippage: n(r.kits_slippage),
    status: r.status,
    intentsStatus: r.intents_status,
    depositTx: r.deposit_tx,
    delivered: json(r.delivered),
    kits: json(r.kits),
    refund: json(r.refund),
    stage2: json<BridgeStage2>(r.stage2) ?? {},
    message: r.message,
    nextCheckAt: r.next_check_at === null ? null : n(r.next_check_at),
    checks: n(r.checks),
    createdAt: n(r.created_at),
    updatedAt: n(r.updated_at),
  }
}

export type NewBridgeOrder = Omit<
  BridgeOrder,
  'id' | 'status' | 'intentsStatus' | 'depositTx' | 'delivered' | 'kits' | 'refund' | 'stage2' | 'message' | 'checks' | 'createdAt' | 'updatedAt'
>

/** Fields the worker and the purchase move; anything else of an order never changes after it is created. */
export type BridgeOrderPatch = Partial<
  Pick<BridgeOrder, 'status' | 'intentsStatus' | 'depositTx' | 'delivered' | 'kits' | 'refund' | 'stage2' | 'message' | 'nextCheckAt' | 'checks'>
>

const COLUMNS: Record<keyof BridgeOrderPatch, string> = {
  status: 'status',
  intentsStatus: 'intents_status',
  depositTx: 'deposit_tx',
  delivered: 'delivered',
  kits: 'kits',
  refund: 'refund',
  stage2: 'stage2',
  message: 'message',
  nextCheckAt: 'next_check_at',
  checks: 'checks',
}
const JSON_FIELDS = new Set<keyof BridgeOrderPatch>(['delivered', 'kits', 'refund', 'stage2'])

export class BridgeStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  async create(o: NewBridgeOrder): Promise<BridgeOrder> {
    const id = randomToken(16)
    const t = this.now()
    await this.db.run(
      `INSERT INTO bridge_orders (id, network, kind, user_id, wallet_id, recipient, chain, origin_asset, source_address, amount_in, deposit_address,
         deposit_deadline, sign_by, quote, oneclick, kits_min_per_near, kits_slippage, status, next_check_at, checks, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting-deposit', ?, 0, ?, ?)`,
      [
        id,
        o.network,
        o.kind,
        o.userId,
        o.walletId,
        o.recipient,
        o.chain,
        o.originAsset,
        o.sourceAddress,
        o.amountIn,
        o.depositAddress,
        o.depositDeadline,
        o.signBy,
        JSON.stringify(o.quote),
        JSON.stringify(o.oneclick),
        o.kitsMinPerNear,
        o.kitsSlippage,
        o.nextCheckAt,
        t,
        t,
      ],
    )
    return (await this.get(id)) as BridgeOrder
  }

  async get(id: string): Promise<BridgeOrder | null> {
    const r = await this.db.get<Row>('SELECT * FROM bridge_orders WHERE id = ?', [id])
    return r ? fromRow(r) : null
  }

  /** A user's orders to their NEARKITS wallets, newest first. */
  async ofUser(userId: number, network: string, limit = 20): Promise<BridgeOrder[]> {
    const rows = await this.db.all<Row>('SELECT * FROM bridge_orders WHERE user_id = ? AND network = ? ORDER BY created_at DESC LIMIT ?', [userId, network, limit])
    return rows.map(fromRow)
  }

  /**
   * Moves an order. `from`: only when it is still in one of these statuses (a compare-and-set, so
   * two workers or a worker and a request never both move it). True when it moved.
   */
  async update(id: string, patch: BridgeOrderPatch, from?: readonly BridgeOrderStatus[]): Promise<boolean> {
    const keys = Object.keys(patch) as (keyof BridgeOrderPatch)[]
    if (!keys.length) return false
    const sets = keys.map((k) => `${COLUMNS[k]} = ?`)
    const values = keys.map((k) => {
      const v = patch[k]
      return JSON_FIELDS.has(k) ? (v === null || v === undefined ? null : JSON.stringify(v)) : (v ?? null)
    })
    const where = from?.length ? ` AND status IN (${from.map(() => '?').join(', ')})` : ''
    return (
      (await this.db.run(`UPDATE bridge_orders SET ${sets.join(', ')}, updated_at = ? WHERE id = ?${where}`, [
        ...(values as (string | number | null)[]),
        this.now(),
        id,
        ...(from ?? []),
      ])) === 1
    )
  }

  /** Orders due for a check (next_check_at passed) that no worker holds. */
  async due(limit = 20): Promise<BridgeOrder[]> {
    const t = this.now()
    const rows = await this.db.all<Row>(
      'SELECT * FROM bridge_orders WHERE next_check_at IS NOT NULL AND next_check_at <= ? AND (lease_until IS NULL OR lease_until < ?) ORDER BY next_check_at LIMIT ?',
      [t, t, limit],
    )
    return rows.map(fromRow)
  }

  /** Takes an order for `ms` (compare-and-set): exactly one worker steps it at a time. */
  async claim(id: string, owner: string, ms: number): Promise<boolean> {
    const t = this.now()
    return (
      (await this.db.run('UPDATE bridge_orders SET lease_owner = ?, lease_until = ? WHERE id = ? AND (lease_until IS NULL OR lease_until < ? OR lease_owner = ?)', [
        owner,
        t + ms,
        id,
        t,
        owner,
      ])) === 1
    )
  }

  async release(id: string, owner: string): Promise<void> {
    await this.db.run('UPDATE bridge_orders SET lease_owner = NULL, lease_until = NULL WHERE id = ? AND lease_owner = ?', [id, owner])
  }
}
