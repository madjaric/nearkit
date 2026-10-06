// The built site served the way vercel.json says (rewrites, headers, trailing slashes, 404.html
// with a 404 status), for checking a production build locally before it ships:
//   npm run build && node scripts/serve-dist.mjs [--port 5205] [--dir dist]
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { brotliCompressSync, gzipSync } from 'node:zlib'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const PORT = Number(opt('port', '5205'))
const DIR = join(process.cwd(), opt('dir', 'dist'))
const vercel = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8'))

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
}

/** Vercel's source patterns as used in vercel.json: literal segments, `:param`, `(a|b)` and `((?!x).*)` groups. */
const toRegExp = (source) => new RegExp(`^${source.replace(/\./g, '\\.').replace(/:[a-z]+/gi, '[^/]+')}$`)
const rewrites = vercel.rewrites.map((r) => ({ test: toRegExp(r.source), destination: r.destination }))
const headers = vercel.headers.map((h) => ({ test: toRegExp(h.source), headers: h.headers }))

const fileFor = (path) => {
  const file = normalize(join(DIR, decodeURIComponent(path)))
  if (!file.startsWith(DIR)) return null
  return existsSync(file) && statSync(file).isFile() ? file : null
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  let path = url.pathname
  if (vercel.trailingSlash === false && path.length > 1 && path.endsWith('/')) {
    res.writeHead(308, { location: path.replace(/\/+$/, '') + url.search })
    return res.end()
  }
  const extra = Object.assign({}, ...headers.filter((h) => h.test.test(path)).map((h) => Object.fromEntries(h.headers.map((x) => [x.key, x.value]))))
  let file = path === '/' ? fileFor('/index.html') : fileFor(path)
  if (!file) {
    const rule = rewrites.find((r) => r.test.test(path))
    if (rule) file = fileFor(rule.destination)
  }
  const status = file ? 200 : 404
  file ??= fileFor('/404.html')
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    return res.end('Not found')
  }
  // Compressed as the host compresses text (brotli, else gzip), so a local measurement sees the same bytes.
  let body = readFileSync(file)
  const type = TYPES[extname(file)] ?? 'application/octet-stream'
  const accept = String(req.headers['accept-encoding'] ?? '')
  const encoding = /^(text|application)\/|svg/.test(type) ? (accept.includes('br') ? 'br' : accept.includes('gzip') ? 'gzip' : null) : null
  if (encoding === 'br') body = brotliCompressSync(body)
  if (encoding === 'gzip') body = gzipSync(body)
  res.writeHead(status, { 'content-type': type, ...(encoding ? { 'content-encoding': encoding, vary: 'accept-encoding' } : {}), ...extra })
  res.end(body)
}).listen(PORT, () => console.log(`dist on http://localhost:${PORT} (vercel.json rules)`))
