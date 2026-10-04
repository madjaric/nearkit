import { describe, expect, it } from 'vitest'
import type { CustodyDeps } from '../custody/wallets'
import type { Intent } from '../custody/store'
import { createLogger } from '../log'
import { startRun, WEB_BROADCAST_CONCURRENCY, webRunsSettled } from './execute'

/**
 * A web run (Multi Buy / Multi Sell from NearKit wallets): every wallet's trade goes through the
 * engine on its own. A wallet holds a place only while it prepares (route, checks, signature);
 * it frees it as its transaction leaves for the network, so no wallet waits for another to confirm.
 */

const legs = (n: number) => Array.from({ length: n }, (_, k) => ({ id: `leg-${k}` }) as Intent)
const tick = () => new Promise((r) => setTimeout(r, 0))
const quiet = () => createLogger({ level: 'error', sink: () => undefined })

describe('a web run', () => {
  it('ten wallets: at most a few prepare at once, each frees its place as its transaction leaves, so all ten are sent before any confirms', async () => {
    const sent: string[] = []
    let preparing = 0
    let most = 0
    let confirm: () => void = () => undefined
    const confirmed = new Promise<void>((r) => (confirm = r))
    const engine = {
      async execute(id: string, _userId: number, hooks?: { onSend?: () => void }) {
        most = Math.max(most, ++preparing)
        await tick() // its route, checks and signature
        preparing--
        sent.push(id)
        hooks?.onSend?.()
        await confirmed // the network confirms it later
        return { kind: 'finished' }
      },
    }
    startRun({ engine } as unknown as Pick<CustodyDeps, 'engine'>, legs(10), 101, quiet())
    for (let k = 0; k < 50 && sent.length < 10; k++) await tick()
    // Every wallet sent, in the wallets' order, while none has confirmed yet.
    expect(sent).toEqual(legs(10).map((l) => l.id))
    expect(most).toBe(WEB_BROADCAST_CONCURRENCY)
    confirm()
    await webRunsSettled()
  })

  it('a wallet that stops before sending (refused, requoted, failed) frees its place too, and one that throws stops no other', async () => {
    const ran: string[] = []
    const errors: string[] = []
    const engine = {
      async execute(id: string) {
        ran.push(id)
        if (id === 'leg-1') throw new Error('boom')
        return { kind: 'refused' }
      },
    }
    startRun({ engine } as unknown as Pick<CustodyDeps, 'engine'>, legs(8), 101, createLogger({ level: 'error', sink: (l) => errors.push(l) }))
    await webRunsSettled()
    expect(ran).toHaveLength(8)
    expect(errors.join('\n')).toContain('leg-1')
  })
})
