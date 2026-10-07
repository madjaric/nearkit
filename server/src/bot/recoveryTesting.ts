import { expect } from 'vitest'
import { base58Encode } from '@/lib/encoding'
import type { SealedExport } from '@/lib/exportCrypto'
import { RecoveryApiError } from '../custody/recovery'
import type { ChallengeView } from '../signer/core'
import { walletBot } from './walletTesting'

/** What the recovery tests share: Alice's bot with her linked wallet, and NEARKITS web's recovery API over it. */

export type Harness = Awaited<ReturnType<typeof walletBot>>

export async function keypair() {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  return { pair, publicKey: `ed25519:${base58Encode(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))}` }
}

/** Alice's bot: her linked wallet's key, and a function-call key of hers that must never count as the owner's. */
export async function setup() {
  const linked = await keypair()
  const app = await keypair()
  const h = await walletBot({ linkedKey: linked.publicKey, extraKeys: { [app.publicKey]: 'function-call' } })
  return { h, linked, app }
}

/** Telegram's Export button: a link to the web recovery page for this wallet. It holds no secret. */
export async function exportLink(h: Harness) {
  await h.press('cr:export')
  const url = h.buttons().find((b) => b.url)?.url ?? ''
  expect(url).toMatch(/^https:\/\/nearkits\.com\/recover#wallet=[0-9a-f]{64}$/)
  return url.split('#wallet=')[1] as string
}

type Routes = ReturnType<Harness['recoveryApi']>
const call = async <T>(routes: Routes, path: string, body: unknown): Promise<T> => (await (routes[path] as NonNullable<Routes[string]>)(body, {} as never)) as T

/** A held export as the browser sees it. */
export interface WebExport {
  exportId: string
  accountId: string
  ownerAccount: string
  browserKey: string
  status: string
  releaseAt: number
  expiresAt: number
}

export function webApi(h: Harness, notices: unknown[] = []) {
  const routes = h.recoveryApi(notices)
  return {
    routes,
    challenge: (body: Record<string, unknown>) => call<ChallengeView>(routes, '/api/recovery/challenge', body),
    requestExport: (body: Record<string, unknown>) => call<WebExport>(routes, '/api/recovery/export', body),
    status: (exportId: string) => call<WebExport>(routes, '/api/recovery/export/status', { exportId }),
    collect: (exportId: string) =>
      call<{ exportId: string; accountId: string; publicKey: string; sealed: SealedExport; released: 'hold' | 'telegram' }>(routes, '/api/recovery/export/collect', { exportId }),
    cancel: (exportId: string) => call<WebExport>(routes, '/api/recovery/export/cancel', { exportId }),
    wallets: (body: Record<string, unknown>) => call<{ ownerAccount: string; wallets: { accountId: string; name: string }[] }>(routes, '/api/recovery/wallets', body),
  }
}

/** The HTTP status of a refusal, or null when it went through. */
export const status = (p: Promise<unknown>) => p.then(() => null).catch((e: unknown) => (e instanceof RecoveryApiError ? e.status : e))
