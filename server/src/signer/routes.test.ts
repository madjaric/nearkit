import { describe, expect, it } from 'vitest'
import { NETWORKS, type NetworkConfig } from '@/config/networks'
import { base58Encode } from '@/lib/encoding'
import { NEARKIT_FEE_BPS, PRODUCTION_FEE_RECIPIENT } from '@/lib/fees'
import { checkPlan, PolicyViolation, type SwapRouteFacts, type WalletOperation, type WalletTxPlan } from '../custody/policy'
import { verifySwapRoute, type RouteOracle } from './routes'

/**
 * Mainnet swaps through Rhea's aggregator, as the signer checks them without trusting
 * the app: Rhea's signature, NearKit's fee (rate and the one production account), the
 * wallet as the only user and receiver, and a minimum close to the signer's own quote.
 * Routes here are built and signed like Rhea's (a test key stands in for Rhea's).
 */

const WALLET = 'a'.repeat(64)
const USDT = 'usdt.tether-token.near'
const WRAP = 'wrap.near'
const AMOUNT = 5_000_000n
const MIN = 1_000_000_000_000_000_000_000_000n

async function rhea() {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const publicKey = `ed25519:${base58Encode(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))}`
  const agg = NETWORKS.mainnet.rhea.aggregator as NonNullable<NetworkConfig['rhea']['aggregator']>
  const network: NetworkConfig = { ...NETWORKS.mainnet, rhea: { ...NETWORKS.mainnet.rhea, aggregator: { ...agg, signerKey: publicKey } } }
  /** A route as Rhea's quote server returns it: obfuscated JSON (+7 per byte, base64) and an ed25519 signature. */
  async function route(over: Record<string, unknown> = {}, signWith = pair): Promise<SwapRouteFacts> {
    const decoded = {
      user: WALLET,
      receive_user: WALLET,
      contracts: [USDT],
      methods: ['ft_transfer_call'],
      msgs: [
        JSON.stringify({
          receiver_id: 'v2.ref-finance.near',
          amount: AMOUNT.toString(),
          msg: JSON.stringify({ actions: [{ pool_id: 1, token_in: USDT, token_out: WRAP, amount_in: AMOUNT.toString(), min_amount_out: MIN.toString() }] }),
        }),
      ],
      near_amounts: ['1'],
      skip_unwrap_near: false,
      app_fee_rate: NEARKIT_FEE_BPS * 100,
      app_fee_recipient: PRODUCTION_FEE_RECIPIENT,
      deadline: Date.now() + 120_000,
      ...over,
    }
    const bytes = new TextEncoder().encode(JSON.stringify(decoded)).map((b) => (b + 7) & 0xff)
    const msg = btoa(String.fromCharCode(...bytes))
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg)))
    const hex = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, signWith.privateKey, new TextEncoder().encode(hex)))
    const signature = [...sig].map((b) => b.toString(16).padStart(2, '0')).join('')
    return {
      router: 'aggregator',
      routeIn: USDT,
      routeOut: WRAP,
      nativeIn: false,
      nativeOut: true,
      amountIn: AMOUNT,
      receiver: agg.contract,
      msg: JSON.stringify({ msg, signature }),
      routeTokens: [USDT, WRAP],
      minOut: MIN,
      signedMin: MIN,
    }
  }
  return { network, agg, route, pair }
}

const oracle = (out: bigint | Error): RouteOracle => ({
  expectedOut: async () => {
    if (out instanceof Error) throw out
    return out
  },
})

const policy = (network: NetworkConfig, expected: bigint | Error, feeRecipient: string | null = PRODUCTION_FEE_RECIPIENT) => ({
  network,
  feeRecipient,
  maxSlippagePpm: 50_000,
  oracle: oracle(expected),
  now: () => Date.now(),
})

