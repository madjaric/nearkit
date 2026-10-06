import type { LedTone } from '@/components/ui/Indicators'
import type { BotMetricPoint, BotSummary } from '@/lib/volumeBot/api'
import type { BotStatus, BotStrategy } from '@/lib/volumeBot/types'

/** The console's words for a bot: its strategy, its status and the keys it offers. */

export const STRATEGY: Record<BotStrategy, { label: string; blurb: string }> = {
  'market-maker': {
    label: 'Market maker',
    blurb: 'Buys below fair value and sells above it, only when the executable price beats fair value by your edge after every fee, leaning toward your target inventory.',
  },
  accumulate: {
    label: 'Accumulate (TWAP)',
    blurb: 'Buys a NEAR budget in slices over a period, never above your price cap.',
  },
  distribute: {
    label: 'Distribute (TWAP)',
    blurb: 'Sells a token amount in slices over a period, never below your price floor.',
  },
}

export type BotControl = 'start' | 'pause' | 'resume' | 'stop' | 'emergency' | 'edit' | 'delete'

/** The keys a bot offers in its status: exactly the actions the server accepts then. */
export function controlsFor(status: BotStatus): BotControl[] {
  switch (status) {
    case 'running':
      return ['pause', 'stop', 'emergency']
    case 'paused':
      return ['resume', 'stop', 'emergency']
    case 'stopping':
      return []
    default:
      return ['start', 'edit', 'delete']
  }
}

/** Lime only while it runs; amber when the guardian or NEARKITS paused it (it needs a look). */
export function statusLamp(b: Pick<BotSummary, 'status' | 'pauseCode'>): { tone: LedTone; label: string } {
  switch (b.status) {
    case 'running':
      return { tone: 'on', label: 'Running' }
    case 'paused':
      if (b.pauseCode === 'operator') return { tone: 'warn', label: 'Paused by NEARKITS' }
      if (b.pauseCode && b.pauseCode !== 'owner') return { tone: 'warn', label: 'Paused by the guardian' }
      return { tone: 'idle', label: 'Paused' }
    case 'stopping':
      return { tone: 'idle', label: 'Stopping' }
    case 'stopped':
      return { tone: 'off', label: 'Stopped' }
    case 'completed':
      return { tone: 'off', label: 'Completed' }
    default:
      return { tone: 'off', label: 'Not started' }
  }
}

/** The points of the run that started at `startedAt`: an earlier run's figures never join its line. */
export function runPoints(series: readonly BotMetricPoint[], startedAt: number | null): BotMetricPoint[] {
  return startedAt === null ? [] : series.filter((p) => p.at >= startedAt)
}

/** The first problem with each field, for its message line. */
export function issuesByField(issues: readonly { field: string; message: string }[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const i of issues) out[i.field] ??= i.message
  return out
}
