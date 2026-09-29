import { randomBytes } from 'node:crypto'
import { NETWORKS, type NetworkConfig } from '@/config/networks'
import { base58Encode, base64Decode, base64Encode } from '@/lib/encoding'
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

/** The whole web export, as the owner's browser runs it: its own key, the owner's signature, then opening what the signer sealed. */
export async function exportAsOwner(
  run: {
    challenge: (req: { kind: 'export'; accountId: string; recipientKey: string }) => Promise<ChallengeView>
    exportKey: (p: { challengeId: string; publicKey: string; signature: string }) => Promise<{ sealed: unknown }>
  },
  accountId: string,
  owner: { pair: CryptoKeyPair; publicKey: string },
  network = 'testnet',
): Promise<string> {
  const browser = await createExportKeyPair()
  const c = await run.challenge({ kind: 'export', accountId, recipientKey: browser.publicKey })
  const r = await run.exportKey({ challengeId: c.id, publicKey: owner.publicKey, signature: await ownerSign(c, owner.pair) })
  return openExport(browser.privateKey, r.sealed as Parameters<typeof openExport>[1], { challengeId: c.id, network, accountId })
}
