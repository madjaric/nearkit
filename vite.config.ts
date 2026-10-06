import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { createServer, defineConfig, loadEnv, normalizePath, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { parsePublicUrl } from './src/config/site'

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

/**
 * Preloads the Latin subsets of the two fonts every screen uses (Archivo for text, JetBrains Mono
 * for every figure). Without it the mono font is only asked for once the first figure renders,
 * ~2.7 s into a cold load on production, so figures first show in a fallback font, then jump.
 */
function preloadFonts(): Plugin {
  const FONT = /^assets\/(archivo-latin-wdth-normal|jetbrains-mono-latin-wght-normal)-[\w-]+\.woff2$/
  return {
    name: 'nearkit-preload-fonts',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (_html, ctx) =>
        Object.keys(ctx.bundle ?? {})
          .filter((file) => FONT.test(file))
          .map((file) => ({ tag: 'link', attrs: { rel: 'preload', href: `/${file}`, as: 'font', type: 'font/woff2', crossorigin: '' }, injectTo: 'head' as const })),
    },
  }
}

/** Whether `mode` builds the demo (VITE_NEARKIT_SERVICES=demo, from .env.<mode> or the host's environment). */
const isDemoBuild = (mode: string) => (loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_').VITE_NEARKIT_SERVICES ?? '').trim() === 'demo'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
// Forward slashes on Windows, so '@/x' and './x' resolve to one module id and the dev server invalidates both on change.
const alias = { '@': normalizePath(fileURLToPath(new URL('./src', import.meta.url))) }

/** The app's version, printed in the sidebar. */
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

const defines = (mode: string) => ({
  __NEARKIT_E2E__: JSON.stringify(mode === 'e2e'),
  __NEARKIT_VERSION__: JSON.stringify(version),
  __NEARKIT_DEMO__: JSON.stringify(isDemoBuild(mode)),
})

/**
 * Each public page as static HTML with its own head (src/prerender.tsx: title, description,
 * canonical, link preview, structured data; the Volume Bot page with its whole body), the app's
 * shell for every other route (app.html), 404.html, robots.txt, sitemap.xml and llms.txt, for
 * the public address the build names (VITE_PUBLIC_URL, else NEARKITS' own). They are rendered
 * from the app's own modules after the bundle is written. A malformed address fails the build.
 */
function prerenderSite(mode: string): Plugin {
  const raw = loadEnv(mode, ROOT, 'VITE_').VITE_PUBLIC_URL
  const url = parsePublicUrl(raw)
  let outDir = join(ROOT, 'dist')
  return {
    name: 'nearkit-prerender',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    buildStart() {
      if (!url) this.error(`VITE_PUBLIC_URL must be an https:// origin without a path, not "${raw ?? ''}"`)
    },
    async closeBundle() {
      if (!url) return
      const server = await createServer({
        configFile: false,
        root: ROOT,
        mode,
        logLevel: 'error',
        appType: 'custom',
        server: { middlewareMode: true, hmr: false, watch: null },
        // Only modules for server rendering are loaded: no browser dependency scan (it would outlive this server).
        optimizeDeps: { noDiscovery: true, include: [] },
        plugins: [react()],
        resolve: { alias },
        define: defines(mode),
      })
      try {
        const { siteFiles } = (await server.ssrLoadModule('/src/prerender.tsx')) as typeof import('./src/prerender')
        const template = await readFile(join(outDir, 'index.html'), 'utf8')
        for (const [name, content] of Object.entries(siteFiles(template, url))) await writeFile(join(outDir, name), content)
      } finally {
        await server.close()
      }
    },
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), preloadFonts(), prerenderSite(mode)],
  define: defines(mode),
  resolve: { alias },
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
