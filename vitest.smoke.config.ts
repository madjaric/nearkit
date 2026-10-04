import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Live smoke tests: read-only calls to the real NEAR RPC, indexers and Rhea.
 * Never part of `npm test`; run with `npm run smoke:live`. Nothing is signed.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  define: { __NEARKIT_E2E__: 'false', __NEARKIT_VERSION__: '"test"', __NEARKIT_DEMO__: 'false' },
  test: {
    environment: 'node',
    include: ['src/**/*.smoke.ts'],
    testTimeout: 60_000,
    // One at a time: public endpoints rate-limit bursts.
    fileParallelism: false,
  },
})
