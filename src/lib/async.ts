/** Map with at most `limit` promises in flight; results keep input order. Keeps free RPC tiers happy. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await fn(items[index] as T, index)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return results
}

/**
 * At most `limit` holders at once; the others get in in the order they asked. `acquire` resolves
 * with the release for that place, which is safe to call more than once.
 */
export function createLimiter(limit: number) {
  let active = 0
  const waiting: (() => void)[] = []
  return {
    async acquire(): Promise<() => void> {
      if (active < limit) active++
      else await new Promise<void>((resolve) => waiting.push(resolve))
      let released = false
      return () => {
        if (released) return
        released = true
        // The place passes straight to the next in line.
        const next = waiting.shift()
        if (next) next()
        else active--
      }
    },
  }
}
