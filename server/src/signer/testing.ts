import { randomBytes } from 'node:crypto'
import { NETWORKS, type NetworkConfig } from '@/config/networks'
import { base58Encode, base64Decode, base64Encode, base64UrlEncode, hexEncode } from '@/lib/encoding'
import { createExportKeyPair, openExport } from '@/lib/exportCrypto'
import { MAX_SLIPPAGE } from '@/lib/fees'
import { nep413Digest } from '@/services/near/nep413'
import { createSignerClient, inProcessTransport, type TradingSigner } from '../custody/signer'
import { keyring, localKeyWrapper } from '../custody/vault'
import type { Database } from '../db/database'
import { createSignerChain, type SignerChain } from './chain'
import { createSignerCore, type ChallengeView, type SignerConfig } from './core'
import { createRouteOracle, type RouteOracle } from './routes'
import { migrateSigner } from './schema'
import { SignerStore } from './store'
import type { TelegramCheck } from './telegram'

/** A syntactically valid owner key, for tests that never need the owner to sign. */
export const TEST_OWNER_KEY = 'ed25519:Anu7LYDfpLtkP7E16LT9imXF694BdQaa9ufVkQiwTQxC'

/** The signer as testnet runs it: in this process, on this database, with a random KEK. */
export async function testSigner(
  db: Database,
  o: { network?: NetworkConfig; kek?: Buffer; fetch?: typeof fetch; now?: () => number; chain?: SignerChain; oracle?: RouteOracle; config?: Partial<SignerConfig> } = {},
) {
  await migrateSigner(db)
  const now = o.now ?? Date.now
  const network = o.network ?? NETWORKS.testnet
  const kek = o.kek ?? randomBytes(32)
  const store = new SignerStore(db, now)
  const core = createSignerCore({
    store,
    keys: keyring(localKeyWrapper(kek)),
    chain: o.chain ?? createSignerChain({ rpcUrls: ['https://rpc.test'], quorum: 1, fetch: o.fetch }),
    oracle: o.oracle ?? createRouteOracle(network, o.fetch),
    config: { network, feeRecipient: null, recipient: 'nearkit.vercel.app', maxSlippagePpm: MAX_SLIPPAGE * 10_000, ...o.config },
    now,
  })
  const signer: TradingSigner = createSignerClient(inProcessTransport(core))
  return { core, store, kek, signer }
}

/** An owner wallet with a real ed25519 key (WebCrypto), as the tests' user holds it. */
export async function ownerKeypair() {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  return { pair, publicKey: `ed25519:${base58Encode(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))}` }
}

/** What the owner's wallet does with a signer challenge: a NEP-413 signature of exactly its message. */
export async function ownerSign(c: Pick<ChallengeView, 'message' | 'nonce' | 'recipient'>, key: CryptoKeyPair): Promise<string> {
  const digest = await nep413Digest({ message: c.message, nonce: base64Decode(c.nonce) as Uint8Array, recipient: c.recipient })
  return base64Encode(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key.privateKey, digest)))
}

/**
 * The whole web export, as the owner's browser runs it: its own key, the owner's signature (the
 * export is then held), `release` (its hold running out, or the wallet's Telegram account
 * releasing it sooner), then collecting it and opening what the signer sealed.
 */
export async function exportAsOwner<H extends { exportId: string }>(
  run: {
    challenge: (req: { kind: 'export'; accountId: string; recipientKey: string }) => Promise<ChallengeView>
    requestExport: (p: { challengeId: string; publicKey: string; signature: string }) => Promise<H>
    release: (held: H) => Promise<void> | void
    collect: (exportId: string) => Promise<{ sealed: unknown }>
  },
  accountId: string,
  owner: { pair: CryptoKeyPair; publicKey: string },
  network = 'testnet',
): Promise<string> {
  const browser = await createExportKeyPair()
  const c = await run.challenge({ kind: 'export', accountId, recipientKey: browser.publicKey })
  const held = await run.requestExport({ challengeId: c.id, publicKey: owner.publicKey, signature: await ownerSign(c, owner.pair) })
  await run.release(held)
  const r = await run.collect(held.exportId)
  return openExport(browser.privateKey, r.sealed as Parameters<typeof openExport>[1], { challengeId: c.id, network, accountId })
}

/**
 * Telegram as the tests' Mini App sees it: a stand-in for Telegram's Ed25519 key (the real one
 * is Telegram's), signing launch data for one bot exactly as Telegram's third-party validation
 * describes. `check` is what the signer is configured with.
 */
export async function telegramSigner(botId: number) {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const check: TelegramCheck = { botId, publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)) }
  return {
    check,
    /** The launch data Telegram hands NearKit's Mini App when `userId` opens it with `startapp=<startParam>`. */
    async launch(o: { userId: number; startParam: string; authDate: number; user?: Record<string, unknown> | null }): Promise<string> {
      const fields: Record<string, string> = {
        auth_date: String(o.authDate),
        chat_instance: '-4271234567890123456',
        chat_type: 'sender',
        ...(o.startParam ? { start_param: o.startParam } : {}),
        ...(o.user === null ? {} : { user: JSON.stringify(o.user ?? { id: o.userId, first_name: 'Alice', username: 'alice', language_code: 'en' }) }),
      }
      const lines = Object.keys(fields)
        .sort()
        .map((k) => `${k}=${fields[k]}`)
      const text = [`${botId}:WebAppData`, ...lines].join('\n')
      const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(text)))
      return new URLSearchParams({ ...fields, hash: hexEncode(randomBytes(32)), signature: base64UrlEncode(signature) }).toString()
    },
  }
}
