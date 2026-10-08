import { randomToken } from '../ids'
import type { Logger } from '../log'
import { ORDER_LEASE_MS, type BridgeService } from './service'
import type { BridgeStore } from './store'

/**
 * Follows Bridge & Buy orders: each due order (its next_check_at passed) is stepped under its own
 * lease, so two server instances never step one order at once. The cadence is the order's own
 * (service.ts nextCheck): a few seconds while NEAR Intents is moving it, longer while it waits for a
 * deposit, backing off up to two minutes when NEAR Intents or the chain doesn't answer.
 */

export const BRIDGE_TICK_MS = 2_000

export function createBridgeWorker(deps: { bridge: BridgeService; store: BridgeStore; instanceId: string; log: Logger; tickMs?: number }) {
  const owner = `${deps.instanceId}/bridge/${randomToken(6)}`
  let timer: ReturnType<typeof setInterval> | null = null
  let running: Promise<void> | null = null

  async function tick(): Promise<void> {
    for (const order of await deps.store.due(10)) {
      if (!(await deps.store.claim(order.id, owner, ORDER_LEASE_MS))) continue
      try {
        // Read again under the lease: another instance may have stepped it just before.
        const fresh = await deps.store.get(order.id)
        if (fresh && fresh.nextCheckAt !== null) await deps.bridge.step(fresh)
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
