// Test-only preload for the NearKit server in end-to-end runs:
//   node --import ./scripts/lib/fetch-guard.mjs dist-server/main.js
// Sends every request for an external host to the fake network at
// NEARKIT_E2E_FAKE_HTTP (as /__proxy/<host>/<path>), so the server can never
// reach a live service during a test. Local traffic passes untouched.
const base = process.env.NEARKIT_E2E_FAKE_HTTP
if (!base) throw new Error('fetch-guard: NEARKIT_E2E_FAKE_HTTP is not set')
const original = globalThis.fetch.bind(globalThis)

globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return original(input, init)
  return original(`${base}/__proxy/${url.host}${url.pathname}${url.search}`, init)
}
