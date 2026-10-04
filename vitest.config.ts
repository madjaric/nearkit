import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  define: { __NEARKIT_E2E__: 'false', __NEARKIT_VERSION__: '"test"', __NEARKIT_DEMO__: 'false' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'server/src/**/*.test.ts'],
    // Server suites also run on PGlite (Postgres in WebAssembly): its first database can take a while to start.
    hookTimeout: 120_000,
  },
})
