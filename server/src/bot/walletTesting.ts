import type { FakeChainOptions } from '@/services/real/testing/fakeChain'
import { recoveryRoutes } from '../api/recoveryRoutes'
import { telegramRoutes } from '../api/telegramRoutes'
import { botModules } from '../app'
import type { TradingWallet } from '../custody/store'
import { EXPORT_HOLD_MS, type ChallengeView } from '../signer/core'
import { exportAsOwner, ownerSign } from '../signer/testing'
import type { Logger } from '../log'
import type { Command } from './context'
import { exportCancelledText, exportedText, exportRequestedNotice, telegramApprovedText } from './recovery'
import { tradingWallet } from './tradingWallet'
import { ALICE, botHarness } from './testing'
import type { TgUser } from '../telegram/types'

/**
 * A bot with NearKit wallets on, over the fake chain: Alice has a linked wallet,
 * USDT and wNEAR exist, and Rhea's classic exchange swaps at a rate the test can
 * change (4 USDT per NEAR to start; USDT has 6 decimals). Rhea's router answers
 * with routes at the same rate and a 0.5% minimum, like the real one.
 */

export const ONE = 10n ** 24n
export const USDT = 'usdt.itachicara.testnet'
export const WRAP = 'wrap.testnet'
export const EXCHANGE = 'ref-finance-101.testnet'
export const LINKED = 'alice.testnet'
/** The key Alice's own wallet signs with (full access on alice.testnet). */
export const LINKED_KEY = 'ed25519:Anu7LYDfpLtkP7E16LT9imXF694BdQaa9ufVkQiwTQxC'
export const REG = 1_250_000_000_000_000_000_000n
const FIND_PATH = 'https://smartroutertest.refburrow.top/findPath'

