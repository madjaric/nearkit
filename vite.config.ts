import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv, normalizePath, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { parsePublicUrl, robotsTxt, sitemapXml, websiteJsonLd } from './src/config/site'

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

/**
 * robots.txt, sitemap.xml and the site's JSON-LD (schema.org WebSite) for the public address the
 * build names (VITE_PUBLIC_URL, else NearKit's own: src/config/site.ts). A malformed address fails the build.
 */
function publicSiteFiles(mode: string): Plugin {
  const raw = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_').VITE_PUBLIC_URL
  const url = parsePublicUrl(raw)
  return {
    name: 'nearkit-public-site-files',
    apply: 'build',
    transformIndexHtml: () => (url ? [{ tag: 'script', attrs: { type: 'application/ld+json' }, children: websiteJsonLd(url), injectTo: 'head' as const }] : []),
    generateBundle() {
      if (!url) return this.error(`VITE_PUBLIC_URL must be an https:// origin without a path, not "${raw ?? ''}"`)
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: robotsTxt(url) })
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: sitemapXml(url) })
    },
  }
}

/** The app's version, printed in the sidebar. */
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), preloadFonts(), publicSiteFiles(mode)],
  define: { __NEARKIT_E2E__: JSON.stringify(mode === 'e2e'), __NEARKIT_VERSION__: JSON.stringify(version), __NEARKIT_DEMO__: JSON.stringify(isDemoBuild(mode)) },
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
