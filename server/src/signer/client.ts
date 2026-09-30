import type { SignerTransport } from '../custody/signer'
import { checkResponse, signRequest } from './auth'
import type { SignerMethod } from './core'
import { errorFromWire, SignerUnavailableError } from './errors'

/**
 * The app's connection to the signer service: every request signed (auth.ts), every
 * answer checked to be the signer's own answer to it. Methods that are safe to ask again
 * (a signature of one (intent, step) is the same signature the second time) are retried
 * after a network failure; the rest are not, so nothing happens twice.
 */

const SAFE_TO_RETRY: ReadonlySet<SignerMethod> = new Set(['sign', 'key-info', 'destinations', 'health', 'erase-key', 'revoke-destination', 'pause', 'tg-request-view'])

export function httpSignerTransport(o: { url: string; authKey: Buffer; fetch?: typeof fetch; timeoutMs?: number; now?: () => number }): SignerTransport {
  const fetchImpl = o.fetch ?? globalThis.fetch.bind(globalThis)
  const now = o.now ?? Date.now
  const base = o.url.replace(/\/$/, '')
  return {
    async call(method, body) {
      const path = `/v1/${method}`
      const text = JSON.stringify(body)
      const attempts = SAFE_TO_RETRY.has(method) ? 3 : 1
      let last: Error = new SignerUnavailableError('The signer did not answer')
      for (let i = 0; i < attempts; i++) {
        const headers = signRequest(o.authKey, path, text, now())
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? 20_000)
        let res: Response
        let out: string
        try {
          res = await fetchImpl(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: text, signal: controller.signal })
          out = await res.text()
        } catch (e) {
          last = new SignerUnavailableError(`The signer did not answer (${controller.signal.aborted ? 'timeout' : e instanceof Error ? e.message : 'network error'})`)
          continue
        } finally {
          clearTimeout(timer)
        }
        if (!checkResponse(o.authKey, headers['x-nearkit-nonce'], res.status, out, res.headers.get('x-nearkit-signature'))) {
          last = new SignerUnavailableError(res.status === 401 ? 'The signer refused NearKit’s credentials' : 'An answer that is not the signer’s own was refused')
          continue
        }
        let json: unknown
        try {
          json = JSON.parse(out) as unknown
        } catch {
          throw new SignerUnavailableError('The signer answered something unreadable')
        }
        if (res.ok) return json
        const err = (json as { error?: { code?: unknown; message?: unknown; detail?: unknown } }).error
        throw errorFromWire(String(err?.code ?? 'internal'), String(err?.message ?? 'The signer refused'), typeof err?.detail === 'string' ? err.detail : undefined)
      }
      throw last
    },
  }
}
