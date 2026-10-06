// Test-only preload for the NearKit server in end-to-end runs:
//   node --import ./scripts/lib/clock-shift.mjs dist-server/main.js
// Moves the server's clock forward by the milliseconds written to NEARKIT_E2E_CLOCK_FILE
// (a key export's 24-hour hold, say), so a test can see what happens a day later without
// waiting for it. Without the variable it does nothing.
import { readFileSync } from 'node:fs'

const file = process.env.NEARKIT_E2E_CLOCK_FILE
if (file) {
  const real = Date.now.bind(Date)
  let offset = 0
  let readAt = -Infinity
  Date.now = () => {
    const t = real()
    // Read at most every 100 ms: Date.now is called often.
    if (t - readAt > 100) {
      readAt = t
      try {
        offset = Number(readFileSync(file, 'utf8')) || 0
      } catch {
        offset = 0
      }
    }
    return t + offset
  }
}
