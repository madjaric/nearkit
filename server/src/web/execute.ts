import { mapLimit } from '@/lib/async'
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

/** Wallets trading at once in one web run: each is its own account, so they don't wait on each other. */
export const WEB_CONCURRENCY = 3

/** The chat id of an intent started on the web: it has no Telegram chat, and Telegram isn't told. */
export const WEB_CHAT = 0

const running = new Set<Promise<void>>()

/** Resolves once every web run started so far has finished (tests). */
export async function webRunsSettled(): Promise<void> {
  while (running.size) await Promise.all([...running])
}

/** Starts executing these intents for `userId`; returns at once. */
export function startRun(custody: Pick<CustodyDeps, 'engine'>, intents: readonly Intent[], userId: number, log: Logger): void {
  const task = mapLimit(intents, WEB_CONCURRENCY, (i) => custody.engine.execute(i.id, userId)).then(
    () => undefined,
    (e: unknown) => log.error('web run failed', { intents: intents.map((i) => i.id), error: e }),
  )
  running.add(task)
  void task.finally(() => running.delete(task))
}