export async function walletBot(
  options: {
    link?: boolean
    linkedKey?: string
    extraKeys?: Record<string, 'full' | 'function-call'>
    log?: Logger
    remoteSigner?: boolean
    env?: Record<string, string>
    /** False: the signer checks no Mini App approvals. */
    telegramApprovals?: boolean
    /** More of the fake chain: accounts, tokens (outside every list) and a DCL exchange with pools. */
    chain?: Pick<FakeChainOptions, 'accounts' | 'tokens' | 'dcl'>
  } = {},
) {
  const linkedKey = options.linkedKey ?? LINKED_KEY
  /** USDT (6 decimals) per NEAR, times 1e6: 4_000_000 = 4 USDT. */
  const market = { usdtPerNear: 4_000_000n, noRoute: false }
  const rate = (tokenIn: string, tokenOut: string, amount: bigint) =>
    tokenIn === WRAP && tokenOut === USDT ? (amount * market.usdtPerNear) / ONE : tokenIn === USDT && tokenOut === WRAP ? (amount * ONE) / market.usdtPerNear : 0n
  let list: () => { name: string; command: Command }[] = () => []
  const h = await botHarness({
    custody: true,
    remoteSigner: options.remoteSigner,
    telegramApprovals: options.telegramApprovals,
    env: options.env,
    log: options.log,
    chain: {
      accounts: {
        [LINKED]: { amount: 5n * ONE, keys: { [linkedKey]: 'full', ...options.extraKeys } },
        'bob.testnet': { amount: ONE },
        [USDT]: { amount: ONE, code: true },
        [WRAP]: { amount: ONE, code: true },
        // The network's other known tokens: the signer reads each one itself before it erases a key.
        'usdc.itachicara.testnet': { amount: ONE, code: true },
        'ref.fakes.testnet': { amount: ONE, code: true },
        [EXCHANGE]: { amount: 1000n * ONE, code: true },
        ...options.chain?.accounts,
      },
      tokens: {
        [USDT]: { symbol: 'USDT', name: 'Tether USD', decimals: 6, boundsMin: REG, balances: { [EXCHANGE]: 10n ** 15n, [LINKED]: 50_000_000n }, registered: [EXCHANGE, LINKED] },
        [WRAP]: { symbol: 'wNEAR', name: 'Wrapped NEAR', decimals: 24, boundsMin: REG, balances: { [EXCHANGE]: 1000n * ONE }, registered: [EXCHANGE] },
        'usdc.itachicara.testnet': { symbol: 'USDC', name: 'USD Coin', decimals: 6, boundsMin: REG, balances: {}, registered: [] },
        'ref.fakes.testnet': { symbol: 'REF', name: 'Ref Finance Token', decimals: 18, boundsMin: REG, balances: {}, registered: [] },
        ...options.chain?.tokens,
      },
      exchange: { contract: EXCHANGE, rate },
      ...(options.chain?.dcl ? { dcl: options.chain.dcl } : {}),
    },
    modules: (deps) => botModules(deps, () => list()),
  })
  list = () => h.app.commands()
  h.chain.route(FIND_PATH, (url) => {
    const amountIn = BigInt(url.searchParams.get('amountIn') ?? '0')
    const tokenIn = url.searchParams.get('tokenIn') ?? ''
    const tokenOut = url.searchParams.get('tokenOut') ?? ''
    const out = rate(tokenIn, tokenOut, amountIn)
    if (market.noRoute || out === 0n) return { result_code: 1, result_message: 'no path', result_data: null }
    const min = (out * 995n) / 1000n
    return {
      result_code: 0,
      result_message: '',
      result_data: {
        routes: [
          {
            pools: [{ pool_id: '1352', token_in: tokenIn, token_out: tokenOut, amount_in: String(amountIn), amount_out: '0', min_amount_out: String(min) }],
            amount_in: String(amountIn),
          },
        ],
        amount_in: String(amountIn),
        amount_out: String(out),
      },
    }
  })
  if (options.link !== false) {
    await h.store.upsertUser({ userId: ALICE.id, username: 'alice', firstName: 'Alice', languageCode: null })
    await h.store.createLinkRequest({ codeHash: 'h', userId: ALICE.id, network: 'testnet', nonce: 'n', message: 'm', ttlMs: 60_000 })
    await h.store.completeLink({ codeHash: 'h', network: 'testnet', accountId: LINKED, userId: ALICE.id, publicKey: linkedKey })
    await h.store.updateSettings(ALICE.id, { defaultAccount: LINKED })
  }
  const custody = h.deps.custody as NonNullable<typeof h.deps.custody>
  /**
   * NearKit web's recovery API, wired as the app wires it: the wallet's Telegram account is told
   * through this bot, so an export's notice (Release it now, Cancel) lands in the chat.
   */
  const recoveryApi = (notices: unknown[] = []) =>
    recoveryRoutes({
      recovery: custody.recovery,
      onExportRequested: async (r) => {
        notices.push({ kind: 'export-requested', userId: r.userId, accountId: r.accountId, owner: r.ownerAccount, browserKey: r.browserKey })
        const n = exportRequestedNotice(r, custody.telegram.link(r))
        return h.app.notify(r.userId, n.text, n.markup)
      },
      onExported: async (r) => {
        notices.push({ kind: 'exported', userId: r.userId, accountId: r.accountId, owner: r.ownerAccount, released: r.released })
        await h.app.notify(r.userId, exportedText(r))
      },
      onExportCancelled: async (r) => {
        notices.push({ kind: 'export-cancelled', userId: r.userId, accountId: r.accountId })
        await h.app.notify(r.userId, exportCancelledText(r))
      },
      onDestinationApproved: async (r) => void notices.push(r),
    })
  const tgRoutes = telegramRoutes({
    approvals: custody.telegram,
    onApproved: async (r) => {
      const n = telegramApprovedText(r)
      await h.app.notify(r.userId, n.text, n.markup)
    },
  })
  return {
    ...h,
    market,
    custody,
    /** The NearKit wallet Alice trades from (the selected one). */
    wallet: (): Promise<TradingWallet | null> => tradingWallet(h.deps, ALICE.id),
    /** Alice's NearKit wallet, created through the bot if she has none, funded from outside. */
    async funded(near = 3n * ONE, usdt = 0n) {
      if (!(await tradingWallet(h.deps, ALICE.id))) await h.press('cw:create')
      const w = (await tradingWallet(h.deps, ALICE.id)) as TradingWallet
      h.chain.fund(w.accountId, near)
      if (usdt > 0n) {
        const t = h.chain.tokens.get(USDT)
        t?.balances.set(w.accountId, usdt)
        t?.registered.add(w.accountId)
      }
      return w
    },
    /** `user` links `accountId` (its key `publicKey`) in NearKit web, and makes it their default account. */
    async link(accountId: string, publicKey: string, user: TgUser = ALICE) {
      const code = `link-${accountId}-${user.id}`
      await h.store.createLinkRequest({ codeHash: code, userId: user.id, network: 'testnet', nonce: 'n', message: 'm', ttlMs: 60_000 })
      await h.store.completeLink({ codeHash: code, network: 'testnet', accountId, userId: user.id, publicKey })
      await h.store.updateSettings(user.id, { defaultAccount: accountId })
    },
    /**
     * `user` opens the Mini App link the bot showed last (\u2705 Approve in Telegram) and taps
     * Approve: Telegram signs the launch, the page sends it to NearKit's API.
     */
    async approveInTelegram(user: TgUser = ALICE) {
      const url = [...h.fake.messages()]
        .reverse()
        .flatMap((m) => m.buttons ?? [])
        .map((b) => b.url ?? '')
        .find((u) => u.includes('startapp='))
      const digest = url ? new URL(url).searchParams.get('startapp') : null
      if (!digest) throw new Error('no Mini App link was shown')
      const initData = await h.telegram.launch({ userId: user.id, startParam: digest, authDate: Math.floor(h.deps.now() / 1000) })
      return tgRoutes['/api/telegram/approve']?.({ initData }, {} as never)
    },
    /** The data of the button whose label contains `label`. */
    button: (label: string) => h.buttons().find((b) => b.text.includes(label))?.data ?? '',
    recoveryApi,
    /**
     * The whole key export through NearKit web's API, as the owner's browser runs it: the owner signs
     * (the export is held and announced in Telegram), it is released (its hold runs out, or Alice
     * taps Release it now in the Mini App), then collected and opened in the browser.
     */
    async exportViaWeb(wallet: string, owner: { pair: CryptoKeyPair; publicKey: string }, release: 'hold' | 'telegram' = 'hold') {
      const routes = recoveryApi()
      const call = async <T>(path: string, body: unknown) => (await routes[path]?.(body, {} as never)) as T
      return exportAsOwner(
        {
          challenge: (req) => call<ChallengeView>('/api/recovery/challenge', req),
          requestExport: (p) => call<{ exportId: string; releaseAt: number }>('/api/recovery/export', p),
          release: async (held) => {
            if (release === 'telegram') await this.approveInTelegram()
            else h.advance(held.releaseAt - h.deps.now())
          },
          collect: (exportId) => call<{ sealed: unknown }>('/api/recovery/export/collect', { exportId }),
        },
        wallet,
        owner,
      )
    },
    /** How long an export is held. */
    exportHoldMs: EXPORT_HOLD_MS,
    /** The owner approves `destination` for the NearKit wallet `wallet` in NearKit web: it signs the signer's message. */
    async approve(wallet: string, destination: string, owner: { pair: CryptoKeyPair; publicKey: string }) {
      const routes = recoveryApi()
      const c = (await routes['/api/recovery/challenge']?.({ kind: 'approve-destination', accountId: wallet, destination }, {} as never)) as ChallengeView
      return routes['/api/recovery/destination']?.({ challengeId: c.id, publicKey: owner.publicKey, signature: await ownerSign(c, owner.pair) }, {} as never)
    },
  }
}
