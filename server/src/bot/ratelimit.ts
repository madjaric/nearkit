/**
 * Token buckets, in memory. They guard the bot against floods (a user hammering
 * buttons, or a script) and protect the free public services behind it (RPC,
 * Rhea's quote server). Resetting on restart is fine: limits are short-lived.
 */
export class Buckets {
  private readonly state = new Map<string, { tokens: number; at: number }>()

  constructor(
    private readonly capacity: number,
    /** Tokens regained per second. */
    private readonly refillPerSec: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string, cost = 1): boolean {
    const t = this.now()
    const s = this.state.get(key) ?? { tokens: this.capacity, at: t }
    const tokens = Math.min(this.capacity, s.tokens + ((t - s.at) / 1000) * this.refillPerSec)
    if (tokens < cost) {
      this.state.set(key, { tokens, at: t })
      return false
    }
    this.state.set(key, { tokens: tokens - cost, at: t })
    if (this.state.size > 50_000) this.sweep(t)
    return true
  }

  private sweep(t: number) {
    for (const [k, s] of this.state) if ((t - s.at) / 1000 > this.capacity / this.refillPerSec) this.state.delete(k)
  }
}
