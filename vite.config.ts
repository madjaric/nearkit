import { fileURLToPath, URL } from 'node:url'
import { defineConfig, normalizePath } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Headers the production host must send (README, "Deploying"); `npm run preview`
 * sends them too, so the built app is checked under them.
 */
const SECURITY_HEADERS = {
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  // Wallet popups keep their link back to NearKit (plain same-origin would cut it);
  // a page that opens NearKit in a new window loses its handle on it.
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  define: { __NEARKIT_E2E__: JSON.stringify(mode === 'e2e') },
  resolve: {
    // Forward slashes on Windows, so '@/x' and './x' resolve to one module id and
    // the dev server invalidates both on change.
    alias: { '@': normalizePath(fileURLToPath(new URL('./src', import.meta.url))) },
  },
  server: { port: 5196, strictPort: true },
  preview: { port: 5197, strictPort: true, headers: SECURITY_HEADERS },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-dom/client', 'react-router'],
          query: ['@tanstack/react-query'],
        },
      },
    },
  },
}))
