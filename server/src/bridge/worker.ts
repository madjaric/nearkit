import { randomToken } from '../ids'
import type { Logger } from '../log'
import { ORDER_LEASE_MS, type BridgeService } from './service'
import type { BridgeOrder, BridgeStore } from './store'

/**
 * Follows Bridge & Buy orders: each due order (its next_check_at passed) is stepped under its own
 * lease, so two server instances never step one order at once. The cadence is the order's own
 * (service.ts nextCheck): a few seconds while NEAR Intents is moving it, longer while it waits for a
 * deposit, backing off up to two minutes when NEAR Intents or the chain doesn't answer.
 */

export const BRIDGE_TICK_MS = 2_000

export function createBridgeWorker(deps: {
  bridge: BridgeService
  store: BridgeStore
  instanceId: string
  log: Logger
  tickMs?: number
  /**
   * An order's status changed in a step (the bot tells its user). It runs beside the pass, never in it:
   * a slow or failing Telegram never holds up stepping the other orders, and a failure never stops the worker.
   */
  onChange?: (order: BridgeOrder) => Promise<void>
}) {
  const owner = `${deps.instanceId}/bridge/${randomToken(6)}`
  let timer: ReturnType<typeof setInterval> | null = null
  let running: Promise<void> | null = null
  const notices = new Set<Promise<void>>()

  function announce(order: BridgeOrder) {
    if (!deps.onChange) return
    const sent: Promise<void> = deps
      .onChange(order)
      .catch((e: unknown) => deps.log.warn('bridge notice failed', { order: order.id, error: e }))
      .finally(() => notices.delete(sent))
    notices.add(sent)
  }

  async function tick(): Promise<void> {
    for (const order of await deps.store.due(10)) {
      if (!(await deps.store.claim(order.id, owner, ORDER_LEASE_MS))) continue
      try {
        // Read again under the lease: another instance may have stepped it just before.
        const fresh = await deps.store.get(order.id)
        if (fresh && fresh.nextCheckAt !== null) {
          await deps.bridge.step(fresh)
          const after = deps.onChange ? await deps.store.get(order.id) : null
          if (after && after.status !== fresh.status) announce(after)
        }
      } catch (e) {
        deps.log.error('bridge order step failed', { order: order.id, error: e })
        await deps.store.update(order.id, { nextCheckAt: Date.now() + 60_000 }).catch(() => undefined)
      } finally {
        await deps.store.release(order.id, owner).catch(() => undefined)
      }
    }
  }

  return {
    /** One pass over the due orders (tests and the timer). */
    async tick() {
      running ??= tick().finally(() => {
        running = null
      })
      return running
    },
    /** Until every notice started so far has been sent or has failed (tests). */
    async idle() {
      while (notices.size) await Promise.all([...notices])
    },
    start() {
      timer ??= setInterval(() => void this.tick().catch((e) => deps.log.warn('bridge tick failed', { error: e })), deps.tickMs ?? BRIDGE_TICK_MS)
      timer.unref?.()
    },
    async stop() {
      if (timer) clearInterval(timer)
      timer = null
      await running
    },
  }
}
