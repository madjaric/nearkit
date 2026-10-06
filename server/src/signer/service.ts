import { existsSync, readFileSync } from 'node:fs'
import { listen } from '../api/http'
import { keyring, localKeyWrapper, type KeyWrapper } from '../custody/vault'
import { databaseSecrets, describeDatabase, openDatabase } from '../db/open'
import { createLogger, type Logger } from '../log'
import { checkChainIds } from '../chainId'
import { createSignerChain } from './chain'
import { loadSignerConfig, type SignerServiceConfig } from './config'
import { createSignerCore } from './core'
import { createSignerServer } from './http'
import { awsKmsApi, kmsKeyWrapper, probeKek, type KmsApi } from './kms'
import { openBaoTransitApi } from './openbao'
import { ensureSignerTls } from './tls'
import { createRouteOracle } from './routes'
import { migrateSigner } from './schema'
import { SignerStore } from './store'
import type { TelegramCheck } from './telegram'

/**
 * The signer as a running service: its database (migrated), its KEKs (KMS or, on
 * testnet, the environment), its checks against NEAR and Rhea, and the core. The HTTP
 * entry point (main.ts) and the operator's command line (admin.ts) both build it here.
 */

export interface SignerDepsOverrides {
  fetch?: typeof fetch
  now?: () => number
  log?: Logger
  /** How to reach a KMS key (tests pass a stand-in; production uses AWS). */
  kmsApi?: (arn: string) => Promise<KmsApi>
  /** Telegram's key and the bot, instead of the configured ones (tests pass a stand-in for Telegram's key). */
  telegram?: TelegramCheck | null
}

/** Every secret the signer's logger must never print. */
export function signerSecrets(env: Record<string, string | undefined>, config: SignerServiceConfig | null): string[] {
  const kek = [env.NEARKIT_SIGNER_KEK, ...(env.NEARKIT_SIGNER_KEK_PREVIOUS ?? '').split(',')].map((s) => s?.trim())
  // On a host outside AWS the KMS is reached with an access key: its secret half is a secret like any other.
  const aws = [env.AWS_SECRET_ACCESS_KEY?.trim(), env.AWS_SESSION_TOKEN?.trim()]
  const openbao = [env.NEARKIT_OPENBAO_TOKEN?.trim()]
  return [env.NEARKIT_SIGNER_AUTH_KEY?.trim(), ...kek, ...aws, ...openbao, ...(config ? databaseSecrets(config.database) : [])].filter((s): s is string => Boolean(s))
}

export async function buildSigner(config: SignerServiceConfig, o: SignerDepsOverrides = {}) {
  const now = o.now ?? Date.now
  const log = o.log ?? createLogger({ level: config.logLevel })
  const db = await openDatabase(config.database)
  await migrateSigner(db)
  const store = new SignerStore(db, now)
  let wrappers: KeyWrapper[]
  // OpenBao's periodic token is kept alive by the running service (startSignerService).
  let renewKmsToken: (() => Promise<number>) | null = null
  if (config.kek.kind === 'openbao') {
    const { addr, mount, key, token, tlsPin } = config.kek
    const api = openBaoTransitApi({ addr, mount, key, token, tlsPin })
    renewKmsToken = () => api.renewToken()
    wrappers = [kmsKeyWrapper(api)]
  } else if (config.kek.kind === 'kms') {
    const reach = o.kmsApi ?? awsKmsApi
    wrappers = await Promise.all([config.kek.current, ...config.kek.previous].map(async (arn) => kmsKeyWrapper(await reach(arn))))
  } else {
    wrappers = [config.kek.current, ...config.kek.previous].map((k) => localKeyWrapper(k))
  }
  const keys = keyring(wrappers[0] as KeyWrapper, wrappers.slice(1))
  const pause = config.pause
  const core = createSignerCore({
    store,
    keys,
    chain: createSignerChain({ rpcUrls: config.rpc.urls, quorum: config.rpc.quorum, fetch: o.fetch }),
    oracle: createRouteOracle(config.network, o.fetch),
    config: {
      network: config.network,
      feeRecipient: config.feeRecipient,
      recipient: config.recipient,
      maxSlippagePpm: config.maxSlippagePpm,
      telegram: o.telegram !== undefined ? o.telegram : config.telegram,
      // The host's own switches, read on every request: an env flag, or a file an operator creates.
      pausedByHost: () => pause.byEnv || (pause.file !== null && existsSync(pause.file)),
    },
    now,
    log,
  })
  return { db, store, keys, core, log, renewKmsToken }
}

