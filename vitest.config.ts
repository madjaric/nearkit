import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  define: { __NEARKIT_E2E__: 'false' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
