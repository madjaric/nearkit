import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { Logger } from '../log'
import { AUTH_WINDOW_MS, checkRequest, signResponse } from './auth'
import type { SignerCore } from './core'
import { errorToWire } from './errors'
import type { SignerStore } from './store'

/**
 * The signer service's HTTP face: `POST /v1/<method>` only, every request signed by the
 * app (auth.ts) and used once, every answer signed back. No body is ever logged: only
 * the method, the status and the time taken. `GET /livez` says the process is alive and
 * nothing else (for the host's liveness probe); the signer's real health is a signed
 * `health` request, because it reveals the pause state.
 */

const MAX_BODY_BYTES = 256 * 1024

class TooLarge extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new TooLarge())
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export interface SignerServerOptions {
  core: SignerCore
  /** Where request nonces are remembered (the signer's own database). */
  store: SignerStore
  authKey: Buffer
  log: Logger
  now?: () => number
  /** Serve over TLS with this certificate (paths already read). */
  tls?: { cert: Buffer; key: Buffer } | null
}

export function createSignerServer(o: SignerServerOptions): Server {
  const now = o.now ?? Date.now
  const plain = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    res.end(JSON.stringify(body))
  }
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const started = now()
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    let status = 500
    let method = '-'
    try {
      if (req.method === 'GET' && path === '/livez') {
        status = 200
        return plain(res, 200, { ok: true })
      }
      if (req.method !== 'POST' || !/^\/v1\/[a-z-]{2,40}$/.test(path)) {
        status = 404
        return plain(res, 404, { error: { code: 'not-found', message: 'Not found' } })
      }
      method = path.slice(4)
      let text: string
      try {
        text = await readBody(req)
      } catch (e) {
        status = e instanceof TooLarge ? 413 : 400
        return plain(res, status, { error: { code: 'bad-request', message: 'The request body could not be read' } })
      }
      const check = checkRequest(o.authKey, path, text, req.headers, now())
      if (!check.ok) {
        status = 401
        o.log.warn('signer request refused', { method, reason: check.reason })
        return plain(res, 401, { error: { code: 'unauthorized', message: 'This request is not signed by NearKit' } })
      }
      // Once only, across every instance of the signer: a replayed request is refused.
      if (!(await o.store.firstUse(check.nonce, check.time + 2 * AUTH_WINDOW_MS))) {
        status = 401
        o.log.warn('signer request refused', { method, reason: 'replayed nonce' })
        return plain(res, 401, { error: { code: 'unauthorized', message: 'This request was already used' } })
      }
      let body: unknown
      let result: unknown
      try {
        body = JSON.parse(text) as unknown
        result = await o.core.handle(method, body)
        status = 200
      } catch (e) {
        const w = e instanceof SyntaxError ? { status: 400, code: 'bad-request', message: 'The request body is not JSON' } : errorToWire(e)
        if (w.status === 500) o.log.error('signer method failed', { method, error: e })
        status = w.status
        result = { error: { code: w.code, message: w.message, ...('detail' in w && w.detail ? { detail: w.detail } : {}) } }
      }
      const out = JSON.stringify(result)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-nearkit-signature': signResponse(o.authKey, check.nonce, status, out),
      })
      res.end(out)
    } catch (e) {
      o.log.error('signer request failed', { method, error: e })
      if (!res.headersSent) plain(res, 500, { error: { code: 'internal', message: 'The signer failed. Nothing was signed.' } })
    } finally {
      o.log.info('signer', { method, status, ms: now() - started })
    }
  }
  const serve = (req: IncomingMessage, res: ServerResponse) => void handler(req, res)
  const server = o.tls ? createHttpsServer({ cert: o.tls.cert, key: o.tls.key, minVersion: 'TLSv1.2' }, serve) : createHttpServer(serve)
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  return server
}
