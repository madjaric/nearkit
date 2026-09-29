import { botModules } from '../app'
import type { TradingWallet } from '../custody/store'
import type { Logger } from '../log'
import type { Command } from './context'
import { tradingWallet } from './tradingWallet'
import { ALICE, botHarness } from './testing'

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

export async function walletBot(options: { link?: boolean; linkedKey?: string; extraKeys?: Record<string, 'full' | 'function-call'>; log?: Logger } = {}) {
  const linkedKey = options.linkedKey ?? LINKED_KEY
  /** USDT (6 decimals) per NEAR, times 1e6: 4_000_000 = 4 USDT. */
  const market = { usdtPerNear: 4_000_000n, noRoute: false }
  const rate = (tokenIn: string, tokenOut: string, amount: bigint) =>
    tokenIn === WRAP && tokenOut === USDT ? (amount * market.usdtPerNear) / ONE : tokenIn === USDT && tokenOut === WRAP ? (amount * ONE) / market.usdtPerNear : 0n
  let list: () => { name: string; command: Command }[] = () => []
  const h = await botHarness({
    custody: true,
    log: options.log,
    chain: {
      accounts: {
        [LINKED]: { amount: 5n * ONE, keys: { [linkedKey]: 'full', ...options.extraKeys } },
        'bob.testnet': { amount: ONE },
        [USDT]: { amount: ONE, code: true },
        [WRAP]: { amount: ONE, code: true },
        [EXCHANGE]: { amount: 1000n * ONE, code: true },
      },
      tokens: {
        [USDT]: { symbol: 'USDT', name: 'Tether USD', decimals: 6, boundsMin: REG, balances: { [EXCHANGE]: 10n ** 15n, [LINKED]: 50_000_000n }, registered: [EXCHANGE, LINKED] },
        [WRAP]: { symbol: 'wNEAR', name: 'Wrapped NEAR', decimals: 24, boundsMin: REG, balances: { [EXCHANGE]: 1000n * ONE }, registered: [EXCHANGE] },
      },
      exchange: { contract: EXCHANGE, rate },
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
    /** The data of the button whose label contains `label`. */
    button: (label: string) => h.buttons().find((b) => b.text.includes(label))?.data ?? '',
  }
}
