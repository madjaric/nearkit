import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Buckets } from '../bot/ratelimit'
import type { ServerConfig } from '../config'
import type { Logger } from '../log'

/**
 * The small HTTP API the NearKit web app calls (account linking, trade results).
 * No cookies, no sessions: every request carries its own proof (a one-time code
 * plus a wallet signature, or a handoff ID checked against the chain). Bodies are
 * JSON, small, and never logged; responses are never cached.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export type Route = (body: unknown, req: IncomingMessage) => Promise<unknown>

export interface ApiOptions {
  config: Pick<ServerConfig, 'api' | 'network'>
  log: Logger
  routes: Record<string, Route>
  /** Extra per-route limits: requests per minute per IP. */
  limits?: Record<string, number>
  health?: () => Record<string, unknown>
  now?: () => number
}

const MAX_BODY_BYTES = 16 * 1024
const BASE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    const onData = (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        // Stop buffering, let the rest drain unread, and answer 413 (then close).
        req.off('data', onData)
        req.resume()
        reject(new HttpError(413, 'too-large', 'Request body too large'))
        return
      }
      chunks.push(chunk)
    }
    req.on('data', onData)
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function createApiServer(options: ApiOptions): Server {
  const { config, log, routes } = options
  const now = options.now ?? Date.now
  const allowed = new Set(config.api.allowedOrigins)
  const general = new Buckets(60, 1, now)
  const perRoute = new Map(Object.entries(options.limits ?? {}).map(([route, perMinute]) => [route, new Buckets(perMinute, perMinute / 60, now)]))

  const send = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...BASE_HEADERS, ...extra })
    res.end(body === null ? '' : JSON.stringify(body))
  }

  return createServer(async (req, res) => {
    const started = now()
    const origin = req.headers.origin
    const cors: Record<string, string> =
      origin && allowed.has(origin)
        ? {
            'access-control-allow-origin': origin,
            vary: 'Origin',
            'access-control-allow-methods': 'GET, POST, OPTIONS',
            'access-control-allow-headers': 'content-type',
            'access-control-max-age': '600',
          }
        : {}
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    let status = 500
    try {
      if (origin && !allowed.has(origin)) throw new HttpError(403, 'origin', 'This origin may not call the NearKit API')
      if (req.method === 'OPTIONS') {
        status = 204
        return send(res, 204, null, cors)
      }
      // Behind our own reverse proxy, the client is the address it recorded last; anything a
      // client wrote into the header before it counts for nothing. Otherwise the header is ignored.
      const forwarded = config.api.trustProxy
        ? String(req.headers['x-forwarded-for'] ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .at(-1)
        : undefined
      const ip = forwarded ?? req.socket.remoteAddress ?? 'unknown'
      if (!general.take(ip) || !(perRoute.get(path)?.take(ip) ?? true)) throw new HttpError(429, 'rate-limited', 'Too many requests. Wait a minute and try again.')
      if (req.method === 'GET' && path === '/health') {
        status = 200
        return send(res, 200, { ok: true, network: config.network.id, ...(options.health?.() ?? {}) }, cors)
      }
      const route = routes[path]
      if (!route) throw new HttpError(404, 'not-found', 'Not found')
      if (req.method !== 'POST') throw new HttpError(405, 'method', 'Use POST')
      if (!(req.headers['content-type'] ?? '').includes('application/json')) throw new HttpError(415, 'content-type', 'Send JSON')
      let body: unknown
      try {
        body = JSON.parse(await readBody(req))
      } catch (e) {
        if (e instanceof HttpError) throw e
        throw new HttpError(400, 'bad-json', 'The request body is not valid JSON')
      }
      const result = await route(body, req)
      status = 200
      send(res, 200, result, cors)
    } catch (e) {
      // Domain errors that carry an HTTP status (e.g. LinkApiError) keep their status and message.
      const typed = e as { status?: unknown; code?: unknown }
      const err =
        e instanceof HttpError
          ? e
          : e instanceof Error && typeof typed.status === 'number' && typeof typed.code === 'string'
            ? new HttpError(typed.status, typed.code, e.message)
            : null
      if (!err) log.error('api route failed', { path, error: e })
      status = err?.status ?? 500
      if (!res.headersSent)
        send(
          res,
          status,
          { error: { code: err?.code ?? 'internal', message: err?.message ?? 'Something went wrong on NearKit’s side. Try again.' } },
          {
            ...cors,
            ...(status === 413 ? { connection: 'close' } : {}),
          },
        )
    } finally {
      // Path and status only: bodies carry one-time codes and signatures.
      log.info('api', { method: req.method, path, status, ms: now() - started })
    }
  })
}

export async function listen(server: Server, port: number, host: string): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  return typeof address === 'object' && address ? address.port : port
}
