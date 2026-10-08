import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { KitsBurn } from '@/services/kitsBurns'
import { BurnChart } from './BurnChart'
import { burnSeries } from './burnSeries'

/** The burn chart keeps every verified burn inside its plot, whatever the total. */

const burn = (tx: string, at: number, kits: number): KitsBurn => ({ tx: tx.padEnd(44, '1'), at, amount: `${kits}000000000000000000`, kind: 'tax' })

describe('the burn chart', () => {
  it('scales to the whole total: the last marker sits on the plot, not above it, when the total is past the top round tick', () => {
    // 3,488,822 KITS: round ticks run 0, 1M, 2M, 3M, so the plot must reach past 3M.
    const series = burnSeries([burn('A', 1_000, 1_137_239), burn('B', 2_000, 2_000_000), burn('C', 3_000, 351_583)], 18, 9_000)
    if (!series) throw new Error('no series')
    const html = renderToStaticMarkup(createElement(BurnChart, { series }))
    const tops = [...html.matchAll(/aria-label="Burn of [^"]*"[^>]*style="left:[^;]*;top:(-?[\d.]+)%/g)].map((m) => Number(m[1]))
    expect(tops).toHaveLength(3)
    for (const top of tops) {
      expect(top).toBeGreaterThanOrEqual(0)
      expect(top).toBeLessThanOrEqual(100)
    }
    // The trace never leaves the plot either: no point above its top edge.
    const trace = html.match(/<path d="(M[^"]+)" fill="none"/)?.[1] ?? ''
    for (const v of trace.matchAll(/V(-?[\d.]+)/g)) expect(Number(v[1])).toBeGreaterThanOrEqual(0)
  })
})
