import { createLimiter } from '@/lib/async'
import type { Intent } from '../custody/store'
import type { CustodyDeps } from '../custody/wallets'
import type { Logger } from '../log'

/**
 * Trades and sends started on NearKit web run on the server, after the request that asked for
 * them has returned; the web follows each one through a status route. Every intent goes
 * through the engine on its own, exactly as a Confirm in Telegram would: its owner, expiry,
 * wallet (active, not busy), the kill switches and freezes, a fresh route with funds, gas and
 * registration checks, the signer's policy, and that wallet's own key. One wallet's run can
 * never move another wallet's funds.
 */

/**
 * Wallets preparing at once in one web run (route, checks, signature). A wallet holds its place
 * only until its transaction goes out, then follows it on its own, so none waits for another to
 * confirm: ten wallets are all sent within seconds.
 */
export const WEB_BROADCAST_CONCURRENCY = 5

/**
 * Wallets quoted at once for a web review. Measured on mainnet (2026-10-04, ten wallets, read
 * only): 3.4–5.5 s at 3, 1.9–2.0 s at 5, 1.7 s at 10 with every quote 50% slower (more load on
 * the public RPCs for 0.3 s).
 */
export const WEB_QUOTE_CONCURRENCY = 5

/** The chat id of an intent started on the web: it has no Telegram chat, and Telegram isn't told. */
export const WEB_CHAT = 0

const running = new Set<Promise<void>>()

/** Resolves once every web run started so far has finished (tests). */
export async function webRunsSettled(): Promise<void> {
  while (running.size) await Promise.all([...running])
}

/** Starts executing these intents for `userId`, in their order; returns at once. */
export function startRun(custody: Pick<CustodyDeps, 'engine'>, intents: readonly Intent[], userId: number, log: Logger): void {
  const places = createLimiter(WEB_BROADCAST_CONCURRENCY)
  const task = Promise.all(
    intents.map(async (intent) => {
      const release = await places.acquire()
      try {
        await custody.engine.execute(intent.id, userId, { onSend: release })
      } catch (e) {
        // One wallet's failure is its own: the others run on.
        log.error('web run failed', { intent: intent.id, error: e })
      } finally {
        release()
      }
    }),
  ).then(() => undefined)
  running.add(task)
  void task.finally(() => running.delete(task))
}