describe('mainnet swap routes, checked by the signer itself', () => {
  it('accepts Rhea’s signed route with NearKit’s fee to the production account', async () => {
    const r = await rhea()
    const checked = await verifySwapRoute(await r.route(), WALLET, policy(r.network, (MIN * 1005n) / 1000n))
    expect(checked.routeTokens).toEqual([USDT, WRAP])
  })

  it('refuses a fee to any other account (a test account included), another fee rate, or no fee', async () => {
    const r = await rhea()
    const p = policy(r.network, MIN)
    await expect(verifySwapRoute(await r.route({ app_fee_recipient: 'testone.near' }), WALLET, p)).rejects.toThrow(/fee goes to another account/)
    await expect(verifySwapRoute(await r.route({ app_fee_rate: 2000 }), WALLET, p)).rejects.toThrow(/fee rate differs/)
    await expect(verifySwapRoute(await r.route({ app_fee_rate: 0, app_fee_recipient: null }), WALLET, p)).rejects.toThrow(/fee rate differs/)
    // A signer configured with any other account refuses too (it doesn't trust the app for this).
    await expect(verifySwapRoute(await r.route(), WALLET, policy(r.network, MIN, 'testone.near'))).rejects.toThrow(/fee goes to another account/)
    await expect(verifySwapRoute(await r.route(), WALLET, policy(r.network, MIN, null))).rejects.toThrow(/no NearKit fee account/)
  })

  it('refuses a route for another user or paying out to someone else', async () => {
    const r = await rhea()
    const p = policy(r.network, MIN)
    await expect(verifySwapRoute(await r.route({ user: 'b'.repeat(64) }), WALLET, p)).rejects.toThrow(/signed for another account/)
    await expect(verifySwapRoute(await r.route({ receive_user: 'mallory.near' }), WALLET, p)).rejects.toThrow(/sends the output to another account/)
  })

  it('refuses a route not signed by Rhea’s key, or altered after signing', async () => {
    const r = await rhea()
    const p = policy(r.network, MIN)
    const other = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
    await expect(verifySwapRoute(await r.route({}, other), WALLET, p)).rejects.toThrow(/signature/)
    const good = await r.route()
    const parts = JSON.parse(good.msg) as { msg: string; signature: string }
    const tampered = { ...good, msg: JSON.stringify({ msg: parts.msg.slice(0, -4) + 'AAAA', signature: parts.signature }) }
    await expect(verifySwapRoute(tampered, WALLET, p)).rejects.toThrow(PolicyViolation)
  })

  it('refuses a minimum far below the signer’s own quote from Rhea (a compromised app can’t sell the user out)', async () => {
    const r = await rhea()
    // The signer's quote says 2x the route's minimum: more than its 5% cap below.
    await expect(verifySwapRoute(await r.route(), WALLET, policy(r.network, MIN * 2n))).rejects.toThrow(/slippage/)
  })

  it('fails closed when it can’t ask Rhea itself', async () => {
    const r = await rhea()
    await expect(verifySwapRoute(await r.route(), WALLET, policy(r.network, new Error('timeout')))).rejects.toThrow(/could not check the price/)
  })

  it('refuses Rhea’s classic exchange on mainnet (no fee there), and the aggregator on testnet', async () => {
    const r = await rhea()
    const classic = { ...(await r.route()), router: 'classic' as const }
    await expect(verifySwapRoute(classic, WALLET, policy(r.network, MIN))).rejects.toThrow(/aggregator/)
    await expect(verifySwapRoute(await r.route(), WALLET, policy(NETWORKS.testnet, MIN, null))).rejects.toThrow(/classic/)
  })
})

describe('mainnet swap plans (structure)', () => {
  const op = (route: SwapRouteFacts): WalletOperation => ({ kind: 'swap', route, authorizedMinOut: route.minOut })
  const reg = (contract: string, account: string): WalletTxPlan => ({
    receiverId: contract,
    actions: [
      { kind: 'call', method: 'storage_deposit', args: { account_id: account, registration_only: true }, gas: (10n ** 13n).toString(), deposit: (125n * 10n ** 19n).toString() },
    ],
    label: 'r',
  })
  const rheaReg = (entries: { user: string; tokens: string[] }[], per = 5n * 10n ** 21n): WalletTxPlan => ({
    receiverId: 'aggregatedex.near',
    actions: entries.map((e) => ({
      kind: 'call',
      method: 'tokens_storage_deposit',
      args: e,
      gas: (30n * 10n ** 12n).toString(),
      deposit: (per * BigInt(e.tokens.length)).toString(),
    })),
    label: 'rhea',
  })
  const swap = (route: SwapRouteFacts, receiver = 'aggregatedex.near'): WalletTxPlan => ({
    receiverId: route.routeIn,
    actions: [
      {
        kind: 'call',
        method: 'ft_transfer_call',
        args: { receiver_id: receiver, amount: route.amountIn.toString(), msg: route.msg },
        gas: (300n * 10n ** 12n).toString(),
        deposit: '1',
      },
    ],
    label: 's',
  })
  const wallet = { accountId: WALLET, publicKey: 'ed25519:K', network: 'mainnet' }

  it('allows exactly: registrations of the wallet and the aggregator, Rhea registrations of the wallet and NearKit’s fee account, the swap', async () => {
    const r = await rhea()
    const route = await r.route()
    const plan = [
      reg(WRAP, WALLET),
      reg(WRAP, 'aggregatedex.near'),
      rheaReg([
        { user: WALLET, tokens: [WRAP] },
        { user: PRODUCTION_FEE_RECIPIENT, tokens: [WRAP] },
      ]),
      swap(route),
    ]
    expect(() => checkPlan(op(route), plan, wallet, r.network, PRODUCTION_FEE_RECIPIENT)).not.toThrow()
  })

  it('refuses a Rhea registration for someone else, of tokens outside the route, or at the wrong price; and a swap to another contract', async () => {
    const r = await rhea()
    const route = await r.route()
    const check = (plan: WalletTxPlan[]) => () => checkPlan(op(route), plan, wallet, r.network, PRODUCTION_FEE_RECIPIENT)
    expect(check([rheaReg([{ user: 'mallory.near', tokens: [WRAP] }]), swap(route)])).toThrow(/unexpected account/)
    expect(check([rheaReg([{ user: WALLET, tokens: ['scam.near'] }]), swap(route)])).toThrow(/outside the route/)
    expect(check([rheaReg([{ user: WALLET, tokens: [WRAP] }], 6n * 10n ** 21n), swap(route)])).toThrow(/unexpected deposit/)
    expect(check([reg(WRAP, 'mallory.near'), swap(route)])).toThrow(/unexpected account/)
    expect(check([swap(route, 'mallory.near')])).toThrow(PolicyViolation)
    expect(() => checkPlan(op(route), [swap(route)], wallet, r.network, null)).toThrow(/no NearKit fee account/)
  })
})
