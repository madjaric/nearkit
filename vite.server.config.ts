import { fileURLToPath, URL } from 'node:url'
import { defineConfig, normalizePath } from 'vite'

/**
 * Builds NearKit's server processes for Node: the app (Telegram bot + API,
 * server/src/main.ts), the signer service (server/src/signer/main.ts) and the signer
 * operator's command line (server/src/signer/admin.ts). They share the web app's
 * source through the same `@` alias, so all run one implementation of token lookup,
 * Rhea quotes and route checks. Dependencies stay external and load from
 * node_modules at run time.
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
    ssr: true,
    outDir: 'dist-server',
    emptyOutDir: true,
    target: 'node20',
    sourcemap: true,
    minify: false,
    rollupOptions: {
      input: { main: 'server/src/main.ts', signer: 'server/src/signer/main.ts', 'signer-admin': 'server/src/signer/admin.ts' },
      output: { entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js', format: 'es' },
    },
  },
})