export async function startSignerService(o: SignerDepsOverrides & { env: Record<string, string | undefined> }) {
  const { config, issues } = loadSignerConfig(o.env)
  const log = o.log ?? createLogger({ level: config?.logLevel ?? 'info', secrets: signerSecrets(o.env, config) })
  if (!config) {
    for (const i of issues) log.error('signer configuration problem', { key: i.key, problem: i.message })
    throw new Error(`Signer configuration has ${issues.length} problem(s); see the log above`)
  }
  const rpcCheck = await checkChainIds(config.rpc.urls, config.network.id, o.fetch)
  if (rpcCheck.unreachable.length) log.warn('some RPC providers did not answer at start', { urls: rpcCheck.unreachable })
  const s = await buildSigner(config, { ...o, log })
  const kek = await probeKek(s.keys.current)
  if (kek === 'ok') log.info('signer key-encryption key ready', { keyRef: s.keys.current.ref })
  // Fails closed either way: without the KEK nothing opens. The service still answers health.
  else log.error('signer key-encryption key unavailable', { keyRef: s.keys.current.ref, problem: kek })
  // OpenBao's periodic token lives while it is renewed: now, then twice a day.
  let renewal: ReturnType<typeof setInterval> | null = null
  const renewKmsToken = s.renewKmsToken
  if (renewKmsToken) {
    const renew = async () => {
      try {
        log.info('OpenBao token renewed', { hours: Math.round((await renewKmsToken()) / 3600) })
      } catch (e) {
        log.warn('OpenBao token renewal failed; wallet keys open while the token lasts', { error: e })
      }
    }
    await renew()
    renewal = setInterval(() => void renew(), 12 * 3_600_000)
    renewal.unref()
  }
  let tls: { cert: Buffer; key: Buffer } | null = null
  const listenTls = config.listen.tls
  if (listenTls && 'dir' in listenTls) {
    const own = ensureSignerTls(listenTls.dir)
    // Public: the app pins this certificate (NEARKIT_SIGNER_TLS_PIN). The key never leaves this disk.
    log.info('signer TLS certificate', { created: own.created, fingerprint256: own.fingerprint256, pin: own.pin })
    tls = { cert: Buffer.from(own.certPem), key: Buffer.from(own.keyPem) }
  } else if (listenTls) tls = { cert: readFileSync(listenTls.certPath), key: readFileSync(listenTls.keyPath) }
  const server = createSignerServer({ core: s.core, store: s.store, authKey: config.authKey, log, now: o.now, tls })
  const port = await listen(server, config.listen.port, config.listen.host)
  log.info('NEARKITS signer listening', {
    network: config.network.id,
    url: `${tls ? 'https' : 'http'}://${config.listen.host}:${port}`,
    db: describeDatabase(config.database),
    rpc: config.rpc.urls.length,
    quorum: config.rpc.quorum,
    paused: await s.core.paused(),
  })
  const prune = setInterval(() => void s.store.prune().catch((e: unknown) => log.warn('signer prune failed', { error: e })), 60_000)
  prune.unref()
  return {
    port,
    core: s.core,
    store: s.store,
    async stop() {
      clearInterval(prune)
      if (renewal) clearInterval(renewal)
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await s.db.close()
      log.info('NEARKITS signer stopped')
    },
  }
}
