import { trend } from './format'

const TONE = { up: 'text-pos', down: 'text-neg', flat: 'text-fg-3' }

/** Text color for a signed figure. Color only reinforces the sign; the +/− is always printed. */
export function toneOf(value: number): string {
  return TONE[trend(value)]
}
