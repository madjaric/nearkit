import { describe, expect, it } from 'vitest'
import { Leases } from './leases'
import { ENGINE_TIMEOUT_MS, openTestDatabase, TEST_ENGINES } from './testing'

describe.each(TEST_ENGINES)(
  'leases on %s',
  (engine) => {
    it('one holder at a time; it renews; after it stops renewing another takes over', async () => {
      const db = await openTestDatabase(engine)
      let now = 1_000
      const leases = new Leases(db, () => now)
      expect(await leases.acquire('telegram-poller', 'a', 60_000)).toBe(true)
      expect(await leases.acquire('telegram-poller', 'b', 60_000)).toBe(false)
      now += 30_000
      expect(await leases.acquire('telegram-poller', 'a', 60_000)).toBe(true) // renewal
      now += 59_000
      expect(await leases.acquire('telegram-poller', 'b', 60_000)).toBe(false) // still a's
      now += 2_000
      expect(await leases.acquire('telegram-poller', 'b', 60_000)).toBe(true) // a stopped renewing
      expect(await leases.acquire('telegram-poller', 'a', 60_000)).toBe(false)
      expect(await leases.holder('telegram-poller')).toEqual({ owner: 'b', until: now + 60_000 })
      await leases.release('telegram-poller', 'a') // not a's any more: no effect
      expect((await leases.holder('telegram-poller'))?.owner).toBe('b')
      await leases.release('telegram-poller', 'b')
      expect(await leases.acquire('telegram-poller', 'a', 60_000)).toBe(true)
    })

    it('racing instances: exactly one gets a free lease', async () => {
      const db = await openTestDatabase(engine)
      const leases = new Leases(db, () => 1_000)
      const won = await Promise.all(['a', 'b', 'c', 'd'].map((o) => leases.acquire('buybot-runner', o, 60_000)))
      expect(won.filter(Boolean)).toHaveLength(1)
    })

    it('an update is handled once, however often it arrives', async () => {
      const db = await openTestDatabase(engine)
      let now = 1_000
      const leases = new Leases(db, () => now)
      expect(await leases.firstDelivery(900)).toBe(true)
      expect(await leases.firstDelivery(900)).toBe(false)
      expect(await leases.firstDelivery(901)).toBe(true)
      now += 4 * 86_400_000
      await leases.prune()
      expect(await leases.firstDelivery(900)).toBe(true) // forgotten after days (Telegram keeps updates 24 h)
    })
  },
  ENGINE_TIMEOUT_MS,
)
