import { describe, expect, it } from 'vitest'
import { createLimiter, mapLimit } from './async'

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('mapLimit', () => {
  it('keeps the input order and never runs more than `limit` at once', async () => {
    let open = 0
    let most = 0
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      most = Math.max(most, ++open)
      await tick()
      open--
      return n * 10
    })
    expect(out).toEqual([10, 20, 30, 40, 50])
    expect(most).toBe(2)
  })
})

describe('createLimiter', () => {
  it('lets `limit` holders in at once and the rest in the order they asked; releasing twice frees one place', async () => {
    const limiter = createLimiter(2)
    const got: number[] = []
    const releases: (() => void)[] = []
    const ask = (n: number) =>
      limiter.acquire().then((release) => {
        got.push(n)
        releases.push(release)
      })
    void ask(1)
    void ask(2)
    void ask(3)
    void ask(4)
    await tick()
    expect(got).toEqual([1, 2])
    releases[0]?.()
    releases[0]?.()
    await tick()
    expect(got).toEqual([1, 2, 3])
    releases[1]?.()
    await tick()
    expect(got).toEqual([1, 2, 3, 4])
  })
})
