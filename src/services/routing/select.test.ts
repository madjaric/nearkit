import { describe, expect, it } from 'vitest'
import { netOutOf, selectRoute, type Rankable } from './select'

const route = (source: Rankable['source'], amountOut: bigint, outputFeePpm = 0): Rankable => ({ source, amountOut, outputFeePpm })

describe('route selection', () => {
  it('compares what the user receives: an aggregator fee still to come off the output counts', () => {
    expect(netOutOf(route('rhea-aggregator', 1_000_000n, 6000))).toBe(994_000n)
    expect(netOutOf(route('dcl', 1_000_000n))).toBe(1_000_000n)
  })
  it('keeps Rhea when another route is only marginally better, and takes the other when it is materially better', () => {
    const rhea = route('rhea-aggregator', 1_000_000n)
    expect(selectRoute([rhea, route('dcl', 1_002_000n)])).toBe(rhea)
    expect(selectRoute([route('dcl', 1_002_000n), rhea])).toBe(rhea)
    const dcl = route('dcl', 1_003_000n)
    expect(selectRoute([rhea, dcl])).toBe(dcl)
  })
  it('a route Rhea does not have is the only candidate, so it wins; Rhea wins its own ties', () => {
    const dcl = route('dcl', 5n)
    expect(selectRoute([dcl])).toBe(dcl)
    const rhea = route('rhea-aggregator', 7n)
    expect(selectRoute([rhea, route('dcl', 7n)])).toBe(rhea)
  })
  it('is deterministic for equal non-Rhea routes: the first stays', () => {
    const a = route('dcl', 9n)
    expect(selectRoute([a, route('dcl', 9n)])).toBe(a)
  })
})
