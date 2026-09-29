import { fileURLToPath, URL } from 'node:url'
import { defineConfig, normalizePath } from 'vite'

/**
 * Builds the Telegram bot server (server/src/main.ts) for Node. It shares the
 * web app's source through the same `@` alias, so both run one implementation
 * of token lookup, Rhea quotes and route checks. Dependencies stay external and
 * load from node_modules at run time.
 */
export default defineConfig({
  define: { __NEARKIT_E2E__: 'false' },
  resolve: {
    alias: { '@': normalizePath(fileURLToPath(new URL('./src', import.meta.url))) },
  },
  // Build-time VITE_ variables must not reach the server: it reads its own at run time.
  envPrefix: 'NEARKIT_BUILD_ONLY_',
  // The web app's public/ files have no business in the server bundle.
  publicDir: false,
  build: {
    ssr: 'server/src/main.ts',
    outDir: 'dist-server',
    emptyOutDir: true,
    target: 'node20',
    sourcemap: true,
    minify: false,
    rollupOptions: { output: { entryFileNames: 'main.js', format: 'es' } },
  },
})
